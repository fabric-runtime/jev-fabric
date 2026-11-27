// The native subprocess supervisor (native/posix.c, pipe.c and the effects of
// native/Process.bend). Every child gets its own POSIX process group with
// SIGPIPE, SIGINT and SIGTERM at their defaults, literal argv (no shell),
// a deadline that SIGKILLs the whole group (exit 124), and bounded output:
// the newest 32 KiB of each stream is kept, and with spools the first 1 MiB
// (or, rolling, the latest 1 MiB behind a published header) goes to files.
//
// Cancellation is this process's, not one child's, and it is sticky: SIGINT,
// SIGTERM or cancel() set one interrupt; every running child's group then
// gets SIGTERM and SIGKILL 500 ms later, reports 128 + the signal, and no
// later child starts (EINTR). On exit every live group is SIGKILLed and
// reaped. Call installSignalScope() first thing, as 0.8.1's constructor did.
//
// The loop waits on events instead of polling: SIGCHLD (listened for only
// while children run) for the child's exit, the event loop's readiness of
// each pipe (a Bun stream per reader) for output, and a timer for the
// deadline, the 500 ms grace and the drain. An idle child costs nothing but a
// waitpid backstop once a second, in case a SIGCHLD were ever lost. Only input
// that does not fit the stdin pipe is retried on a timer, from 1 ms doubling
// to 10 ms while the child is not reading, as posix.c paused.
// After the child exits its group is SIGKILLed and the pipes drain for
// 100 ms more; output still held by an escaped daemon is disclosed as cut.

import {closeSync, fstatSync, openSync, writeSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {onChildExit} from '../sys/exits.ts'
import * as L from '../sys/libc.ts'
import * as Time from '../time/time.ts'
import type {Raw, Report} from './report.ts'
import {CANCELLED, decode, STDERR_CUT, STDOUT_CUT, TIMED_OUT} from './report.ts'

export const TAIL = 32768
const ARGS = 64
const JOBS = 32
const ARG_BYTES = 4096
export const SPOOL_LIMIT = 1048576
const LIMIT_MAX = 16777220
const TEXT_INPUT_MAX = 131072
const BYTES_INPUT_MAX = 67108864
export const TIMEOUT_MAX_MS = 3600000
/** Only logged and rolling piped children, the job and session workers', accept a day. */
export const JOB_TIMEOUT_MAX_MS = 86400000
const TIMEOUT_EXIT = 124
const DRAIN_GRACE_MS = 100
// While input waits for room in the child's stdin pipe.
const POLL_MS = 10
const POLL_MIN_MS = 1
// A waitpid without a SIGCHLD, so a lost signal costs at most this.
const BACKSTOP_MS = 1000
const TERM_GRACE_MS = 500
// Output handled by one reader before it yields to the event loop, so a
// child flooding its pipe never holds up the others or a serve session's requests.
const TURN_BYTES = 65536
export const RING = 1048576
export const RING_HEAD = 16
const CWD_MAX = 4096

export const FAILED = 'native subprocess request failed'

// ---------------------------------------------------------------------------
// The process scope: one sticky interrupt and the groups it owns.

let interrupt = 0
let running = 0
let shuttingDown = false
const owned = new Set<number>()
let installed = false
// Every running supervisor's wake: an interrupt is acted on at once.
const scope = new Set<() => void>()
function interruptWith(signal: number) {
  interrupt = signal
  for (const wake of [...scope]) wake()
}

/** Whether this process has been interrupted (SIGINT, SIGTERM or cancel()). */
export const interrupted = (): boolean => interrupt !== 0

/**
 * Whether a child could start now: not interrupted, not exiting, and fewer
 * than 32 running. A supervisor that would refuse is how a job worker's own
 * launch failed, which a caller supervising jobs in process mirrors.
 */
export const launchable = (): boolean => interrupt === 0 && !shuttingDown && running < JOBS

/** SIGINT and SIGTERM only set the interrupt; exit SIGKILLs and reaps every owned group. */
export function installSignalScope(): void {
  if (installed) return
  installed = true
  process.on('SIGINT', () => interruptWith(L.SIGINT))
  process.on('SIGTERM', () => interruptWith(L.SIGTERM))
  process.on('exit', () => {
    shuttingDown = true
    const pids = [...owned]
    for (const pid of pids) L.kill(-pid, L.SIGKILL)
    for (const pid of pids) {
      try {
        L.waitpid(pid, true)
      } catch {}
    }
  })
}

/** Process.cancel: interrupt this executable's owned scope (sticky), never an arbitrary pid. */
export function cancel(): void {
  installSignalScope()
  interruptWith(L.SIGTERM)
}

// ---------------------------------------------------------------------------
// One supervised child.

export type Supervise = {
  argv: readonly string[]
  /** Written to a fresh stdin pipe, which is closed once it is all written. */
  input?: string | Uint8Array
  timeoutMs: number
  /** The largest timeout this form admits (an hour, or a day for workers). */
  timeoutMax?: number
  /** The child reads this process's own stdin. */
  inheritStdin?: boolean
  /** A pipe reader for the child's stdin, consumed (closed) in every case. */
  stdinFd?: number
  /** Bytes of each stream's tail kept (32 KiB). */
  limit?: number
  /** Spool writers for stdout and stderr, consumed; -1 for none. */
  logs?: [number, number]
  /** Spools keep the latest 1 MiB behind a header instead of the first 1 MiB. */
  rolling?: boolean
  /** An absolute directory to start in, or '' to inherit this process's. */
  cwd?: string
  /** Cancels this child alone, as the interrupt cancels every child. */
  signal?: AbortSignal
  /** Called after output has been read and spooled (a job's observer wakes on it). */
  onOutput?: () => void
  /** The child's environment (`K=V` entries); this process's by default. */
  env?: readonly string[]
  /**
   * The signal a cancelled child reports (128 + it), whatever interrupted
   * this process: a session child's, as its own worker's SIGTERM did. By
   * default the interrupt's, or SIGTERM for an abort.
   */
  cancelledAs?: number
  /** The child leads a session of its own (no controlling terminal), as under a job worker. */
  session?: boolean
  /** Called with the child's pid (its group's id) once it has started. */
  onSpawn?: (pid: number) => void
}

const now = () => performance.now()

const utf8 = (s: string) => Buffer.from(s, 'utf8')

function closeFd(fd: number): number {
  if (fd >= 0) {
    try {
      closeSync(fd)
    } catch {}
  }
  return -1
}

// The newest `limit` bytes of a stream; `cut` once any were dropped. The
// buffer is made on the first byte, so a quiet stream costs nothing.
const NONE = Buffer.alloc(0)
class Tail {
  private readonly limit: number
  private buf: Buffer = NONE
  private total = 0
  cut = false
  constructor(limit: number) {
    this.limit = limit
  }
  push(data: Uint8Array) {
    if (data.length === 0) return
    if (this.buf === NONE) this.buf = Buffer.allocUnsafe(this.limit)
    if (this.total + data.length > this.limit) this.cut = true
    for (let i = 0; i < data.length; ) {
      const at = this.total % this.limit
      const n = Math.min(data.length - i, this.limit - at)
      this.buf.set(data.subarray(i, i + n), at)
      i += n
      this.total += n
    }
  }
  bytes(): Uint8Array {
    if (this.total <= this.limit) return this.buf.subarray(0, this.total)
    const at = this.total % this.limit
    return Buffer.concat([this.buf.subarray(at), this.buf.subarray(0, at)])
  }
}

// Spools: a plain one keeps the first 1 MiB; a rolling one is a 16-byte header
// (bytes written, little-endian u64, then flags, bit 0 the stream ended) and a
// ring of the latest 1 MiB. Data is written before the header that counts it.
class Spool {
  logged = 0
  error = 0
  readonly fd: number
  private readonly rolling: boolean
  constructor(fd: number, rolling: boolean) {
    this.fd = fd
    this.rolling = rolling
  }
  head(flags: number) {
    if (this.fd < 0) return
    const h = Buffer.alloc(RING_HEAD)
    h.writeBigUInt64LE(BigInt(this.logged), 0)
    h.writeBigUInt64LE(BigInt(flags), 8)
    this.put(h, 0)
  }
  private put(data: Uint8Array, at: number | null): number {
    try {
      return writeSync(this.fd, data, 0, data.length, at)
    } catch (e) {
      this.error = L.errnoOf(e)
      return 0
    }
  }
  write(data: Uint8Array) {
    if (this.fd < 0) return
    if (this.rolling) {
      let i = 0
      while (i < data.length && !this.error) {
        const at = this.logged % RING
        const n = Math.min(data.length - i, RING - at)
        const put = this.put(data.subarray(i, i + n), RING_HEAD + at)
        if (put <= 0) {
          this.error ||= L.E.EIO
          return
        }
        this.logged += put
        i += put
      }
      this.head(0)
      return
    }
    if (this.logged >= SPOOL_LIMIT) return
    let pending = data.subarray(0, Math.min(data.length, SPOOL_LIMIT - this.logged))
    while (pending.length && !this.error) {
      const put = this.put(pending, null)
      if (put <= 0) {
        this.error ||= L.E.EIO
        return
      }
      this.logged += put
      pending = pending.subarray(put)
    }
  }
}

/** Validation exactly as jf_exec_start: anything out of bounds is EINVAL. */
function invalid(s: Supervise, input: Buffer, max: number, inputMax: number, limit: number): boolean {
  const cwd = s.cwd ?? ''
  if (utf8(cwd).length > CWD_MAX || cwd.includes('\0') || (cwd !== '' && cwd[0] !== '/')) return true
  for (const fd of s.logs ?? [-1, -1]) {
    if (fd < 0) continue
    try {
      if (!fstatSync(fd).isFile()) return true
    } catch {
      return true
    }
  }
  if (s.argv.length > ARGS || s.argv.some((a) => a.includes('\0') || utf8(a).length > ARG_BYTES)) return true
  const stdinFd = s.stdinFd ?? -1
  return (
    s.argv.length === 0 ||
    s.argv[0] === '' ||
    input.length > inputMax ||
    !Number.isInteger(s.timeoutMs) ||
    s.timeoutMs < 1 ||
    s.timeoutMs > max ||
    limit < 1 ||
    limit > LIMIT_MAX ||
    stdinFd < -1 ||
    (stdinFd >= 0 && s.inheritStdin === true)
  )
}

/**
 * Runs one child to completion under its deadline. The answer is the raw
 * result with both tails as bytes, or the failure (errno, "native subprocess
 * request failed"): a missing command, a bad request, more than 32 children
 * at once, or an interrupted scope. Every descriptor handed in is consumed.
 */
export async function supervise(s: Supervise, bytesInput = false): Promise<Result<Raw<Uint8Array>>> {
  installSignalScope()
  const input = typeof s.input === 'string' ? utf8(s.input) : Buffer.from(s.input ?? new Uint8Array())
  const max = s.timeoutMax ?? TIMEOUT_MAX_MS
  const limit = s.limit ?? TAIL
  const rolling = s.rolling === true
  let stdinFd = s.stdinFd ?? -1
  const logs: [number, number] = [...(s.logs ?? [-1, -1])]
  if (logs[0] === logs[1]) logs[1] = -1
  const spools = [new Spool(logs[0], rolling), new Spool(logs[1], rolling)] as const
  const finish = (r: Result<Raw<Uint8Array>>) => {
    // A rolling stream has ended once its supervisor has: mark it for readers.
    if (rolling) for (const sp of spools) sp.head(1)
    closeFd(logs[0])
    closeFd(logs[1])
    stdinFd = closeFd(stdinFd)
    return r
  }
  if (invalid(s, input, max, bytesInput ? BYTES_INPUT_MAX : TEXT_INPUT_MAX, limit)) return finish(fail(L.E.EINVAL, FAILED))
  if (shuttingDown || running >= JOBS) return finish(fail(L.E.EAGAIN, FAILED))
  // Allocated before anything is counted or listened for, which the finally below undoes.
  const tails = [new Tail(limit), new Tail(limit)] as const
  running++
  // Wakes this supervisor's loop: a SIGCHLD, output or end of a stream, an
  // interrupt or an abort. A wake while the loop is busy ends its next rest.
  let poked = false
  let wake = () => {}
  const poke = () => {
    poked = true
    wake()
  }
  const unlisten = onChildExit(poke)
  scope.add(poke)
  let inR = -1
  let inW = -1
  let outR = -1
  let outW = -1
  let errR = -1
  let errW = -1
  let pid = -1
  let reaped = false
  let code = 0
  let flags = 0
  let status = 0
  let errorCode = 0
  // The pipe readers: each spools and keeps what arrives as it arrives.
  const open = [false, false]
  const readers: (ReadableStreamDefaultReader<Uint8Array> | null)[] = [null, null]
  const reading: Promise<void>[] = []
  let halted = false
  const pump = (fd: number, stream: 0 | 1) => {
    const reader = Bun.file(fd).stream().getReader()
    readers[stream] = reader
    open[stream] = true
    reading.push(
      (async () => {
        try {
          let turn = 0
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done || halted) break
            spools[stream].write(chunk.value)
            tails[stream].push(chunk.value)
            if (tails[stream].cut) flags |= stream ? STDERR_CUT : STDOUT_CUT
            s.onOutput?.()
            poke()
            // Reads that resolve at once chain as microtasks: past a turn's worth, let the loop run.
            turn += chunk.value.length
            if (turn >= TURN_BYTES) {
              turn = 0
              await new Promise<void>((r) => setImmediate(r))
            }
          }
        } catch {
          // A read error ends the stream, as posix.c closed it.
        } finally {
          open[stream] = false
          poke()
        }
      })(),
    )
  }
  // Stops both readers before their descriptors (and the spools) close.
  let halting: Promise<void> | null = null
  const halt = () =>
    (halting ??= (async () => {
      halted = true
      for (const r of readers) await r?.cancel().catch(() => {})
      await Promise.all(reading)
      outR = closeFd(outR)
      errR = closeFd(errR)
    })())
  // Until `ms` have passed or a wake, whichever is first.
  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      if (poked) return resolve()
      // No wait at all (input made room): only yield to the event loop.
      if (ms <= 0) return void setImmediate(resolve)
      const timer = setTimeout(done, Math.ceil(ms))
      function done() {
        clearTimeout(timer)
        wake = () => {}
        resolve()
      }
      wake = done
    })
  try {
    if (interrupt) return finish(fail(L.E.EINTR, FAILED))
    if (rolling) {
      for (const sp of spools) sp.head(0)
      const e = spools[0].error || spools[1].error
      if (e) return finish(fail(e, FAILED))
    }
    try {
      // A caller's stdin reader is not re-piped: it is the child's stdin and is closed here.
      if (stdinFd >= 0) {
        inR = stdinFd
        stdinFd = -1
      } else if (!s.inheritStdin) [inR, inW] = L.pipe()
      ;[outR, outW] = L.pipe()
      ;[errR, errW] = L.pipe()
    } catch (e) {
      return finish(fail(L.errnoOf(e), FAILED))
    }
    // A rolling child that reads this process's own stdin (a session worker
    // passing on its owner's pipe) takes it over: once it has started, this
    // process lets go of fd 0, so the owner's writes fail once the child is gone.
    let release = false
    if (rolling && inR >= 0) {
      try {
        const given = fstatSync(inR)
        const own = fstatSync(0)
        release = given.dev === own.dev && given.ino === own.ino
      } catch {}
    }
    if (shuttingDown) return finish(fail(L.E.ECANCELED, FAILED))
    try {
      pid = L.spawn({
        argv: [...s.argv],
        env: s.env ? [...s.env] : L.environment(),
        stdio: [s.inheritStdin ? 0 : inR, outW, errW],
        cwd: s.cwd ?? '',
        group: true,
        session: s.session === true,
      })
    } catch (e) {
      return finish(fail(L.errnoOf(e), FAILED))
    }
    owned.add(pid)
    s.onSpawn?.(pid)
    if (release) {
      try {
        const none = openSync('/dev/null', 'r')
        L.dup2(none, 0)
        closeSync(none)
      } catch {}
    }
    inR = closeFd(inR)
    outW = closeFd(outW)
    errW = closeFd(errW)
    try {
      if (inW >= 0) L.setNonblock(inW)
      L.setNonblock(outR)
      L.setNonblock(errR)
    } catch (e) {
      return finish(fail(L.errnoOf(e), FAILED))
    }
    pump(outR, 0)
    pump(errR, 1)
    const signal = s.signal
    let aborted = false
    const onAbort = () => {
      aborted = true
      poke()
    }
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) aborted = true
    const deadline = now() + s.timeoutMs
    let exitedAt = 0
    let termAt = -1
    let sent = 0
    let inputIdle = POLL_MIN_MS
    try {
      while (!reaped || open[0] || open[1]) {
        poked = false
        const t = now()
        // Stop the group, then force it once the grace has passed.
        if (!reaped && (interrupt || aborted) && !(flags & CANCELLED)) {
          flags |= CANCELLED
          code = 128 + (s.cancelledAs ?? (interrupt || L.SIGTERM))
          L.kill(-pid, L.SIGTERM)
          termAt = t
        } else if (!reaped && termAt >= 0 && t - termAt >= TERM_GRACE_MS) {
          L.kill(-pid, L.SIGKILL)
          termAt = -1
        }
        if (!reaped && t >= deadline && !(flags & (TIMED_OUT | CANCELLED))) {
          flags |= TIMED_OUT
          code = TIMEOUT_EXIT
          L.kill(-pid, L.SIGKILL)
        }
        if (!reaped) {
          let w: L.Waited
          try {
            w = L.waitpid(pid)
          } catch (e) {
            errorCode = L.errnoOf(e)
            break
          }
          if (w.pid === pid) {
            reaped = true
            status = w.status
            exitedAt = now()
            // Whatever is left of its group goes with it.
            L.kill(-pid, L.SIGKILL)
            owned.delete(pid)
            inW = closeFd(inW)
          }
        }
        if (reaped && now() - exitedAt > DRAIN_GRACE_MS) {
          // Do not hang on an escaped daemon that kept a pipe. Disclose lost output.
          if (open[0]) flags |= STDOUT_CUT
          if (open[1]) flags |= STDERR_CUT
          break
        }
        if (sent === input.length) inW = closeFd(inW)
        const e = spools[0].error || spools[1].error
        if (e) {
          errorCode = e
          break
        }
        // Reaped and both streams at their end: done, without another rest.
        if (reaped && !open[0] && !open[1]) break
        let next = Infinity
        if (inW >= 0 && sent < input.length) {
          let wrote = 0
          try {
            wrote = writeSync(inW, input, sent, input.length - sent)
          } catch (err) {
            const n = L.errnoOf(err)
            if (n !== L.E.EAGAIN && n !== L.E.EWOULDBLOCK && n !== L.E.EINTR) inW = closeFd(inW)
          }
          sent += Math.max(0, wrote)
          // Room was made: try again at once; else wait for the child to read.
          inputIdle = wrote > 0 ? POLL_MIN_MS : Math.min(POLL_MS, inputIdle * 2)
          if (inW >= 0) next = wrote > 0 ? t : t + inputIdle
        }
        if (!reaped) {
          if (!(flags & (TIMED_OUT | CANCELLED))) next = Math.min(next, deadline)
          if (termAt >= 0) next = Math.min(next, termAt + TERM_GRACE_MS)
          next = Math.min(next, t + BACKSTOP_MS)
        } else next = Math.min(next, exitedAt + DRAIN_GRACE_MS + 1)
        await rest(next - now())
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await halt()
    }
    if (errorCode) return finish(fail(errorCode, FAILED))
    if (!(flags & (TIMED_OUT | CANCELLED))) code = L.exitCode(status)
    return finish(done({code, flags, stdout: tails[0].bytes(), stderr: tails[1].bytes()}))
  } finally {
    await halt()
    if (pid > 0 && !reaped) {
      L.kill(-pid, L.SIGKILL)
      try {
        L.waitpid(pid, true)
      } catch {}
      owned.delete(pid)
    }
    for (const fd of [inR, inW, outR, outW, errR, errW]) closeFd(fd)
    unlisten()
    scope.delete(poke)
    running--
  }
}

// ---------------------------------------------------------------------------
// The Process API (native/Process.bend).

// A leading BOM is text like any other (io_str kept it).
const decoder = () => new TextDecoder('utf-8', {ignoreBOM: true})
/** Text captures decode each tail with replacement (U+FFFD), as io_str did. */
export const text = (raw: Raw<Uint8Array>): Raw => ({...raw, stdout: decoder().decode(raw.stdout), stderr: decoder().decode(raw.stderr)})

const reported = (r: Result<Raw<Uint8Array>>): Result<Report> => (r.ok ? done(decode(text(r.value))) : r)

/** Native.exec: a 32 KiB tail per stream, an hour at most. */
export async function exec(argv: readonly string[], input: string, timeoutMs: number, inheritStdin = false, cwd = ''): Promise<Result<Raw>> {
  const r = await supervise({argv, input, timeoutMs, inheritStdin, cwd})
  return r.ok ? done(text(r.value)) : r
}

/** Process.run_input: buffered input, an explicit timer. */
export const runInput = async (argv: readonly string[], input: string, timeoutMs: number): Promise<Result<Report>> =>
  reported(await supervise({argv, input, timeoutMs}))

/** Process.run_in: as run_input or run_stdin, started in `cwd` (absolute, or '' to inherit). */
export const runIn = async (argv: readonly string[], input: string, timeoutMs: number, inheritStdin: boolean, cwd: string): Promise<Result<Report>> =>
  reported(await supervise({argv, input, timeoutMs, inheritStdin, cwd}))

/** Process.run_stdin: the child reads this process's stdin. */
export const runStdin = async (argv: readonly string[], timeoutMs: number): Promise<Result<Report>> =>
  reported(await supervise({argv, timeoutMs, inheritStdin: true}))

/** Process.exec_input: the configured work limit (JEV_FABRIC_TIMEOUT_MS). */
export async function execInput(argv: readonly string[], input: string): Promise<Result<Report>> {
  const ms = Time.work()
  return ms.ok ? runInput(argv, input, ms.value) : ms
}
export const execArgv = (argv: readonly string[]) => execInput(argv, '')
export async function execStdin(argv: readonly string[]): Promise<Result<Report>> {
  const ms = Time.work()
  return ms.ok ? runStdin(argv, ms.value) : ms
}

export type Captured = {code: number; flags: number; stdout: Uint8Array; stderr: Uint8Array}

/**
 * Native.capture: bounded byte-exact private capture. Callers must reject
 * either truncation flag. `signal` (an addition) cancels this child alone.
 */
export async function capture(argv: readonly string[], input: string, timeoutMs: number, limit: number, signal?: AbortSignal): Promise<Result<Captured>> {
  return supervise({argv, input, timeoutMs, limit, signal}, true)
}

/**
 * Native.exec_logged: stdin is an empty pipe, closed at once; the first 1 MiB
 * of each stream goes to the given spool writers (consumed). A detached job's
 * worker may run a day.
 */
export async function execLogged(
  argv: readonly string[],
  timeoutMs: number,
  stdout: number,
  stderr: number,
  cwd = '',
  onOutput?: () => void,
): Promise<Result<Raw>> {
  const r = await supervise({argv, input: '', timeoutMs, logs: [stdout, stderr], cwd, timeoutMax: JOB_TIMEOUT_MAX_MS, onOutput})
  return r.ok ? done(text(r.value)) : r
}

/**
 * Native.exec_pipe: the child's stdin is a pipe reader (consumed); the spools
 * keep the first 1 MiB, or with `rolling` the latest 1 MiB behind a header.
 * A rolling child may live a day, like a job; the first-byte form keeps the hour.
 */
export async function execPipe(
  argv: readonly string[],
  input: number,
  timeoutMs: number,
  stdout: number,
  stderr: number,
  rolling: boolean,
  cwd = '',
  onOutput?: () => void,
  env?: readonly string[],
): Promise<Result<Raw>> {
  const r = await supervise({
    argv,
    env,
    stdinFd: input,
    timeoutMs,
    logs: [stdout, stderr],
    rolling,
    cwd,
    timeoutMax: rolling ? JOB_TIMEOUT_MAX_MS : TIMEOUT_MAX_MS,
    onOutput,
  })
  return r.ok ? done(text(r.value)) : r
}

/** Process.run_logged: the effect admits a detached job's day; this API keeps the hour. */
export async function runLogged(argv: readonly string[], timeoutMs: number, stdout: number, stderr: number): Promise<Result<Report>> {
  if (!(timeoutMs <= TIMEOUT_MAX_MS)) {
    closeFd(stdout)
    closeFd(stderr)
    return fail(22, 'run_logged timeout must be 1..3600000 milliseconds')
  }
  const r = await execLogged(argv, timeoutMs, stdout, stderr)
  return r.ok ? done(decode(r.value)) : r
}

/** Native.pipe: one CLOEXEC pipe, [reader, writer], both owned by the caller. */
export function pipe(): Result<[number, number]> {
  try {
    return done(L.pipe())
  } catch (e) {
    return fail(L.errnoOf(e), 'native pipe failed')
  }
}

/** Native.stdin: a CLOEXEC duplicate of fd 0; closing it leaves fd 0 open. */
export function stdin(): Result<number> {
  try {
    return done(L.dupCloexec(0, 3))
  } catch (e) {
    return fail(L.errnoOf(e), 'native stdin failed')
  }
}
