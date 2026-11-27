// The `watch` driver (native/Monitor.bend): an effect interpreter only. Every
// framing, filtering and stop decision lives in ./core.ts; this reads the
// job's events and receipt every 25 ms, prints what the core emits, and ends
// with one monitor.end record.

import type {Result} from '../codec/result.ts'
import * as Host from '../store/host.ts'
import * as Policy from './core.ts'

/** Where each record goes (one line of stdout, without its newline). */
export type Out = (line: string) => void
/** The verb's end: 0, or the code and message 0.8.1 died with. */
export type Exit = {code: number; error?: string}

/** Largest events or receipt file read per poll. */
export const READ_LIMIT = 1048576
const TICK_MS = 25

class Die extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}
function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Die(r.error.code, r.error.message)
  return r.value
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const clock = () => Date.now()

type Turn = {k: 'again'; model: Policy.Model} | {k: 'end'; model: Policy.Model; reason: string; terminal: boolean}

function emit(step: Policy.Step, out: Out): Policy.Model {
  for (const line of step.outs) out(line)
  return step.model
}

function finalize(model: Policy.Model, literal: string, started: number, reason: string, terminal: boolean, out: Out) {
  const drained = emit(Policy.drain(model, literal, terminal), out)
  const s = Policy.summarize(drained)
  out(Policy.endJson(reason, terminal, s.lines, s.batches, drained.losses, Math.max(0, clock() - started)))
}

/** One poll: the events snapshot, then the receipt (so a receipt seen means the final events were read). */
async function tick(id: string, literal: string, started: number, duration: number, model: Policy.Model, out: Out): Promise<Turn> {
  const events = must(Host.read(id, 'events.jsonl', READ_LIMIT))
  const next = emit(Policy.consume(events.split('\n'), model, literal, Policy.BATCH_MAX), out)
  const receipt = must(Host.read(id, 'receipt.json', READ_LIMIT))
  const decision = Policy.decide(Policy.summarize(next), receipt, Math.max(0, clock() - started), duration)
  if (decision.d === 'stop') return {k: 'end', model: next, reason: decision.reason, terminal: decision.terminal}
  await sleep(TICK_MS)
  return {k: 'again', model: next}
}

/**
 * The bounded loop: at most fuel(duration) polls, so it ends even if the
 * clock stalls. An aborted `signal` ends it before the next poll with the
 * reason "cancelled" (serve's use; the CLI never aborts).
 */
async function loop(id: string, literal: string, duration: number, out: Out, signal?: AbortSignal) {
  const started = clock()
  let turn: Turn = {k: 'again', model: Policy.initialModel()}
  for (let remaining = Policy.fuel(duration); turn.k === 'again'; remaining--) {
    if (remaining === 0) return finalize(turn.model, literal, started, 'fuel', false, out)
    if (signal?.aborted) return finalize(turn.model, literal, started, 'cancelled', false, out)
    turn = await tick(id, literal, started, duration, turn.model, out)
  }
  finalize(turn.model, literal, started, turn.reason, turn.terminal, out)
}

/**
 * `watch <id> <duration-ms> <literal>`: filtered, deduplicated line batches
 * from a job's live events until the job is terminal, 1024 lines were
 * emitted, or the duration passes. A watch only reads the store, so it
 * checks the store format without adopting it. Resolves to {code: 0}, or to
 * the code and message 0.8.1 exited with (2 and the usage for a bad duration
 * or literal; a store or job file failure's own code).
 */
export async function watch(id: string, ms: string, literal: string, out: Out, signal?: AbortSignal): Promise<Exit> {
  try {
    must(Host.storeAttempt(false))
    const duration = Policy.validate(ms, literal)
    if (duration === null) return {code: 2, error: Policy.USAGE}
    await loop(id, literal, duration, out, signal)
    return {code: 0}
  } catch (e) {
    if (e instanceof Die) return {code: e.code, error: e.message}
    throw e
  }
}

/** Monitor.command: the canonical `["watch", id, ms, literal]` the CLI hands it. */
export function command(args: readonly string[], out: Out, signal?: AbortSignal): Promise<Exit> {
  if (args.length === 4 && args[0] === 'watch') return watch(args[1]!, args[2]!, args[3]!, out, signal)
  return Promise.resolve({code: 2, error: 'usage: watch <id> <duration-ms> <literal>'})
}
