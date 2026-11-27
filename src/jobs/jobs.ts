// Durable detached jobs (native/Jobs.bend): `start` forks a detached worker
// that re-enters this executable, claims the advisory lease on its private
// job directory and supervises the command; `status`, `wait`, `stop`,
// `events`, `follow`, `list`, `write`, `close-input` and `read` observe or
// steer it through the job's files alone. Labels, `list` and `follow` policy
// live in ./core.ts; this module runs it.
//
// Bounds: 1024 stored jobs per root, 64 events per job, 2048 bytes observed
// per stream per tick (25 ms), the first 1 MiB of each stream spooled (or,
// for interactive jobs and session children, the latest 1 MiB rolling), the
// final 32 KiB tail of each in the receipt, and a day at most. omittedBytes
// discloses skipped bytes, sequence gaps disclose evicted events, and
// process.spool_limit discloses reaching the first-byte cap.
//
// Every verb is a library function that prints what the 0.8.1 CLI printed,
// line by line, through `out`, and resolves to the exit code; a fatal error
// (IO.die in Bend) resolves to its code with its message for stderr.

import {closeSync, fstatSync, readSync, writeSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {quote} from '../codec/print.ts'
import * as Codec from '../codec/codec.ts'
import * as Process from '../proc/process.ts'
import * as Report from '../proc/report.ts'
import * as SpoolCore from '../spool/core.ts'
import * as Spool from '../spool/spool.ts'
import * as Host from '../store/host.ts'
import * as L from '../sys/libc.ts'
import * as TimeCore from '../time/core.ts'
import * as Time from '../time/time.ts'
import * as Core from './core.ts'
import * as Streams from './streams.ts'
import type {Pending, Ring} from './core.ts'
import {afterTick, controlFuel, event, saveDue, startedRing} from './core.ts'

/** First-byte spool cap per stream; also the largest private file read. */
export const spoolLimit = 1048576
/** Bytes observed per stream per tick. */
export const window = 2048
/** Size bound for the "stop" and "ready" marker files. */
export const markerLimit = 16
export const maxJobs = 1024
const TICK_MS = 25

/** Where a verb's lines go (each one is a line of stdout). */
export type Out = (line: string) => void
/** A verb's end: its exit code, and for a failure the message for stderr. */
export type Exit = {code: number; error?: string}

/** IO.die: ends the verb with `code`, `message` on stderr. */
export class Die extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export const die = (code: number, message: string): never => {
  throw new Die(code, message)
}
/** IO.try / IO.pass: the value, or the failure ends the verb. */
export function must<T>(r: Result<T>): T {
  if (!r.ok) die(r.error.code, r.error.message)
  return (r as {ok: true; value: T}).value
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const now = () => Math.floor(performance.now())
const closeFd = (fd: number) => {
  try {
    closeSync(fd)
  } catch {}
}

export const save = (id: string, ring: Ring) => must(Host.put(id, 'events.jsonl', Core.lines(ring)))

function output(ring: Ring, stream: string, offset: number, count: number, omitted: number, text: string, changed: boolean): Ring {
  if (!changed) return ring
  return event(ring, 'process.output', `{"stream":${quote(stream)},"offset":${offset},"bytes":${count},"omittedBytes":${omitted},"text":${quote(text)}}`)
}

function limitReached(ring: Ring, stream: string, reached: boolean): Ring {
  if (!reached) return ring
  return event(ring, 'process.spool_limit', `{"stream":${quote(stream)},"limitBytes":1048576,"mayBeTruncated":true}`)
}

// ---------------------------------------------------------------------------
// Observing the spools: the newest window per tick, decoded incrementally.

export type Cursor = {fd: number; offset: number; decoder: Streams.Decoder; rolling: boolean}
type Chunk = {cursor: Cursor; text: string; count: number; offset: number; omitted: number}

function chunkOf(c: Cursor, start: number, omitted: number, bytes: Uint8Array): Chunk {
  const fresh = omitted !== 0 ? Streams.empty() : c.decoder
  const [decoder, text] = Streams.take(Streams.feed(bytes, fresh))
  return {cursor: {fd: c.fd, offset: start + bytes.length, decoder, rolling: c.rolling}, text, count: bytes.length, offset: start, omitted}
}

function read(c: Cursor): Chunk {
  if (c.rolling) {
    // The newest window of what the header says was written, less anything the
    // writer wrapped over while it was read (disclosed as omitted).
    const h = must(Spool.headOf(c.fd))
    const start = Math.max(SpoolCore.minus(h.count, window), c.offset)
    const bytes = must(Spool.ringBytes(c.fd, start, SpoolCore.minus(h.count, start)))
    const after = must(Spool.headOf(c.fd))
    const lost = SpoolCore.overwritten(start, bytes.length, after.count)
    return chunkOf(c, start + lost, SpoolCore.minus(start, c.offset) + lost, bytes.subarray(lost))
  }
  // The newest window of the (capped) spool, never re-reading before the cursor.
  let size: number
  try {
    size = fstatSync(c.fd).size
  } catch (e) {
    return die(L.errnoOf(e), 'native file operation failed')
  }
  const start = Math.max(SpoolCore.minus(Math.min(size, SpoolCore.ring), window), c.offset)
  return chunkOf(c, start, SpoolCore.minus(start, c.offset), Spool.readAt(c.fd, start, window))
}

export function observe(c: Cursor, ring: Ring, stream: string): [Cursor, Ring, number] {
  const chunk = read(c)
  const any = chunk.count !== 0
  ring = output(ring, stream, chunk.offset, chunk.count, chunk.omitted, chunk.text, any)
  // Only a first-byte spool has a cap; a rolling one discloses loss as omitted bytes.
  const reached = any && !c.rolling && chunk.offset + chunk.count >= SpoolCore.ring
  return [chunk.cursor, limitReached(ring, stream, reached), chunk.count]
}

export function closeCursor(c: Cursor, ring: Ring, stream: string): Ring {
  closeFd(c.fd)
  const text = Streams.finish(c.decoder)
  return output(ring, stream, c.offset, 0, 0, text, text !== '')
}

// ---------------------------------------------------------------------------
// The worker.

const failureResult = (id: string, meta: string, stopped: string) =>
  stopped === '' ? Core.failed(id, meta, 'command launch failed') : Core.withId(id, meta, Report.show(Report.decode({code: 143, flags: Report.CANCELLED, stdout: '', stderr: ''})))

/**
 * One waiter's doorbell: rung by another fiber of this worker, it ends that
 * waiter's current rest, or its next one if it is busy.
 */
export class Bell {
  #rung = false
  #wake: (() => void) | null = null
  ring = () => {
    this.#rung = true
    this.#wake?.()
  }
  /** Forgets earlier rings: what rings from now on ends the next rest. */
  clear() {
    this.#rung = false
  }
  /** Until rung, or `ms` (null: until rung) have passed. */
  rest(ms: number | null): Promise<void> {
    if (this.#rung) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        if (timer !== undefined) clearTimeout(timer)
        this.#wake = null
        resolve()
      }
      const timer = ms === null ? undefined : setTimeout(done, ms)
      this.#wake = done
    })
  }
}

/**
 * How one supervised job is stopped. A worker process polls its stop marker
 * (and a session worker its owner) at every tick and cancels its one child
 * by interrupting itself. A supervisor that runs jobs in process (serve, for
 * its session children) is told of a stop directly: nothing needs polling,
 * so a quiet job's observer rests until something rings it, and a stop or a
 * failure cancels that job alone.
 */
export type Control = {
  /** At the start of every tick: cancels the job if it should stop. */
  look: () => void
  /** Cancels the job's child (SIGTERM, SIGKILL 500 ms later). */
  cancel: () => void
  /** Whether everything that can end a rest rings the observer (stops are announced, never polled). */
  announced: boolean
  /** A forked fiber failed: the worker exits as IO.die would; in process, the job ends. */
  fatal: (e: unknown) => void
}

/**
 * What the worker's fibers tell one another in-process, instead of reading
 * back files this process writes: the supervisor's output wakes the observer,
 * and the recorded result (result.json, written only here) wakes both the
 * observer and the input feeder. The stop marker, the input queue and the
 * owner's death come from outside and are polled.
 */
export type Worker = {
  id: string
  result: string
  observer: Bell
  feeder: Bell
  output: () => void
  written: number
  seen: number
  control: Control
  /** A forked fiber's failure, rethrown by the observer at its next tick. */
  failure: {error: unknown} | null
}

export function workerState(id: string, control: Control = processControl(id, null)): Worker {
  const w: Worker = {
    id,
    result: '',
    observer: new Bell(),
    feeder: new Bell(),
    // The supervisor has spooled more output: count it and wake the observer.
    output: () => {
      w.written++
      w.observer.ring()
    },
    written: 0,
    seen: 0,
    control,
    failure: null,
  }
  return w
}

/**
 * A worker process's control: the stop marker every tick, and for a session
 * worker its owner (`parent`, the pid it started under): once the process
 * that spawned it is gone, it stops as if by `stop`.
 */
function processControl(id: string, parent: string | null): Control {
  return {
    look: () => {
      const stopped = must(Host.read(id, 'stop', markerLimit))
      if (stopped !== '') Process.cancel()
      if (parent !== null && Host.parent() !== parent) Process.cancel()
    },
    cancel: Process.cancel,
    announced: false,
    fatal: (e) => fatal(e),
  }
}

export function recordResult(w: Worker, meta: string, result: Result<Report.Raw>) {
  const id = w.id
  let text: string
  if (result.ok) text = Core.withId(id, meta, Report.show(Report.decode(result.value)))
  else text = failureResult(id, meta, must(Host.read(id, 'stop', markerLimit)))
  must(Host.put(id, 'result.json', text))
  w.result = text
  w.observer.ring()
  w.feeder.ring()
}

type Turn = {k: 'again'; out: Cursor; err: Cursor; ring: Ring; pending: Pending} | {k: 'end'; out: Cursor; err: Cursor; ring: Ring; receipt: string}

/**
 * Rests `ms` (Core.restMs). The observer's bell ends a longer rest early, at
 * the next 25 ms tick from its start, as 0.8.1's fixed ticks would have seen
 * the output: never sooner, so a burst that starts during a rest is still
 * seen whole on that tick rather than cut at its first chunk.
 */
async function rest(w: Worker, ms: number | null) {
  const begin = performance.now()
  await w.observer.rest(ms)
  const waited = performance.now() - begin
  const left = Math.max(1, Math.ceil(waited / Core.tickMs)) * Core.tickMs - waited
  if (left > 0 && (ms === null || waited < ms)) await sleep(left)
}

async function tick(w: Worker, out: Cursor, err: Cursor, ring: Ring, pending: Pending): Promise<Turn> {
  const id = w.id
  // Output or the result from here on ends the rest after this tick.
  w.observer.clear()
  if (w.failure) throw w.failure.error
  w.control.look()
  const receipt = w.result
  let outCount = 0
  let errCount = 0
  // The spools change only when the supervisor writes them, which it counts:
  // with nothing written since the last look there is nothing to read. The
  // drain after the result always looks.
  if (receipt !== '' || w.seen !== w.written) {
    w.seen = w.written
    ;[out, ring, outCount] = observe(out, ring, 'stdout')
    ;[err, ring, errCount] = observe(err, ring, 'stderr')
  }
  // Finish only on a quiet tick after the result appeared, so late output is drained.
  const done = receipt !== ''
  const changed = outCount !== 0 || errCount !== 0
  const finished = done && !changed
  const due = saveDue(pending, changed, finished)
  if (due) save(id, ring)
  const next = afterTick(pending, changed, due)
  if (!done) await rest(w, Core.restFor(next, w.control.announced))
  return finished ? {k: 'end', out, err, ring, receipt} : {k: 'again', out, err, ring, pending: next}
}

export function terminal(id: string, receipt: string, out: Cursor, err: Cursor, ring: Ring) {
  ring = closeCursor(out, ring, 'stdout')
  ring = closeCursor(err, ring, 'stderr')
  // Publish terminal last: once visible, the event snapshot is final too.
  save(id, event(ring, 'job.finished', '{"receiptAvailable":true}'))
  must(Host.put(id, 'receipt.json', receipt))
}

async function control(fuel: number, w: Worker, turn: Turn): Promise<void> {
  for (;;) {
    if (turn.k === 'end') return terminal(w.id, turn.receipt, turn.out, turn.err, turn.ring)
    if (fuel === 0) {
      if (turn.pending.unsaved) save(w.id, turn.ring)
      w.control.cancel()
      closeCursor(turn.err, closeCursor(turn.out, turn.ring, 'stdout'), 'stderr')
      die(1, 'job controller fuel exhausted')
    }
    fuel--
    try {
      turn = await tick(w, turn.out, turn.err, turn.ring, turn.pending)
    } catch (e) {
      // The spools' readers go with the observer; the worker's exit (or, in process, the caller) stops the child.
      closeFd(turn.out.fd)
      closeFd(turn.err.fd)
      throw e
    }
  }
}

/**
 * Observes the job's spools until its result is recorded and its output
 * drained, then publishes the terminal events and receipt. `work` is the
 * forked supervisor (whose result rings the observer).
 */
export async function observeFrom(w: Worker, timeout: number, work: Promise<void>, outRead: number, errRead: number, ring: Ring, rolling: boolean) {
  const out: Cursor = {fd: outRead, offset: 0, decoder: Streams.empty(), rolling}
  const err: Cursor = {fd: errRead, offset: 0, decoder: Streams.empty(), rolling}
  // Ticks are at least 25 ms apart, so the fuel still bounds them by the deadline.
  await control(controlFuel(timeout), w, {k: 'again', out, err, ring, pending: Core.firstPending})
  await work
}

/** A forked fiber: its fatal error ends the worker as IO.die would (in process, the job). */
export function fork(w: Worker, work: Promise<void>): Promise<void> {
  return work.catch((e) => {
    w.failure ??= {error: e}
    w.observer.ring()
    w.feeder.ring()
    w.control.fatal(e)
  })
}
let fatal: (e: unknown) => void = (e) => {
  throw e
}

// A batch job: stdin is empty and each spool keeps its first 1 MiB.
async function workerBatch(id: string, meta: string, argv: string[], timeout: number, cwd: string) {
  const out = must(Host.spool(id, 'stdout.bin', true))
  const err = must(Host.spool(id, 'stderr.bin', true))
  const outRead = must(Host.spool(id, 'stdout.bin', false))
  const errRead = must(Host.spool(id, 'stderr.bin', false))
  const ring = startedRing(id, meta)
  save(id, ring)
  must(Host.put(id, 'ready', 'ready'))
  const w = workerState(id)
  const work = fork(w, Process.execLogged(argv, timeout, out, err, cwd, w.output).then((r) => recordResult(w, meta, r)))
  await observeFrom(w, timeout, work, outRead, errRead, ring, false)
}

const executePipe = (w: Worker, meta: string, argv: string[], input: number, timeout: number, out: number, err: number, cwd: string) =>
  fork(w, Process.execPipe(argv, input, timeout, out, err, true, cwd, w.output).then((r) => recordResult(w, meta, r)))

// A session child reads the owner's pipe (this worker's stdin) directly, or starts with its input already ended.
async function workerSession(id: string, meta: string, argv: string[], timeout: number, cwd: string, inherit: boolean) {
  const out = must(Host.spool(id, 'stdout.ring', true))
  const err = must(Host.spool(id, 'stderr.ring', true))
  const outRead = must(Host.spool(id, 'stdout.ring', false))
  const errRead = must(Host.spool(id, 'stderr.ring', false))
  let input: number
  if (inherit) input = must(Process.stdin())
  else {
    const [reader, writer] = must(Process.pipe())
    closeFd(writer)
    input = reader
  }
  const parent = Host.parent()
  const ring = startedRing(id, meta)
  save(id, ring)
  must(Host.put(id, 'ready', 'ready'))
  const w = workerState(id, processControl(id, parent))
  const work = executePipe(w, meta, argv, input, timeout, out, err, cwd)
  await observeFrom(w, timeout, work, outRead, errRead, ring, true)
}

/** Ends a job's input for writers: once its child is gone, a write is an error. */
const sealInput = (id: string) => Host.enqueue(id, '', true, Core.queueMax)

/** File.write on a pipe: every byte, waiting while the child is not reading; false once it is gone. */
async function writeAll(fd: number, text: string): Promise<boolean> {
  const data = Buffer.from(text, 'utf8')
  for (let sent = 0; sent < data.length; ) {
    try {
      sent += writeSync(fd, data, sent, data.length - sent)
    } catch (e) {
      const n = L.errnoOf(e)
      if (n !== L.E.EAGAIN && n !== L.E.EWOULDBLOCK && n !== L.E.EINTR) return false
      await sleep(5)
    }
  }
  return true
}

/** The feeder's poll of the input queue: 1 ms after a write or close was taken, doubling to 100 ms while none comes. */
const FEED_MIN_MS = 1
const FEED_MAX_MS = 100

/**
 * Drains the input queue into the child's stdin, in arrival order, in its
 * own fiber: a child that is not reading blocks only this one. Writers are
 * other processes appending under the queue's lock (0.8.1's among them), so
 * the queue is polled: 1 ms after anything was taken, then backing off to
 * 100 ms, the most a write waits on an idle job. A watch on the queue file
 * (kqueue, inotify) wakes the feeder as soon as a writer appends, so a write
 * usually waits a millisecond or two; the poll bounds it if a watch fails. Once `close-input` is drained the child's
 * input ends; once the child has exited (its result is recorded, which wakes
 * this at once), input is sealed and whatever is still queued is discarded.
 * `until` bounds it in time as 0.8.1's fuel of 25 ms ticks did.
 */
async function feeder(w: Worker, until: number, writer: number) {
  const id = w.id
  let input: number | null = writer
  L.setNonblock(writer)
  let delay = FEED_MIN_MS
  // A writer's append rings the feeder at once; the poll stays as the bound.
  let unwatch: (() => void) | null = null
  try {
    while (input !== null) {
      w.feeder.clear()
      if (now() >= until) {
        closeFd(input)
        return
      }
      let moved = false
      if (w.result !== '') {
        closeFd(input)
        sealInput(id)
        input = null
      } else {
        const taken = Host.dequeue(id, Core.queueMax)
        if (taken.ok) {
          const q = Core.taken(taken.value)
          moved = q.text !== '' || q.closed
          if (!(await writeAll(input, q.text))) {
            closeFd(input)
            sealInput(id)
            input = null
          } else if (q.closed) {
            closeFd(input)
            input = null
          }
        }
      }
      if (input === null) break
      // The first dequeue made the queue file, so it can be watched from here on.
      unwatch ??= Host.watchQueue(id, w.feeder.ring)
      delay = moved ? FEED_MIN_MS : Math.min(FEED_MAX_MS, delay * 2)
      await w.feeder.rest(delay)
    }
  } finally {
    unwatch?.()
  }
}

// An interactive job (`start --input pipe`): stdin is a pipe fed from the job's private queue, and both streams roll.
async function workerPipe(id: string, meta: string, argv: string[], timeout: number, cwd: string) {
  const out = must(Host.spool(id, 'stdout.ring', true))
  const err = must(Host.spool(id, 'stderr.ring', true))
  const outRead = must(Host.spool(id, 'stdout.ring', false))
  const errRead = must(Host.spool(id, 'stderr.ring', false))
  const [reader, writer] = must(Process.pipe())
  const ring = startedRing(id, meta)
  save(id, ring)
  must(Host.put(id, 'ready', 'ready'))
  const w = workerState(id)
  const work = executePipe(w, meta, argv, reader, timeout, out, err, cwd)
  const feed = fork(w, feeder(w, now() + controlFuel(timeout) * Core.tickMs, writer))
  await observeFrom(w, timeout, work, outRead, errRead, ring, true)
  await feed
}

/**
 * The worker itself: claims the job's lease (and its own session), refuses
 * a job already started or terminal, then supervises the command in `mode`:
 * "batch" (start), "pipe" (start --input pipe), "session" (a serve
 * connection's child reading the worker's stdin) or "session-null".
 */
export async function worker(id: string, mode: string, cwd: string, argv: string[], timeout: number): Promise<void> {
  must(Host.claim(id))
  const ready = must(Host.read(id, 'ready', markerLimit))
  const receipt = must(Host.read(id, 'receipt.json', spoolLimit))
  const meta = must(Host.read(id, 'meta.json', Core.metaLimit))
  if (!(ready === '' && receipt === '')) die(1, 'job already started or terminal')
  if (mode === 'batch') return workerBatch(id, meta, argv, timeout, cwd)
  if (mode === 'pipe') return workerPipe(id, meta, argv, timeout, cwd)
  if (mode === 'session') return workerSession(id, meta, argv, timeout, cwd, true)
  if (mode === 'session-null') return workerSession(id, meta, argv, timeout, cwd, false)
  die(2, 'unknown job worker mode')
}

// ---------------------------------------------------------------------------
// Status: lease probing never sends a signal.

/** Re-read after a dead lease, so a receipt published between the first read and the probe is never overwritten. */
function recover(id: string, receipt: string): string {
  if (receipt !== '') return receipt
  const meta = must(Host.read(id, 'meta.json', Core.metaLimit))
  const failed = Core.failed(id, meta, 'worker exited without a terminal receipt')
  must(Host.put(id, 'receipt.json', failed))
  return failed
}

function receiptOf(id: string, current: string): string {
  if (current !== '') return current
  if (must(Host.probe(id)) === '1') return ''
  return recover(id, must(Host.read(id, 'receipt.json', spoolLimit)))
}

/** The terminal receipt, or "" while the worker still holds its lease. */
export const statusRead = (id: string): string => receiptOf(id, must(Host.read(id, 'receipt.json', spoolLimit)))

/**
 * Like statusRead, but a job whose worker has not written "ready" is reported
 * running without a lease probe: probing could race the worker's claim of a
 * job that another process is still starting.
 */
export function settledRead(id: string): string {
  const current = must(Host.read(id, 'receipt.json', spoolLimit))
  if (current !== '') return current
  return must(Host.read(id, 'ready', markerLimit)) === '' ? '' : receiptOf(id, '')
}

const metaOf = (id: string) => must(Host.read(id, 'meta.json', Core.metaLimit))
const showRunning = (id: string, out: Out) => out(Core.running(id, metaOf(id)))

/**
 * Polls `look` until it answers, first after 1, 2, 5 and 10 ms and then every
 * 25 ms (Core.pollDelay), for `fuel` 25 ms ticks of time: the last look is
 * at the ceiling, as 0.8.1's last of `fuel` ticks was. "" while unanswered.
 */
async function poll(fuel: number, text: string, look: () => string): Promise<string> {
  const ceiling = now() + fuel * Core.tickMs
  for (let n = 0; text === ''; n++) {
    const left = ceiling - now()
    if (left <= 0) return ''
    await sleep(Math.min(Core.pollDelay(n), left))
    text = look()
  }
  return text
}

async function waitLoop(fuel: number, id: string, text: string, out: Out) {
  text = await poll(fuel, text, () => statusRead(id))
  return text !== '' ? out(text) : showRunning(id, out)
}

const waitFor = (fuel: number, id: string, out: Out) => waitLoop(fuel, id, statusRead(id), out)

/** The worker argv; a hidden verb the CLI routes to workerMain. */
let prefix: string[] | undefined
/**
 * How this executable is re-entered: [self] for the compiled binary, or
 * [bun, script] when running from source. The worker's argv is this, then
 * "--RTS", "__job-worker", id, ms, mode, cwd and the command, as 0.8.1's.
 */
export function configureSelf(argv: string[]) {
  prefix = argv
}
export function selfArgv(): string[] {
  if (prefix) return prefix
  const main = Bun.main
  return main.startsWith('/$bunfs/') || main.startsWith('B:/~BUN/') ? [Host.self()] : [Host.self(), main]
}

/** 0.8.1's re-entry: `<self> --RTS __job-worker <id> <ms> <mode> <cwd> <command...>`, cwd "" to inherit. */
export const workerArgv = (id: string, timeout: number, mode: string, cwd: string, argv: string[]) => [
  ...selfArgv(),
  '--RTS',
  '__job-worker',
  id,
  String(timeout),
  mode,
  cwd,
  ...argv,
]

// A worker's hot paths are system calls and its JavaScript runs a few times
// a second, so it does without JavaScriptCore's optimizing tiers (DFG, FTL):
// about 3 MiB less resident when idle, more under heavy output, and no
// measurable CPU. The command it runs must still see exactly its caller's
// environment, so the worker is told which of these it added (only those the
// caller had not set) and removes them before it starts anything.
const WORKER_JSC: Record<string, string> = {BUN_JSC_useDFGJIT: '0', BUN_JSC_useFTLJIT: '0'}
const WORKER_ADDED = 'JEV_FABRIC_WORKER_ADDED'

/** The environment a worker starts with: this process's, plus the JSC tiers it turns off. */
export function workerEnv(env: Record<string, string | undefined> = process.env): string[] {
  const added = Object.keys(WORKER_JSC).filter((k) => env[k] === undefined)
  const extra: Record<string, string> = {[WORKER_ADDED]: added.join(',')}
  for (const k of added) extra[k] = WORKER_JSC[k]!
  const own = {...env}
  delete own[WORKER_ADDED]
  return L.environment({...own, ...extra})
}

/** In a worker, before anything reads or passes on the environment: its caller's again. */
export function restoreEnv(env: Record<string, string | undefined> = process.env) {
  const added = env[WORKER_ADDED]
  if (added === undefined) return
  for (const k of added.split(',')) if (k in WORKER_JSC) delete env[k]
  delete env[WORKER_ADDED]
}

async function ready(fuel: number, id: string, text: string, out: Out) {
  text = await poll(fuel, text, () => must(Host.read(id, 'ready', markerLimit)))
  if (text !== '') return out(`{"id":${quote(id)}}`)
  must(Host.put(id, 'stop', 'stop'))
  die(1, 'native job did not become ready')
}

/** meta.json (start time, label, lifetime) is written before the worker exists, so every reader sees it. */
async function start(argv: string[], timeout: number, label: string, cwd: string, mode: string, out: Out) {
  const self = selfArgv()
  if (!self.length) die(L.E.EINVAL, Host.FAILED)
  const id = must(Host.make(maxJobs))
  const meta = Core.meta(label, Host.clock(), 'durable', mode === 'pipe')
  must(Host.put(id, 'meta.json', meta))
  const spawned = Host.spawn(workerArgv(id, timeout, mode, cwd, argv), workerEnv())
  if (!spawned.ok) {
    must(Host.put(id, 'receipt.json', Core.failed(id, meta, 'worker launch failed')))
    die(1, 'native worker launch failed')
  }
  await ready(200, id, '', out)
}

// ---------------------------------------------------------------------------
// Events and follow.

function events(id: string, after: number, out: Out) {
  const text = must(Host.read(id, 'events.jsonl', spoolLimit))
  for (const line of text.split('\n')) {
    const n = Core.sequence(line)
    if (n !== null && n > after) out(line)
  }
}

const cursor = (after: string): number => TimeCore.readU32(after) ?? die(2, 'after-sequence must be a U32')

/** Whether `events --timeout-ms` may answer: an event past the cursor, or a terminal receipt (read first). */
function eventsReady(id: string, after: number): boolean {
  const receipt = settledRead(id)
  const text = must(Host.read(id, 'events.jsonl', spoolLimit))
  return receipt !== '' || Core.pending(text.split('\n'), after)
}

/** A long poll: the snapshot once it holds an event past the cursor, the job is terminal, or the ceiling passes. */
async function eventsWait(id: string, after: number, ms: number, out: Out) {
  let found = eventsReady(id, after)
  for (let fuel = Math.floor((ms + 24) / 25); !found && fuel > 0; fuel--) {
    await sleep(TICK_MS)
    found = eventsReady(id, after)
  }
  events(id, after, out)
}

type Follow = {k: 'polling'; cursor: number} | {k: 'ending'; cursor: number; reason: string; receipt: string}

/** The receipt is read before the events: once it exists, the snapshot holds the final replay. */
function followTick(id: string, started: number, duration: number, cursor: number, out: Out): Follow {
  const receipt = settledRead(id)
  const text = must(Host.read(id, 'events.jsonl', spoolLimit))
  const followed = Core.follow(text.split('\n'), cursor)
  for (const line of followed.outs) out(line)
  const decision = Core.followDecision(receipt !== '', TimeCore.sub(now(), started) >= duration)
  if (decision === 'continue') return {k: 'polling', cursor: followed.cursor}
  if (decision === 'finished') return {k: 'ending', cursor: followed.cursor, reason: 'finished', receipt}
  return {k: 'ending', cursor: followed.cursor, reason: 'timeout', receipt: ''}
}

function followEnd(id: string, cursor: number, reason: string, receipt: string, out: Out) {
  out(Core.endJson(reason, cursor, receipt === '' ? Core.running(id, metaOf(id)) : receipt))
}

/**
 * Live JSONL: each retained event past the cursor as the worker publishes it,
 * a follow.loss record before any sequence gap, then one follow.end. The
 * ceiling only bounds observation; it never cancels or renews the job.
 */
async function follow(id: string, after: number, ms: number, out: Out) {
  const started = now()
  let state = followTick(id, started, ms, after, out)
  for (let fuel = Core.followFuel(ms); state.k === 'polling'; fuel--) {
    if (fuel === 0) return followEnd(id, state.cursor, 'timeout', '', out)
    await sleep(TICK_MS)
    state = followTick(id, started, ms, state.cursor, out)
  }
  followEnd(id, state.cursor, state.reason, state.receipt, out)
}

// ---------------------------------------------------------------------------
// `list`: reads never end the listing; an unreadable or unsafe directory is left out.

/** Jobs.inspect: one directory's entry; `sessions` selects session children (a serve connection's own). */
export function inspect(id: string, sessions: boolean): Core.Entry | null {
  const meta = Host.read(id, 'meta.json', Core.metaLimit)
  const receipt = Host.read(id, 'receipt.json', spoolLimit)
  const readyText = Host.read(id, 'ready', markerLimit)
  const probe = Core.classify(id, meta, receipt, readyText, sessions)
  if (probe.p === 'skip') return null
  if (probe.p === 'known') return probe.entry
  const alive = Host.probe(id)
  if (!alive.ok) return null
  if (alive.value === '1') return Core.unsettled(id, probe.meta, 'running', '')
  return Core.dead(id, probe.meta, Host.read(id, 'receipt.json', spoolLimit))
}

export const inspectAll = (ids: readonly string[], sessions: boolean): Core.Entry[] =>
  ids.flatMap((id) => {
    const e = inspect(id, sessions)
    return e ? [e] : []
  })

/** One JSON object for the job directories under the root, within the 1024 cap. */
export function list(out: Out) {
  const l = Core.listing(must(Host.list(maxJobs)), maxJobs)
  out(Core.listJson(inspectAll(l.ids, false), l.truncated))
}

// ---------------------------------------------------------------------------
// Checked arguments.

const timeoutError = (max: number) => `timeout must be 1..${max} milliseconds`

function within(raw: string, max: number): number {
  const ms = TimeCore.readU32(raw)
  if (ms === null || ms < 1 || ms > max) die(2, timeoutError(max))
  return ms!
}

/** An empty cwd inherits this process's; any other must be an existing absolute directory. */
function cwdChecked(cwd: string) {
  if (cwd !== '' && !Host.directory(cwd).ok) die(2, 'cwd must be an existing directory')
}

async function startChecked(ms: string, label: string, cwd: string, mode: string, argv: string[], out: Out) {
  const limit = within(ms, Time.jobMaxTimeout)
  const chosen = must(Core.optionalLabel(label))
  cwdChecked(cwd)
  await start(argv, limit, chosen, cwd, mode, out)
}

const store = (mutating: boolean) => must(Host.storeAttempt(mutating))

// ---------------------------------------------------------------------------
// `write`, `close-input` and `read`.

const printed = (r: Result<string>, out: Out) => out(must(r))

const writeText = (id: string, text: string, close: boolean, out: Out) => printed(Spool.queueWrite(id, text, close), out)

function writeChecked(id: string, text: string, out: Out) {
  if ([...text].length > 65536) die(2, 'write takes at most 65536 characters')
  writeText(id, text, false, out)
}

/** `write <id> --stdin`: stdin up to the point more bytes arrived than 65536 characters can take (4 each). */
async function writeStdin(id: string, out: Out) {
  const input = must(Process.stdin())
  const chunks: Buffer[] = []
  let size = 0
  try {
    const buffer = Buffer.alloc(65536)
    for (let fuel = 4096; fuel > 0 && size <= 262144; fuel--) {
      let got: number
      try {
        got = readSync(input, buffer, 0, buffer.length, null)
      } catch (e) {
        const n = L.errnoOf(e)
        if (n === L.E.EAGAIN || n === L.E.EWOULDBLOCK || n === L.E.EINTR) {
          await sleep(5)
          fuel++
          continue
        }
        break
      }
      if (got === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, got)))
      size += got
    }
  } finally {
    closeFd(input)
  }
  const text = must(Codec.decodeUtf8(Buffer.concat(chunks)))
  writeChecked(id, text, out)
}

const USAGE =
  'usage: start <timeout-ms> <command> [args...] | status <id>' +
  ' | events <id> [after-sequence] | wait <id> <wait-timeout-ms> | stop <id>' +
  ' | follow <timeout-ms> <id> [after-sequence] | list' +
  ' | write <id> (--stdin | -- text...) | close-input <id>' +
  ' | read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]'

// ---------------------------------------------------------------------------
// The verbs. `args` is the canonical argument list 0.8.1's Jobs.command took
// (Cli.parse already turned prefix options into it): `__start <ms> <label>
// <cwd> <batch|pipe> <command...>`, `wait <id> <ms>`, `events <id> [after
// [ms]]`, `follow <ms> <id> [after]`, and the rest as typed.

async function dispatch(args: string[], out: Out): Promise<void> {
  const [verb, a, b, c] = args
  const n = args.length
  if (verb === 'start' && n >= 3) return startChecked(a!, '', '', 'batch', args.slice(2), out)
  if (verb === '__start' && n >= 6) return startChecked(a!, b!, c!, args[4]!, args.slice(5), out)
  if (verb === '__job-worker' && n >= 6) return worker(a!, c!, args[4]!, args.slice(5), within(b!, Time.jobMaxTimeout))
  if (verb === 'status' && n === 2) {
    // status may record a dead worker's receipt, so it adopts the store.
    store(true)
    const text = statusRead(a!)
    return text === '' ? showRunning(a!, out) : out(text)
  }
  if (verb === 'wait' && n === 3) {
    const limit = within(b!, Time.maxTimeout)
    store(true)
    // Polls (poll()) until ceil(ms / 25) ticks of 25 ms have passed.
    return waitFor(Math.floor((limit + 24) / 25), a!, out)
  }
  if (verb === 'stop' && n === 2) {
    store(true)
    const text = statusRead(a!)
    if (text !== '') return out(text)
    must(Host.put(a!, 'stop', 'stop'))
    return waitFor(80, a!, out)
  }
  if (verb === 'events' && n === 2) {
    store(false)
    return events(a!, 0, out)
  }
  if (verb === 'events' && n === 3) {
    store(false)
    return events(a!, cursor(b!), out)
  }
  if (verb === 'events' && n === 4) {
    const limit = within(c!, 300000)
    const after = cursor(b!)
    store(false)
    return eventsWait(a!, after, limit, out)
  }
  if (verb === 'follow' && (n === 3 || n === 4)) {
    const limit = within(a!, Time.maxTimeout)
    const after = n === 4 ? cursor(c!) : 0
    store(false)
    return follow(b!, after, limit, out)
  }
  if (verb === 'list' && n === 1) {
    store(false)
    return list(out)
  }
  if (verb === 'write' && n === 3 && b === '--stdin') return writeStdin(a!, out)
  if (verb === 'write' && n >= 3 && b === '--') return writeChecked(a!, args.slice(3).join(' '), out)
  if (verb === 'close-input' && n === 2) return writeText(a!, '', true, out)
  if (verb === 'read') {
    const plan = must(Core.readPlan(args.slice(1)))
    return printed(await Spool.read(plan.id, plan.stream, plan.offset, plan.max, plan.wait, plan.base64), out)
  }
  die(2, USAGE)
}

/**
 * Jobs.command: runs one verb, printing its lines through `out`. Resolves to
 * 0, or to the code and message 0.8.1 exited with.
 */
export async function command(args: string[], out: Out): Promise<Exit> {
  try {
    await dispatch(args, out)
    return {code: 0}
  } catch (e) {
    if (e instanceof Die) return {code: e.code, error: e.message}
    throw e
  }
}

/** Runs a verb and collects what it printed, as the CLI would have. */
export async function run(args: string[]): Promise<{stdout: string; stderr: string; code: number}> {
  let stdout = ''
  const r = await command(args, (line) => (stdout += line + '\n'))
  return {stdout, stderr: r.error === undefined ? '' : r.error + '\n', code: r.code}
}

/**
 * The hidden worker entry the CLI routes to. `argv` is what 0.8.1's main saw
 * once its runtime had removed "--RTS": `["__job-worker", id, ms, mode, cwd,
 * command, ...args]`. It never resolves normally until the job is terminal;
 * a fatal error writes its message to stderr and exits with its code, and
 * every child group this process owns is killed on the way out.
 */
export async function workerMain(argv: string[]): Promise<never> {
  restoreEnv()
  Process.installSignalScope()
  const exit = (code: number, message?: string): never => {
    if (message !== undefined) process.stderr.write(message + '\n')
    process.exit(code)
  }
  fatal = (e) => (e instanceof Die ? exit(e.code, e.message) : exit(1, String(e)))
  try {
    const r = await command(argv, (line) => process.stdout.write(line + '\n'))
    return exit(r.code, r.error)
  } catch (e) {
    return exit(1, String(e))
  }
}
