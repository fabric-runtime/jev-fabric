// Session children supervised in process (serve's `spawn`): the work 0.8.1's
// `__job-worker` did in "session" and "session-null" mode, done by the
// connection itself, so a child costs a few descriptors and timers instead of
// a runtime of its own.
//
// The job's files are the worker's, written by the same code (./jobs.ts):
// meta.json (the owner's), worker-out.log and worker-err.log (each a rolling
// spool's 16-byte header, nothing written, marked ended once supervision
// ends), .lease (held by the owner for as long as it supervises the child),
// stdout.ring and stderr.ring, events.jsonl, ready, result.json and
// receipt.json, and the stop marker the owner writes. Other processes see a
// live job exactly as they saw one under its worker.
//
// What a worker polled is told directly here: the owner's stop cancels the
// child at once (SIGTERM, SIGKILL 500 ms later), a stop marker written by
// another process is found within 100 ms by one sweep for all children, and
// a quiet child's observer rests until its child writes or exits. The child leads a session of its own, as
// under its worker (which had made itself a session leader). The owner's
// death, which no in-process code outlives, is the watchdog's
// (src/proc/watchdog.ts): it stops the children and runs `reap` below.

import {closeSync, writeSync} from 'node:fs'
import * as Codec from '../codec/codec.ts'
import type {Result} from '../codec/result.ts'
import {done} from '../codec/result.ts'
import * as Process from '../proc/process.ts'
import * as Report from '../proc/report.ts'
import * as SpoolCore from '../spool/core.ts'
import * as Spool from '../spool/spool.ts'
import * as Host from '../store/host.ts'
import * as L from '../sys/libc.ts'
import * as Core from './core.ts'
import * as Jobs from './jobs.ts'
import * as Streams from './streams.ts'

/** The worker's own stdout and stderr spools, which nothing writes once there is no worker. */
const WORKER_LOGS = ['worker-out.log', 'worker-err.log'] as const

const closeFd = (fd: number) => {
  if (fd < 0) return
  try {
    closeSync(fd)
  } catch {}
}

/** A rolling spool's header: bytes written (u64 LE), then flags (bit 0: ended). */
function header(count: number, ended: boolean): Buffer {
  const h = Buffer.alloc(SpoolCore.headSize)
  h.writeBigUInt64LE(BigInt(count), 0)
  h.writeBigUInt64LE(ended ? 1n : 0n, 8)
  return h
}

/** Writes a spool's header in place; best effort, as a supervisor's last header write was. */
function mark(dir: string, name: string, count: number, ended: boolean): void {
  const fd = Host.reopen(dir, name)
  if (!fd.ok) return
  try {
    writeSync(fd.value, header(count, ended), 0, SpoolCore.headSize, 0)
  } catch {}
  closeFd(fd.value)
}

// A stop marker another process writes (`jev-fabric stop <dir>`, which a
// 0.8.1 worker honoured at its next tick) is found by one sweep of every
// live child's marker each 100 ms (the longest rest of a worker's quiet
// observer): one timer per process, however many children, while the
// observers themselves rest until their child writes, exits or is stopped.
const SWEEP_MS = Core.restMaxMs
// Each look is one openat on the child's held directory; a marker that is
// there is then read as every job file is (private, bounded, no symlink).
type Swept = {fd: number; stop: () => void}
const swept = new Map<string, Swept>()
let sweeper: ReturnType<typeof setInterval> | undefined

function sweep(): void {
  for (const [dir, s] of swept) {
    if (!Host.present(s.fd, 'stop')) continue
    const marker = Host.read(dir, 'stop', Jobs.markerLimit)
    if (marker.ok && marker.value !== '') {
      unsweep(dir)
      s.stop()
    }
  }
}

function sweepFor(dir: string, stop: () => void): void {
  const fd = Host.directoryOf(dir)
  // Without a descriptor the child is still stopped by its owner, only not by a marker from outside.
  if (!fd.ok) return
  swept.set(dir, {fd: fd.value, stop})
  if (sweeper) return
  sweeper = setInterval(sweep, SWEEP_MS)
  sweeper.unref()
}

function unsweep(dir: string): void {
  const s = swept.get(dir)
  if (!s) return
  swept.delete(dir)
  Host.release(s.fd)
  if (swept.size > 0 || !sweeper) return
  clearInterval(sweeper)
  sweeper = undefined
}

export type Hooks = {
  /** The child has started, leading process group `pid`. */
  spawned?: (pid: number) => void
  /** The child has been reaped and its group killed. */
  reaped?: (pid: number) => void
}

/** A session child under way. */
export type Child = {
  dir: string
  /** The owner's end of the child's stdin, nonblocking; -1 for `stdin: "null"`. */
  input: number
  /** Cancels the child, as a stop does: SIGTERM, then SIGKILL after 500 ms. */
  stop: () => void
  /**
   * Resolves once supervision is over: the child reaped, its receipt
   * published (true) or, after a failure, none (false), and its lease released.
   */
  ended: Promise<boolean>
}

/**
 * Starts a session child in `dir` (made, with its meta.json, by the owner):
 * its files, its lease, its spools, `ready`, then the command. The child,
 * or null where its worker would not have started (the owner answers
 * NOT_STARTED, as when 0.8.1's worker exited before announcing itself), or
 * the failure to answer as an error.
 */
export function start(dir: string, meta: string, argv: readonly string[], lifetime: number, cwd: string, pipe: boolean, hooks: Hooks = {}): Result<Child | null> {
  for (const name of WORKER_LOGS) {
    const log = Host.spool(dir, name, true)
    if (!log.ok) return log
    try {
      writeSync(log.value, header(0, false), 0, SpoolCore.headSize, 0)
    } catch {}
    closeFd(log.value)
  }
  const pair = Process.pipe()
  if (!pair.ok) return pair
  const [reader, writer] = pair.value
  const fds: number[] = []
  let lease = -1
  /** What a worker that exited before `ready` left behind. */
  const notStarted = (): Result<null> => {
    for (const fd of [reader, writer, ...fds]) closeFd(fd)
    if (lease >= 0) Host.release(lease)
    for (const name of WORKER_LOGS) mark(dir, name, 0, true)
    return done(null)
  }
  // The worker's launch and its own checks: a launch the supervisor refuses, a lifetime it would refuse.
  if (!Process.launchable() || !Core.reachesWorker(argv) || lifetime < 1 || lifetime > Process.JOB_TIMEOUT_MAX_MS) return notStarted()
  const held = Host.hold(dir)
  if (!held.ok) return notStarted()
  lease = held.value
  const spools: number[] = []
  for (const [name, writing] of [['stdout.ring', true], ['stderr.ring', true], ['stdout.ring', false], ['stderr.ring', false]] as const) {
    const fd = Host.spool(dir, name, writing)
    if (!fd.ok) return notStarted()
    spools.push(fd.value)
    fds.push(fd.value)
  }
  const [out, err, outRead, errRead] = spools as [number, number, number, number]
  const ring = Core.startedRing(dir, meta)
  const announced = Host.put(dir, 'events.jsonl', Core.lines(ring))
  if (!announced.ok || !Host.put(dir, 'ready', 'ready').ok) return notStarted()
  // `stdin: "null"`: the child's input is an empty pipe, already ended.
  let input = writer
  if (!pipe) {
    closeFd(writer)
    input = -1
  } else {
    try {
      L.setNonblock(writer)
    } catch {}
  }
  const abort = new AbortController()
  const w = Jobs.workerState(dir, {look: () => {}, cancel: () => abort.abort(), announced: true, fatal: () => {}})
  let pid = -1
  const supervised = Process.supervise({
    argv,
    stdinFd: reader,
    timeoutMs: lifetime,
    timeoutMax: Process.JOB_TIMEOUT_MAX_MS,
    logs: [out, err],
    rolling: true,
    cwd,
    onOutput: w.output,
    signal: abort.signal,
    cancelledAs: L.SIGTERM,
    session: true,
    onSpawn: (p) => {
      pid = p
      hooks.spawned?.(p)
    },
  })
  const work = Jobs.fork(
    w,
    supervised.then((r) => {
      if (pid > 0) hooks.reaped?.(pid)
      Jobs.recordResult(w, meta, r.ok ? done(Process.text(r.value)) : r)
    }),
  )
  sweepFor(dir, () => abort.abort())
  const ended = Jobs.observeFrom(w, lifetime, work, outRead, errRead, ring, true).then(
    () => true,
    async () => {
      // Supervision failed (a job file could not be written): the child goes, and the job reads as its worker's crash.
      abort.abort()
      await work.catch(() => {})
      return false
    },
  )
  return done({
    dir,
    input,
    stop: () => abort.abort(),
    ended: ended.then((published) => {
      unsweep(dir)
      Host.release(lease)
      for (const name of WORKER_LOGS) mark(dir, name, 0, true)
      return published
    }),
  })
}

// ---------------------------------------------------------------------------
// After the owner's death: the watchdog has stopped the children's groups;
// each child's receipt is published as its supervisor would have published
// it for a stop (cancelled, exit 143, the newest 32 KiB of each stream), with
// the output its observer had not yet seen and job.finished.

/** The ring a saved events.jsonl holds: its events, newest first, and the next sequence. */
function savedRing(text: string): Core.Ring {
  const lines = text.split('\n').filter((l) => l !== '')
  const last = lines.length === 0 ? null : Core.sequence(lines.at(-1)!)
  return {next: last === null ? 1 : (last + 1) >>> 0, newest: lines.reverse().slice(0, Core.ringSize)}
}

/** Where the observer had got to in a stream: the end of its newest output event (none evicted: 0). */
function seen(ring: Core.Ring, stream: string, count: number): number {
  for (const line of ring.newest) {
    const event = Core.document(line)
    const kind = Codec.field(event, 'type')
    const data = Codec.field(event, 'data')
    if (kind?.t !== 'str' || kind.v !== 'process.output' || data === undefined) continue
    const named = Codec.field(data, 'stream')
    if (named?.t !== 'str' || named.v !== stream) continue
    const offset = Codec.field(data, 'offset')
    const bytes = Codec.field(data, 'bytes')
    if (offset?.t === 'num' && bytes?.t === 'num') return Number(offset.lex) + Number(bytes.lex)
  }
  // Nothing of this stream retained: never seen, unless older events were evicted (then it is taken as seen).
  return ring.next - 1 === ring.newest.length ? 0 : count
}

/** The newest 32 KiB of a rolling spool, as the supervisor's tail kept them, and whether any were dropped. */
function tail(fd: number): {bytes: Uint8Array; cut: boolean; count: number} {
  const count = Jobs.must(Spool.headOf(fd)).count
  const start = Math.max(SpoolCore.oldest(count), SpoolCore.minus(count, Process.TAIL))
  return {bytes: Jobs.must(Spool.ringBytes(fd, start, count - start)), cut: count > Process.TAIL, count}
}

function reapOne(dir: string): void {
  const lease = Host.hold(dir)
  // Held: something still supervises it (or another reaper got there first).
  if (!lease.ok) return
  try {
    if (Jobs.must(Host.read(dir, 'receipt.json', Jobs.spoolLimit)) !== '') return
    if (Jobs.must(Host.read(dir, 'ready', Jobs.markerLimit)) === '') return
    const meta = Jobs.must(Host.read(dir, 'meta.json', Core.metaLimit))
    let ring = savedRing(Jobs.must(Host.read(dir, 'events.jsonl', Jobs.spoolLimit)))
    const outFd = Jobs.must(Host.open(dir, 'stdout.ring'))
    const errFd = Jobs.must(Host.open(dir, 'stderr.ring'))
    const o = tail(outFd)
    const e = tail(errFd)
    let out: Jobs.Cursor = {fd: outFd, offset: seen(ring, 'stdout', o.count), decoder: Streams.empty(), rolling: true}
    let err: Jobs.Cursor = {fd: errFd, offset: seen(ring, 'stderr', e.count), decoder: Streams.empty(), rolling: true}
    // The observer's last look: the newest window of each stream past where it had got to.
    ;[out, ring] = Jobs.observe(out, ring, 'stdout')
    ;[err, ring] = Jobs.observe(err, ring, 'stderr')
    const flags = Report.CANCELLED | (o.cut ? Report.STDOUT_CUT : 0) | (e.cut ? Report.STDERR_CUT : 0)
    const raw = Process.text({code: 128 + L.SIGTERM, flags, stdout: o.bytes, stderr: e.bytes})
    const receipt = Core.withId(dir, meta, Report.show(Report.decode(raw)))
    Jobs.must(Host.put(dir, 'result.json', receipt))
    mark(dir, 'stdout.ring', o.count, true)
    mark(dir, 'stderr.ring', e.count, true)
    // The worker's own logs stay as they are: 0.8.1's were marked ended by the owner, which is gone.
    Jobs.terminal(dir, receipt, out, err, ring)
  } finally {
    Host.release(lease.value)
  }
}

/** Publishes the receipts of an owner's stopped session children; a directory it cannot settle is left as it is. */
export function reap(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      reapOne(dir)
    } catch {}
  }
}

/** `<self> --RTS __session-reaper <dir>...`, which the watchdog becomes. */
export function reaperMain(dirs: string[]): never {
  Jobs.restoreEnv()
  reap(dirs)
  process.exit(0)
}
