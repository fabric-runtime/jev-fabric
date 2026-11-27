// Bounded watch policy (native/MonitorCore.bend). Pure: framing, the line
// filter, deduplication, batching, loss accounting and the stop decision.
// The driver (./monitor.ts) reads a job's events and receipt and prints what
// this decides. Observations are lossy and sequence-cursored, never semantic
// task completion. No Jev calls or notifiers.
//
// Limits: 4096 characters per partial line, 32 lines per batch, 1024 emitted
// lines per stream, a 1..300000 ms watch, a 1..256 character literal, and a
// 1 MiB events snapshot per poll. A sequence gap (the job's event ring
// evicted records) or omitted spool bytes reset the affected partial lines
// and emit an explicit monitor.loss record before continuing.

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import {boolean, quote} from '../codec/print.ts'
import {cpLength, cpTake} from '../codec/text.ts'
import * as JevCore from '../jev/core.ts'
import {readU32} from '../time/core.ts'

export type Line = {text: string; clipped: boolean}
export type Frame = {partial: string; clipped: boolean}
/** Matched lines not yet emitted, newest first. `omitted` stays 0, as in 0.8.1. */
export type Pending = {lines: Line[]; omitted: number; clipped: number}
export type Channel = {frame: Frame; pending: Pending; previous: string; from: number; to: number; emitted: number; batches: number}
export type Model = {last: number; out: Channel; err: Channel; losses: number; finished: boolean}
export type Reading = {sequence: number; kind: string; data: Json}
export type Framed = {frame: Frame; lines: Line[]}
export type Produced = {channel: Channel; outs: string[]}
export type Step = {model: Model; outs: string[]}
export type Summary = {model: Model; finished: boolean; lines: number; batches: number}

export const LINE_MAX = 4096
export const BATCH_MAX = 32
export const TOTAL_MAX = 1024
export const DURATION_MAX = 300000
export const LITERAL_MAX = 256

export const emptyFrame = (): Frame => ({partial: '', clipped: false})
export const emptyChannel = (): Channel => ({frame: emptyFrame(), pending: {lines: [], omitted: 0, clipped: 0}, previous: '', from: 0, to: 0, emitted: 0, batches: 0})
export const initialModel = (): Model => ({last: 0, out: emptyChannel(), err: emptyChannel(), losses: 0, finished: false})

/** Natural subtraction, as Bend's Nat.sub. */
const sub = (a: number, b: number) => (a > b ? a - b : 0)

// ---------------------------------------------------------------------------
// Framing.

/** Appends to a partial line, clipping at `max` characters. A clipped line ignores further input. */
export function bounded(text: string, clipped: boolean, addition: string, max: number): Line {
  if (clipped) return {text, clipped: true}
  const have = cpLength(text)
  if (have + cpLength(addition) <= max) return {text: text + addition, clipped: false}
  return {text: text + cpTake(addition, sub(max, have)), clipped: true}
}

/** Every piece but the last completes a line; the last stays partial. */
export function framed(parts: readonly string[], frame: Frame, max: number): Framed {
  const lines: Line[] = []
  let current = frame
  for (let i = 0; i < parts.length; i++) {
    const line = bounded(current.partial, current.clipped, parts[i]!, max)
    if (i === parts.length - 1) return {frame: {partial: line.text, clipped: line.clipped}, lines}
    lines.push(line)
    current = emptyFrame()
  }
  return {frame: current, lines}
}

/** A chunk after a loss starts from an empty frame: the broken partial line is dropped. */
export const frameChunk = (frame: Frame, text: string, loss: boolean, max: number): Framed =>
  framed(text.split('\n'), loss ? emptyFrame() : frame, max)

// ---------------------------------------------------------------------------
// Records.

export const lineJson = (l: Line) => `{"text":${quote(l.text)},"clipped":${boolean(l.clipped)}}`

export const batchJson = (stream: string, from: number, to: number, omitted: number, clipped: number, lines: readonly Line[]) =>
  `{"type":"monitor.batch","stream":${quote(stream)},"first":${from},"last":${to},"omitted":${omitted},"clipped":${clipped},"lines":[${lines.map(lineJson).join(',')}]}`

export const lossJson = (stream: string, reason: string, count: number) =>
  `{"type":"monitor.loss","stream":${quote(stream)},"reason":${quote(reason)},"count":${count}}`

export const endJson = (reason: string, terminal: boolean, lines: number, batches: number, losses: number, elapsed: number) =>
  `{"type":"monitor.end","reason":${quote(reason)},"terminal":${boolean(terminal)},"lines":${lines},"batches":${batches},"losses":${losses},"elapsedMs":${elapsed}` +
  `,"outputLimitReached":${boolean(lines >= TOTAL_MAX)},"note":"matched lines are observations, not semantic completion"}`

// ---------------------------------------------------------------------------
// Channels: one per stream.

/** Emits any pending lines, oldest first, as one monitor.batch record. */
export function flush(stream: string, c: Channel): Produced {
  if (c.pending.lines.length === 0) return {channel: c, outs: []}
  const record = batchJson(stream, c.from, c.to, c.pending.omitted, c.pending.clipped, [...c.pending.lines].reverse())
  return {channel: {...c, pending: {lines: [], omitted: 0, clipped: 0}, from: 0, to: 0, batches: c.batches + 1}, outs: [record]}
}

/** The filter, only while the stream has emitted fewer than TOTAL_MAX lines. */
export const limitedMatch = (text: string, literal: string, previous: string, allowed: boolean): string | null =>
  allowed ? JevCore.monitor(text, literal, previous) : null

/**
 * One complete line: a trimmed match that does not repeat the stream's last
 * kept line is pending at `sequence`; `batch` pending lines are flushed.
 */
export function push(stream: string, c: Channel, line: Line, sequence: number, literal: string, batch: number): Produced {
  const kept = limitedMatch(line.text, literal, c.previous, c.emitted < TOTAL_MAX)
  if (kept === null) return {channel: c, outs: []}
  const lines = [{text: kept, clipped: line.clipped}, ...c.pending.lines]
  const more: Channel = {
    frame: c.frame,
    pending: {lines, omitted: c.pending.omitted, clipped: c.pending.clipped + (line.clipped ? 1 : 0)},
    previous: kept,
    from: c.from === 0 ? sequence : c.from,
    to: sequence,
    emitted: c.emitted + 1,
    batches: c.batches,
  }
  return lines.length >= batch ? flush(stream, more) : {channel: more, outs: []}
}

export function pushAll(lines: readonly Line[], stream: string, c: Channel, sequence: number, literal: string, batch: number): Produced {
  const outs: string[] = []
  let channel = c
  for (const line of lines) {
    const p = push(stream, channel, line, sequence, literal, batch)
    channel = p.channel
    outs.push(...p.outs)
  }
  return {channel, outs}
}

export function feed(stream: string, c: Channel, text: string, sequence: number, literal: string, batch: number, loss: boolean): Produced {
  const split = frameChunk(c.frame, text, loss, LINE_MAX)
  return pushAll(split.lines, stream, {...c, frame: split.frame}, sequence, literal, batch)
}

const resetFrame = (c: Channel): Channel => ({...c, frame: emptyFrame()})

// ---------------------------------------------------------------------------
// Events.

const num = (v: Json | undefined): number => (v !== undefined && v.t === 'num' ? (readU32(v.lex) ?? 0) : 0)
const str = (v: Json | undefined): string => (v === undefined ? '' : (Codec.text(v) ?? ''))
export const numberField = (record: Json, key: string) => num(Codec.field(record, key))
export const textField = (record: Json, key: string) => str(Codec.field(record, key))

/** An event line as the job's ring wrote it, or null for one that is not strict JSON. */
export function readEvent(line: string): Reading | null {
  const parsed = Codec.read(line)
  if (!parsed.ok) return null
  const value = parsed.value
  return {sequence: numberField(value, 'sequence'), kind: textField(value, 'type'), data: Codec.field(value, 'data') ?? Codec.NULL}
}

const channelOf = (isErr: boolean, m: Model) => (isErr ? m.err : m.out)
const withChannel = (isErr: boolean, m: Model, c: Channel): Model => (isErr ? {...m, err: c} : {...m, out: c})
const addLoss = (m: Model): Model => ({...m, losses: m.losses + 1})

/**
 * Omitted spool bytes break line framing: the partial line is dropped, one
 * loss is counted and a monitor.loss record precedes the batches produced
 * from this chunk.
 */
export function outputChannel(isErr: boolean, m: Model, text: string, omitted: number, literal: string, batch: number): Step {
  const lossy = omitted !== 0
  const stream = isErr ? 'stderr' : 'stdout'
  const fed = feed(stream, channelOf(isErr, m), text, m.last, literal, batch, lossy)
  const model = withChannel(isErr, lossy ? addLoss(m) : m, fed.channel)
  return {model, outs: lossy ? [lossJson(stream, 'omitted-bytes', omitted), ...fed.outs] : fed.outs}
}

export function dispatchOutput(m: Model, data: Json, literal: string, batch: number): Step {
  const stream = textField(data, 'stream')
  const text = textField(data, 'text')
  const omitted = numberField(data, 'omittedBytes')
  if (stream === 'stderr') return outputChannel(true, m, text, omitted, literal, batch)
  if (stream === 'stdout') return outputChannel(false, m, text, omitted, literal, batch)
  return {model: m, outs: []}
}

export function dispatch(m: Model, kind: string, data: Json, literal: string, batch: number): Step {
  if (kind === 'process.output') return dispatchOutput(m, data, literal, batch)
  if (kind === 'job.finished') return {model: {...m, finished: true}, outs: []}
  if (kind === 'process.spool_limit') return {model: addLoss(m), outs: [lossJson(textField(data, 'stream'), 'spool-limit', 0)]}
  return {model: m, outs: []}
}

/**
 * Moves the cursor to `sequence`. A gap means the job's event ring evicted
 * records: both partial lines are dropped and one loss is counted.
 */
export const advance = (m: Model, sequence: number, gap: boolean): Model =>
  gap ? {...m, last: sequence, out: resetFrame(m.out), err: resetFrame(m.err), losses: m.losses + 1} : {...m, last: sequence}

/** Only events past the cursor are applied; replays of older sequences are ignored. */
export function handle(m: Model, r: Reading, literal: string, batch: number): Step {
  if (!(r.sequence > m.last)) return {model: m, outs: []}
  const expected = (m.last + 1) >>> 0
  const gap = r.sequence > expected
  const result = dispatch(advance(m, r.sequence, gap), r.kind, r.data, literal, batch)
  return {model: result.model, outs: gap ? [lossJson('*', 'replay-eviction', sub(r.sequence, expected)), ...result.outs] : result.outs}
}

export function consumeLine(line: string, m: Model, literal: string, batch: number): Step {
  if (line === '') return {model: m, outs: []}
  const reading = readEvent(line)
  if (reading === null) return {model: addLoss(m), outs: [lossJson('*', 'invalid-event', 0)]}
  return handle(m, reading, literal, batch)
}

/** Applies one events snapshot's lines in order. */
export function consume(raw: readonly string[], m: Model, literal: string, batch: number): Step {
  const outs: string[] = []
  let model = m
  for (const line of raw) {
    const s = consumeLine(line, model, literal, batch)
    model = s.model
    outs.push(...s.outs)
  }
  return {model, outs}
}

// ---------------------------------------------------------------------------
// Draining at the end.

export const closeFrame = (f: Frame): Line | null => (f.partial === '' ? null : {text: f.partial, clipped: f.clipped})

/**
 * On a terminal drain the unterminated partial line is filtered as a final
 * line (at the channel's last pending sequence) before the remaining batch is
 * flushed; otherwise the partial line is dropped.
 */
export function drainChannel(stream: string, c: Channel, literal: string, batch: number, terminal: boolean): Produced {
  const cleared = resetFrame(c)
  const closed = terminal ? closeFrame(c.frame) : null
  if (closed === null) return flush(stream, cleared)
  const pushed = push(stream, cleared, closed, c.to, literal, batch)
  const flushed = flush(stream, pushed.channel)
  return {channel: flushed.channel, outs: [...pushed.outs, ...flushed.outs]}
}

export function drain(m: Model, literal: string, terminal: boolean): Step {
  const out = drainChannel('stdout', m.out, literal, BATCH_MAX, terminal)
  const err = drainChannel('stderr', m.err, literal, BATCH_MAX, terminal)
  return {model: {...m, out: out.channel, err: err.channel}, outs: [...out.outs, ...err.outs]}
}

export const summarize = (m: Model): Summary => ({
  model: m,
  finished: m.finished,
  lines: m.out.emitted + m.err.emitted,
  batches: m.out.batches + m.err.batches,
})

// ---------------------------------------------------------------------------
// Arguments and the loop's decisions.

export const USAGE = 'usage: watch <id> <duration-ms> <literal>; duration 1..300000, literal 1..256 chars'

/** The watch's duration, or null: 1..300000 ms and a literal of 1..256 characters. */
export function validate(ms: string, literal: string): number | null {
  const raw = readU32(ms)
  if (raw === null || raw < 1 || raw > DURATION_MAX) return null
  return literal !== '' && cpLength(literal) <= LITERAL_MAX ? raw : null
}

/** Polls the loop may make: one per 25 ms of its duration, and 64 more. */
export const fuel = (duration: number) => Math.floor(duration / 25) + 64

export type Decision = {d: 'poll'} | {d: 'stop'; reason: 'finished' | 'output-limit' | 'deadline'; terminal: boolean}
export const POLL: Decision = {d: 'poll'}

export const deadlineDecision = (expired: boolean): Decision => (expired ? {d: 'stop', reason: 'deadline', terminal: false} : POLL)
export const limitDecision = (over: boolean, elapsed: number, duration: number): Decision =>
  over ? {d: 'stop', reason: 'output-limit', terminal: false} : deadlineDecision(elapsed >= duration)
export const terminalDecision = (terminal: boolean, lines: number, elapsed: number, duration: number): Decision =>
  terminal ? {d: 'stop', reason: 'finished', terminal: true} : limitDecision(lines >= TOTAL_MAX, elapsed, duration)

/** A finished job (its job.finished event or a receipt) stops the watch first, then the output limit, then the deadline. */
export const decide = (s: Summary, receipt: string, elapsed: number, duration: number): Decision =>
  terminalDecision(s.finished || receipt !== '', s.lines, elapsed, duration)
