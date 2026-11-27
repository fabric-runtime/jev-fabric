// The safe core's small policies (native/Core.bend): the evaluation budget,
// terminal states, what a receipt asks for next, the float distribution
// checks, the monitor's line filter and its bounded batch.
//
// Pure: no IO. The budget is what every Jev and decision call reserves from
// before it dispatches; laws/jev.ts proves its laws and holds it to this code.

import {cpLength, cpTake, trim} from '../codec/text.ts'

export type Budget = {remaining: number; evaluations: number; tokens: number; limit: number}

export const budget = (calls: number, limit: number): Budget => ({remaining: calls, evaluations: 0, tokens: 0, limit})

// One evaluation reserved: a call left and the reported tokens below the
// limit. An exhausted budget never reserves.
export function reserve(b: Budget): Budget | null {
  if (b.remaining === 0) return null
  if (!(b.tokens < b.limit)) return null
  return {remaining: b.remaining - 1, evaluations: b.evaluations + 1, tokens: b.tokens, limit: b.limit}
}

export const account = (b: Budget, reported: number): Budget => ({...b, tokens: b.tokens + reported})

export const within = (b: Budget): boolean => b.tokens <= b.limit

export type State = 'running' | 'completed' | 'attention' | 'failed' | 'cancelled' | 'timedOut'

// A state settles once: only a running one takes the result.
export const settle = (state: State, result: State): State => (state === 'running' ? result : state)

export type Receipt = 'executed' | 'stale' | 'blocked' | 'unknown'
export type Next = 'verify' | 'reobserve' | 'escalate' | 'inspect'

export function after(receipt: Receipt): Next {
  switch (receipt) {
    case 'executed':
      return 'verify'
    case 'stale':
      return 'reobserve'
    case 'blocked':
      return 'escalate'
    case 'unknown':
      return 'inspect'
  }
}

// ---- F32 distributions (Core's float checks; the wire uses exact decimals) -----

const f32 = Math.fround

export const probability = (n: number): boolean => f32(n) >= 0 && f32(n) <= 1
export const noul = (value: number): boolean => probability(value)

export type Probability = {key: string; value: number}

const count = (keys: readonly string[], key: string) => keys.filter((k) => k === key).length
const unique = (keys: readonly string[]) => keys.every((k, i) => count(keys.slice(i + 1), k) === 0)

function mass(rows: readonly Probability[]): number {
  let m = 0
  for (let i = rows.length - 1; i >= 0; i--) m = f32(f32(rows[i]!.value) + m)
  return m
}

export function distribution(keys: readonly string[], rows: readonly Probability[]): boolean {
  const actual = rows.map((r) => r.key)
  return (
    unique(keys) &&
    unique(actual) &&
    keys.length === actual.length &&
    keys.every((k) => count(actual, k) === 1) &&
    rows.every((r) => probability(r.value)) &&
    f32(Math.abs(f32(mass(rows) - 1))) <= f32(0.02)
  )
}

export function choice(keys: readonly string[], selected: string, confidence: number, rows: readonly Probability[]): boolean {
  return keys.length >= 1 && keys.length <= 255 && count(keys, selected) === 1 && probability(confidence) && distribution(keys, rows)
}

// "n-1", ..., "0", as Core.indexes lists them.
const indexes = (n: number): string[] => Array.from({length: n}, (_, i) => String(n - 1 - i))

export function score(levels: number, value: number, confidence: number, rows: readonly Probability[]): boolean {
  return (
    levels >= 2 &&
    levels <= 10 &&
    f32(value) >= 0 &&
    f32(value) <= f32(Math.max(0, levels - 1)) &&
    probability(confidence) &&
    distribution(indexes(levels), rows)
  )
}

// ---- The monitor's line filter and bounded batch ---------------------------------

// A trimmed, non-empty line containing `literal`, unless it repeats the last.
export function monitor(line: string, literal: string, previous: string): string | null {
  const text = trim(line)
  return text !== '' && text.includes(literal) && text !== previous ? text : null
}

export type Batch = {lines: string[]; omitted: number; clipped: number}

export const BATCH_LINE_MAX = 100

// Newest first; lines clipped to 100 characters; the oldest beyond capacity dropped.
export function batchPush(b: Batch, line: string, capacity: number): Batch {
  const next = [cpTake(line, BATCH_LINE_MAX), ...b.lines]
  return {
    lines: next.slice(0, capacity),
    omitted: b.omitted + (next.length > capacity ? 1 : 0),
    clipped: b.clipped + (cpLength(line) > BATCH_LINE_MAX ? 1 : 0),
  }
}
