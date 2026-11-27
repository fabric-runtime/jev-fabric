// `read` and `write` on a job's streams (native/Spool.bend): raw bytes of one
// stream from a byte offset, with an optional long poll, and writes queued
// for an interactive job's worker. Every failure is returned, never fatal, so
// `serve` can call these in process. Policy (which bytes, loss, UTF-8 hold
// back, the record) lives in ./core.ts.

import {closeSync, fstatSync, readSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Jobs from '../jobs/core.ts'
import * as Host from '../store/host.ts'
import * as L from '../sys/libc.ts'
import * as Core from './core.ts'

const now = () => performance.now()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function attempt<T>(f: () => T): Result<T> {
  try {
    return done(f())
  } catch (e) {
    return fail(L.errnoOf(e), 'native file operation failed')
  }
}

/** File.read_at: up to `length` bytes from `offset` (fewer at the end of the file). */
export function readAt(fd: number, offset: number, length: number): Uint8Array {
  const out = Buffer.alloc(length)
  let used = 0
  while (used < length) {
    const got = readSync(fd, out, used, length - used, offset + used)
    if (got <= 0) break
    used += got
  }
  return out.subarray(0, used)
}

/** A rolling spool's header. */
export const headOf = (fd: number): Result<Core.Head> => attempt(() => Core.head(readAt(fd, 0, Core.headSize)))

/** The bytes of a span of a rolling spool, in one read or two when they wrap around the ring. */
export function ringBytes(fd: number, start: number, length: number): Result<Uint8Array> {
  if (length === 0) return done(new Uint8Array())
  return attempt(() => Buffer.concat(Core.slices(start, length).map((s) => readAt(fd, s.at, s.length))))
}

export type Seen = {start: number; omitted: number; bytes: Uint8Array; ended: boolean}

/**
 * A rolling spool: the requested span of what the header says was written.
 * The writer may have wrapped over its start while it was read: the header
 * read afterwards says how much, and those bytes are disclosed as omitted.
 */
function rollingLook(fd: number, offset: number, max: number): Result<Seen> {
  const first = headOf(fd)
  if (!first.ok) return first
  const span = Core.span(Core.oldest(first.value.count), first.value.count, offset, max)
  const bytes = ringBytes(fd, span.start, span.length)
  if (!bytes.ok) return bytes
  const after = headOf(fd)
  if (!after.ok) return after
  const length = bytes.value.length
  const lost = Core.overwritten(span.start, length, after.value.count)
  return done({
    start: span.start + lost,
    omitted: span.omitted + lost,
    bytes: bytes.value.subarray(lost),
    ended: Core.ended(after.value.closed, span.start + length, after.value.count),
  })
}

/** A batch spool: the first 1 MiB, as plain bytes. */
function plainLook(fd: number, offset: number, max: number, finished: boolean): Result<Seen> {
  return attempt(() => {
    const count = Math.min(fstatSync(fd).size, Core.ring)
    const span = Core.span(0, count, offset, max)
    const bytes = span.length === 0 ? new Uint8Array() : readAt(fd, span.start, span.length)
    return {start: span.start, omitted: 0, bytes, ended: Core.ended(finished, span.start + span.length, count)}
  })
}

// ---------------------------------------------------------------------------
// The job's state, read without writing anything: a dead worker without a
// receipt reads as failed, as `status` would report it.

export type Status = {state: string; terminal: boolean}

/** Spool.status: the receipt's state, "starting" before ready, else the lease decides. */
export function status(id: string): Result<Status> {
  const receipt = Host.read(id, 'receipt.json', 1048576)
  if (!receipt.ok) return receipt
  if (receipt.value !== '') return done({state: Jobs.receiptState(receipt.value), terminal: true})
  const ready = Host.read(id, 'ready', 16)
  if (!ready.ok) return ready
  if (ready.value === '') return done({state: 'starting', terminal: false})
  const alive = Host.probe(id)
  if (!alive.ok) return alive
  return done(alive.value === '1' ? {state: 'running', terminal: false} : {state: 'failed', terminal: true})
}

const terminal = (s: Result<Status>) => s.ok && s.value.terminal

// ---------------------------------------------------------------------------
// The long poll.

type Poll = {k: 'polling'} | {k: 'answered'; look: Seen} | {k: 'failed'; error: {code: number; message: string}}

function iteration(fd: number, rolling: boolean, id: string, offset: number, max: number): Result<Seen> {
  return rolling ? rollingLook(fd, offset, max) : plainLook(fd, offset, max, terminal(status(id)))
}

function decided(look: Result<Seen>, elapsed: number, wait: number): Poll {
  if (!look.ok) return {k: 'failed', error: look.error}
  const kept = Core.kept(look.value.bytes, look.value.ended)
  const answer = Core.answerNow(elapsed >= wait, kept.length > 0, look.value.ended)
  return answer ? {k: 'answered', look: {...look.value, bytes: kept}} : {k: 'polling'}
}

function recorded(stated: Result<Status>, look: Seen, publicId: string, stream: string, encoded: boolean): Result<string> {
  if (!stated.ok) return stated
  const eof = look.ended || (stated.value.terminal && look.bytes.length === 0)
  return done(Core.record({id: publicId, stream, start: look.start, omitted: look.omitted, bytes: look.bytes, eof, state: stated.value.state}, encoded))
}

async function readOpen(fd: number, rolling: boolean, id: string, publicId: string, stream: string, offset: number, max: number, wait: number, encoded: boolean): Promise<Result<string>> {
  try {
    const started = now()
    let state = decided(iteration(fd, rolling, id, offset, max), 0, wait)
    // Fuel: one look per millisecond of the ceiling at most, plus two.
    for (let fuel = wait + 2; state.k === 'polling'; fuel--) {
      if (fuel === 0) {
        state = decided(iteration(fd, rolling, id, offset, max), wait, wait)
        break
      }
      await sleep(Core.interval(now() - started))
      const look = iteration(fd, rolling, id, offset, max)
      state = decided(look, now() - started, wait)
    }
    if (state.k === 'failed') return {ok: false, error: state.error}
    if (state.k === 'polling') return fail(1, 'read ended without an answer')
    return recorded(status(id), state.look, publicId, stream, encoded)
  } finally {
    try {
      closeSync(fd)
    } catch {}
  }
}

/** A rolling spool (`<stream>.ring`) if the job has one, else the batch spool. */
function openStream(id: string, stream: string): Result<[number, boolean]> {
  const ring = Host.open(id, `${stream}.ring`)
  if (ring.ok) return done([ring.value, true])
  const plain = Host.open(id, `${stream}.bin`)
  return plain.ok ? done([plain.value, false]) : fail(22, 'job has no output to read yet')
}

/**
 * Spool.read: up to `max` bytes of `stream` ("stdout" or "stderr") of the job
 * in directory `id`, from `offset`; with `wait` > 0, a long poll of up to that
 * many ms. The record, or the failure.
 */
export async function read(id: string, stream: string, offset: number, max: number, wait: number, encoded: boolean): Promise<Result<string>> {
  const checked = Host.storeAttempt(false)
  if (!checked.ok) return checked
  const meta = Host.read(id, 'meta.json', Jobs.metaLimit)
  if (!meta.ok) return meta
  const opened = openStream(id, stream)
  if (!opened.ok) return opened
  return readOpen(opened.value[0], opened.value[1], id, Jobs.publicId(id, meta.value), stream, offset, max, wait, encoded)
}

// ---------------------------------------------------------------------------
// Writes to an interactive job (`start --input pipe`): queued for its worker.

function enqueued(result: Result<string>, id: string, bytes: number, close: boolean): Result<string> {
  if (!result.ok) {
    if (result.error.code === L.E.EPIPE) return close ? done(Jobs.writeJson(id, 0, true)) : fail(1, 'job input is closed')
    if (result.error.code === L.E.ENOSPC) return fail(1, 'job input queue is full: 1 MiB is waiting for the child to read it')
    return result
  }
  return done(close ? Jobs.writeJson(id, 0, true) : Jobs.writeJson(id, bytes, false))
}

/**
 * Spool.queue_write: appends `text` to an interactive job's input, or with
 * `close` ends its input (idempotent). A write record, or the failure.
 */
export function queueWrite(dir: string, text: string, close: boolean): Result<string> {
  const checked = Host.storeAttempt(true)
  if (!checked.ok) return checked
  const meta = Host.read(dir, 'meta.json', Jobs.metaLimit)
  if (!meta.ok) return meta
  if (!Jobs.metaInteractive(meta.value)) return fail(22, 'job was not started with --input pipe')
  const stated = status(dir)
  if (!stated.ok) return stated
  const id = Jobs.publicId(dir, meta.value)
  if (stated.value.terminal) return close ? done(Jobs.writeJson(id, 0, true)) : fail(1, 'job has finished')
  return enqueued(Host.enqueue(dir, text, close, Jobs.queueMax), id, Jobs.utf8Bytes(text), close)
}
