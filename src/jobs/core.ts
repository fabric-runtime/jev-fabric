// Pure job-record policy (native/JobsCore.bend): job metadata and labels, the
// `list` summary, `follow` over retained events, the interactive input queue
// and the `read` argument plan. src/jobs/jobs.ts performs the reads, lease
// probes, prints and sleeps; nothing here touches a file or a clock.

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/codec.ts'
import {quote} from '../codec/print.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {readNat, readU32} from '../time/core.ts'

type Err = {code: number; message: string}

/** Largest meta.json read: an escaped 120-scalar label plus two numbers. */
export const metaLimit = 4096
export const SPOOL_LIMIT = 1048576

const bool = (b: boolean) => (b ? 'true' : 'false')
const cps = (s: string) => [...s]

// ---------------------------------------------------------------------------
// Metadata. `start` writes meta.json once, before it spawns the worker.

/** The `"label"` member of a receipt, running state or list entry; none when empty. */
export const labelField = (label: string) => (label === '' ? '' : `,"label":${quote(label)}`)

const inputField = (interactive: boolean) => (interactive ? ',"input":"pipe"' : '')

/**
 * `started` is the wall clock in epoch milliseconds, as digits. `lifetime` is
 * "durable" for `start` jobs and "session" for session children; `interactive`
 * records a stdin kept open for `write`.
 */
export const meta = (label: string, started: string, lifetime: string, interactive: boolean) =>
  `{"schemaVersion":1,"startedAt":${started}${labelField(label)},"lifetime":${quote(lifetime)}${inputField(interactive)}}`

/** A missing or unreadable record reads as null, so every field is absent. */
export function document(text: string): Json {
  const r = Codec.read(text)
  return r.ok ? r.value : Codec.NULL
}

const textOf = (found: Json | undefined) => (found?.t === 'str' ? found.v : '')
const numberOf = (found: Json | undefined) => (found?.t === 'num' ? found.lex : '')

/** The job's label, or "" for none (jobs started before labels too). */
export const metaLabel = (m: string) => textOf(Codec.field(document(m), 'label'))

/** "session" for a session child, else "durable" (jobs from before 0.5 included). */
export const metaLifetime = (m: string) => (textOf(Codec.field(document(m), 'lifetime')) === 'session' ? 'session' : 'durable')

export const isSession = (m: string) => metaLifetime(m) === 'session'

/** Whether the job's stdin stays open for `write` (an interactive job). */
export const metaInteractive = (m: string) => textOf(Codec.field(document(m), 'input')) === 'pipe'

/** The id callers use: a session child's carries an `s-` prefix before its directory. */
export const publicId = (id: string, m: string) => (isSession(m) ? `s-${id}` : id)

/** The opening members every record of a job shares: its public id, label and lifetime. */
export const identity = (id: string, m: string) => `"id":${quote(publicId(id, m))}${labelField(metaLabel(m))},"lifetime":${quote(metaLifetime(m))}`

/** Replaces a receipt's opening brace with the job's identity and spool limit. */
export function withId(id: string, m: string, receipt: string): string {
  if (receipt === '') return '{}'
  return `{${identity(id, m)},"spoolLimitBytes":1048576,${cps(receipt).slice(1).join('')}`
}

export const failed = (id: string, m: string, message: string) =>
  withId(id, m, `{"schemaVersion":1,"state":"failed","exitCode":null,"error":${quote(message)}}`)

export const running = (id: string, m: string) => `{"schemaVersion":1,${identity(id, m)},"state":"running","spoolLimitBytes":1048576}`

// ---------------------------------------------------------------------------
// `list`: one bounded summary of the job directories under the storage root.

export type Entry = {id: string; state: string; label: string; started: string; exit: string; session: boolean}

const stateOf = (found: Json | undefined) => (found?.t === 'str' ? found.v : 'failed')
const exitOf = (found: Json | undefined) => (found?.t === 'num' ? found.lex : 'null')

/** The state a terminal receipt records. */
export const receiptState = (receipt: string) => stateOf(Codec.field(document(receipt), 'state'))

/** A job with a terminal receipt reports that receipt's state and exit code. */
export function settled(id: string, m: string, receipt: string): Entry {
  const info = document(m)
  const doc = document(receipt)
  return {
    id: publicId(id, m),
    state: stateOf(Codec.field(doc, 'state')),
    label: textOf(Codec.field(info, 'label')),
    started: numberOf(Codec.field(info, 'startedAt')),
    exit: exitOf(Codec.field(doc, 'exitCode')),
    session: isSession(m),
  }
}

/** A job without a receipt: `exit` is a JSON fragment, or "" to omit exitCode. */
export function unsettled(id: string, m: string, state: string, exit: string): Entry {
  const info = document(m)
  return {
    id: publicId(id, m),
    state,
    label: textOf(Codec.field(info, 'label')),
    started: numberOf(Codec.field(info, 'startedAt')),
    exit,
    session: isSession(m),
  }
}

/** What the driver still has to do for one directory. */
export type Probe = {p: 'skip'} | {p: 'known'; entry: Entry} | {p: 'lease'; meta: string}

/**
 * A worker that has not written "ready" has not yet claimed its lease, so the
 * lease is never probed: a probe could race the claim of a starting job.
 */
const announced = (id: string, m: string, empty: boolean): Probe => (empty ? {p: 'known', entry: unsettled(id, m, 'starting', '')} : {p: 'lease', meta: m})

const receipted = (id: string, m: string, receipt: string, ready: string): Probe =>
  receipt === '' ? announced(id, m, ready === '') : {p: 'known', entry: settled(id, m, receipt)}

/**
 * A directory with no job files belongs to `run` or a library Session, not
 * to a job. The store's list leaves out session children, which only their
 * owner can address; an owner's list (`sessions`) holds nothing else.
 */
const jobFiles = (id: string, m: string, receipt: string, ready: string, foreign: boolean): Probe =>
  foreign ? {p: 'skip'} : receipted(id, m, receipt, ready)

/** Any unreadable or unsafe job file leaves the directory out of the list. */
export function classify(id: string, m: Result<string>, receipt: Result<string>, ready: Result<string>, sessions: boolean): Probe {
  if (!m.ok || !receipt.ok || !ready.ok) return {p: 'skip'}
  const empty = m.value === '' && receipt.value === '' && ready.value === ''
  return jobFiles(id, m.value, receipt.value, ready.value, empty || isSession(m.value) !== sessions)
}

/**
 * After a dead lease the receipt is read again: the worker may have published
 * it between the first read and the probe. Without one the job reports failed,
 * as `status` does, but `list` never writes the recovery receipt itself.
 */
export function dead(id: string, m: string, receipt: Result<string>): Entry | null {
  if (!receipt.ok) return null
  return receipt.value === '' ? unsettled(id, m, 'failed', 'null') : settled(id, m, receipt.value)
}

export type Listing = {ids: string[]; truncated: boolean}

/** Host lists at most max + 1 ids, so a longer list discloses truncation. */
export function listing(text: string, max: number): Listing {
  const ids = text.split('\n').filter((l) => l !== '')
  return {ids: ids.slice(0, max), truncated: ids.length > max}
}

/** Newest first; jobs without a start time (older versions) sort last. */
export const startedAt = (e: Entry): number => readNat(e.started) ?? 0

const optional = (key: string, value: string, empty: boolean) => (empty ? '' : `,"${key}":${value}`)

/** A session child's entry also names its lifetime; store entries keep the 0.4 shape. */
export const entryJson = (e: Entry) =>
  `{"id":${quote(e.id)},"state":${quote(e.state)}${labelField(e.label)}${optional('lifetime', '"session"', !e.session)}${optional('startedAt', e.started, e.started === '')}${optional('exitCode', e.exit, e.exit === '')}}`

/** Bend's List.sort is a stable merge sort: equal start times keep directory order. */
export const sorted = (entries: readonly Entry[]): Entry[] => [...entries].sort((a, b) => startedAt(b) - startedAt(a))

export const listJson = (entries: readonly Entry[], truncated: boolean) => `{"jobs":[${sorted(entries).map(entryJson).join(',')}],"truncated":${bool(truncated)}}`

// ---------------------------------------------------------------------------
// `follow`: retained events past a cursor, as the worker publishes them.

/** Each event line starts with {"sequence":N, (a 12-character prefix before N). */
export const sequence = (line: string): number | null => readU32(cps(line.split(',')[0]!).slice(12).join(''))

const newerThan = (found: number | null, after: number) => found !== null && found > after

/** Whether any retained event lies past the cursor. */
export const pending = (lines: readonly string[], after: number) => lines.some((l) => newerThan(sequence(l), after))

export const lossJson = (after: number, next: number) => `{"type":"follow.loss","after":${after},"next":${next}}`

/** `receipt` is the final receipt, or the running state on a timeout. */
export const endJson = (reason: string, next: number, receipt: string) => `{"type":"follow.end","reason":${quote(reason)},"next":${next},"receipt":${receipt}}`

/** The advanced cursor and the lines to print, in order. */
export type Followed = {cursor: number; outs: string[]}

/** A sequence gap means the ring evicted events the follower never saw. */
export const gap = (after: number, next: number, line: string, skipped: boolean) => (skipped ? [lossJson(after, next), line] : [line])

/** An event at or before the cursor was already printed and is never printed again. */
export const fresh = (line: string, cursor: number, next: number, unseen: boolean): Followed =>
  unseen ? {cursor: next, outs: gap(cursor, next, line, next > ((cursor + 1) >>> 0))} : {cursor, outs: []}

export function followLine(line: string, cursor: number): Followed {
  const next = sequence(line)
  return next === null ? {cursor, outs: []} : fresh(line, cursor, next, next > cursor)
}

export function follow(lines: readonly string[], cursor: number): Followed {
  const outs: string[] = []
  for (const line of lines) {
    const f = followLine(line, cursor)
    cursor = f.cursor
    outs.push(...f.outs)
  }
  return {cursor, outs}
}

/** One poll every 25 ms of the ceiling, plus slack; the driver also checks the clock. */
export const followFuel = (duration: number) => Math.floor(duration / 25) + 64

export type Decision = 'continue' | 'finished' | 'expired'

/**
 * A terminal receipt ends a follow as finished, even at its ceiling. The
 * driver reads the receipt before the events, so the final replay is printed.
 */
export const followDecision = (finished: boolean, expired: boolean): Decision => (finished ? 'finished' : expired ? 'expired' : 'continue')

// ---------------------------------------------------------------------------
// Interactive jobs (`start --input pipe`): writers append to a private input
// queue in the job directory and the worker drains it into the child's stdin
// every tick. Host applies `admit` under the queue's lock, with queueMax.

/** Bytes a job's queue may hold before its worker has drained them. */
export const queueMax = 1048576

/** A write of `total` pending bytes is accepted: never once input has ended, never past the bound. */
export const admit = (closed: boolean, total: number, max: number) => !closed && max >= total

/** The queue as the worker sees it: the bytes not yet handed over, in arrival order, and whether input ended. */
export type Queue = {text: string; closed: boolean}
export const emptyQueue = (): Queue => ({text: '', closed: false})
/** An accepted write lands after everything before it. */
export const push = (q: Queue, text: string): Queue => ({text: q.text + text, closed: q.closed})
export const seal = (q: Queue): Queue => ({text: q.text, closed: true})
/** Draining takes every pending byte, in order, and leaves the queue empty. */
export const drained = (q: Queue) => q.text
export const emptied = (q: Queue): Queue => ({text: '', closed: q.closed})

/** Host's dequeue answer: "C" when input has ended, else "O", then the bytes. */
export function taken(answer: string): Queue {
  if (answer === '') return emptyQueue()
  const [head, ...rest] = cps(answer)
  return {text: rest.join(''), closed: head === 'C'}
}

/** UTF-8 bytes of a string, as a write record reports them. */
export const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')

export const writeJson = (id: string, written: number, closed: boolean) => `{"id":${quote(id)},"written":${written},"closed":${bool(closed)}}`

// ---------------------------------------------------------------------------
// `read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]`.

export type ReadPlan = {id: string; stream: string; offset: number; max: number; wait: number; base64: boolean}

const usage: Err = {code: 2, message: 'usage: read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]'}

function natChecked(raw: string, message: string): Result<number> {
  const n = readNat(raw)
  return n === null ? fail(2, message) : done(n)
}

function bounded(raw: string, low: number, high: number, message: string): Result<number> {
  const n = natChecked(raw, message)
  if (!n.ok) return n
  return n.value >= low && n.value <= high ? n : fail(2, message)
}

const maxOf = (raw: string) => bounded(raw, 1, 65536, 'max must be an integer from 1 to 65536')
const waitOf = (raw: string) => bounded(raw, 1, 300000, '--wait-ms must be an integer from 1 to 300000')
const offsetOf = (raw: string) => natChecked(raw, 'offset must be a byte offset')
const streamChecked = (stream: string): Result<string> =>
  stream === 'stdout' || stream === 'stderr' ? done(stream) : fail(2, 'stream must be stdout or stderr')

function positional(args: readonly string[], wait: number, base64: boolean): Result<ReadPlan> {
  if (args.length < 2 || args.length > 4) return {ok: false, error: usage}
  const [id, stream, offset, max] = args as [string, string, string?, string?]
  const named = streamChecked(stream)
  if (!named.ok) return named
  let at = 0
  if (offset !== undefined) {
    const r = offsetOf(offset)
    if (!r.ok) return r
    at = r.value
  }
  let most = 65536
  if (max !== undefined) {
    const r = maxOf(max)
    if (!r.ok) return r
    most = r.value
  }
  return done({id, stream: named.value, offset: at, max: most, wait, base64})
}

/** JobsCore.read_plan: options first (`--wait-ms N`, `--base64`, `--`), then the positionals. */
export function readPlan(args: readonly string[], wait = 0, base64 = false): Result<ReadPlan> {
  for (let i = 0; ; ) {
    const a = args[i]
    if (a === '--wait-ms' && i + 1 < args.length) {
      const ms = waitOf(args[i + 1]!)
      if (!ms.ok) return ms
      wait = ms.value
      i += 2
    } else if (a === '--base64') {
      base64 = true
      i += 1
    } else if (a === '--') {
      return positional(args.slice(i + 1), wait, base64)
    } else {
      return positional(args.slice(i), wait, base64)
    }
  }
}

// ---------------------------------------------------------------------------
// Labels (native/Cli.bend's label_checked, which `__start` applies again).

export const labelMax = 120
export const LABEL_ERROR = 'label must be 1..120 printable characters on one line'

/** C0 and C1 controls, DEL and the Unicode line and paragraph separators are not printable. */
export const printable = (code: number) => code >= 32 && code !== 127 && (code < 128 || code > 159) && code !== 8232 && code !== 8233

/** A job label: 1..120 Unicode scalars, printable, on one line. */
export function labelChecked(text: string): Result<string> {
  const codes = cps(text).map((c) => c.codePointAt(0)!)
  return codes.length >= 1 && codes.length <= labelMax && codes.every(printable) ? done(text) : fail(2, LABEL_ERROR)
}

/** An empty label means none; any other label must pass labelChecked. */
export const optionalLabel = (text: string): Result<string> => (text === '' ? done('') : labelChecked(text))

// ---------------------------------------------------------------------------
// The worker's event ring: the 64 newest events, newest first, each with the
// next sequence number (from 1, never reused).

export const ringSize = 64

export type Ring = {next: number; newest: string[]}

export function event(ring: Ring, kind: string, data: string): Ring {
  const line = `{"sequence":${ring.next},"type":${quote(kind)},"data":${data}}`
  return {next: (ring.next + 1) >>> 0, newest: [line, ...ring.newest.slice(0, ringSize - 1)]}
}

/** events.jsonl: the retained events, oldest first, one per line. */
export const lines = (ring: Ring) => [...ring.newest].reverse().map((l) => l + '\n').join('')

export const startedRing = (id: string, m: string) => event({next: 1, newest: []}, 'job.started', `{"id":${quote(publicId(id, m))}}`)

/** Bytes a worker's argv entry may take (posix.c's bound on every argument of the re-entry). */
export const workerArgMax = 4096

/**
 * Whether a session child's command would have reached its worker: 0.8.1
 * passed it in the worker's own argv, whose every entry the supervisor
 * bounds (at most 4096 bytes, no NUL). One that would not never started.
 */
export const reachesWorker = (argv: readonly string[]): boolean => argv.every((a) => !a.includes('\0') && utf8Bytes(a) <= workerArgMax)

// ---------------------------------------------------------------------------
// The worker's save cadence. A change is saved at once when the last save is
// saveInterval ticks old, and otherwise within saveInterval - 1 further ticks;
// each rewrite copies every retained event, so chatty jobs publish at this
// rate. A finishing tick skips this save: the terminal save that follows
// covers it.
//
// Ticks are at least tickMs (25 ms) apart, and the rest after a tick is
// exactly tickMs while that tick changed the ring or a change is unsaved, so
// the cadence holds in time as in ticks: a change is on disk within
// (saveInterval - 1) * tickMs = 75 ms of the tick that saw it. A quiet worker
// rests longer, 50 ms then restMaxMs (100 ms), and the worker ends a rest
// early, on the next tickMs boundary from its start, once its child writes or
// its result is in, so output is seen within 25 ms however long the job was
// quiet, as 0.8.1's fixed ticks saw it. Only the stop marker and the owner's
// death, which nothing announces, wait for the rest to end.

/** Ticks between event-file rewrites. */
export const saveInterval = 4
/** The shortest rest between ticks, and every rest while a change is pending. */
export const tickMs = 25
/** The longest rest of a quiet worker. */
export const restMaxMs = 100
/** Quiet ticks counted (the rest stops growing there). */
export const quietMax = 2

/** Whether the ring holds events not yet saved, the ticks since the last save, and the quiet ticks in a row. */
export type Pending = {unsaved: boolean; age: number; quiet: number}

/** Before the first tick: as if the last save were old, so the first output is saved at once. */
export const firstPending: Pending = {unsaved: false, age: saveInterval, quiet: 0}

export const saveDue = (p: Pending, changed: boolean, finished: boolean) => (p.unsaved || changed) && !finished && p.age >= saveInterval

export const afterTick = (p: Pending, changed: boolean, saved: boolean): Pending => ({
  unsaved: saved ? false : p.unsaved || changed,
  age: saved ? 1 : Math.min(p.age + 1, saveInterval),
  quiet: changed ? 0 : Math.min(p.quiet + 1, quietMax),
})

/** The rest after a tick, from the state it left: tickMs while anything is pending or moved, then 50 and 100 ms. */
export const restMs = (p: Pending) => (p.unsaved || p.quiet === 0 ? tickMs : p.quiet === 1 ? 2 * tickMs : restMaxMs)

/**
 * The rest of a job whose every reason to look again rings its observer
 * (`announced`: output, the result and a stop, as for serve's in-process
 * session children, which no marker or owner needs polling for): once it is
 * quiet with nothing unsaved, until something rings (null). Otherwise restMs.
 */
export const restFor = (p: Pending, announced: boolean): number | null => (announced && !p.unsaved && p.quiet === quietMax ? null : restMs(p))

// ---------------------------------------------------------------------------
// Polling the job's files from another process (start's ready marker, wait
// and stop's receipt): first after 1, 2, 5 and 10 ms, then every tick, so a
// short job is seen at once and a long one costs a read per 25 ms. The
// ceiling is in time, the 25 ms ticks of 0.8.1's fuel.

const POLL_STEPS = [1, 2, 5, 10]
/** The pause before poll `n` (from 0). */
export const pollDelay = (n: number) => POLL_STEPS[n] ?? tickMs

/** One tick per 25 ms of the deadline, plus slack for the final drain. */
export const controlFuel = (timeout: number) => (Math.floor(timeout / 25) + 4096) >>> 0
