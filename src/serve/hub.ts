// The serve hub's bookkeeping (the Hub, Child and Feeder state of
// native/Serve.bend), pure: what the session owns and counts, and every
// admission decision. ./serve.ts runs the effects these decide.
//
// - Every request the hub accepts is answered exactly once: `open` counts
//   accepted requests not yet answered, and the session concludes only once
//   it is ending, nothing is open, and no session child is live or has
//   writes queued.
// - A connection holds at most 16 live session children (one still
//   starting counts), and each child at most 64 queued writes, closes and
//   stops.
// - The first ending wins: its code is the session's exit code, and no line
//   is answered after it.
// - A child's feeder applies writes and closes in arrival order, one write
//   in flight at a time; a stop never waits behind them.
// - Session children are supervised in this process. A child's process
//   group is listed (with the watchdog that stops it should this process
//   die) from the moment it starts until it is reaped, and is reaped at most
//   once; a child leaves supervision only once its group is reaped. So no
//   child survives the conclusion: every group started has been reaped
//   exactly once, and none is left for the watchdog.
//
// Pure: no IO.

import type {Err} from '../codec/result.ts'
import {CHILDREN_MAX, PENDING_MAX} from './core.ts'

/**
 * `live` until its supervision has ended (its group reaped, its receipt
 * published and its lease released); `finished` once its receipt is
 * published. A child counts toward the bound while it is live and not
 * finished. `group`: its process group, not yet started, started (and
 * listed with the watchdog), or reaped.
 */
export type Group = 'none' | 'listed' | 'reaped'
export type Child = {live: boolean; finished: boolean; pending: number; ready: boolean; group: Group}
export type Ending = {code: number; message: string}

export type Hub = {
  /** Session children by directory, in spawn order. */
  children: Map<string, Child>
  /** Accepted requests not yet answered. */
  open: number
  /** Every request accepted, and every answer written (the ledger). */
  accepted: number
  answered: number
  ending: Ending | null
  concluded: boolean
}

export const hub = (): Hub => ({children: new Map(), open: 0, accepted: 0, answered: 0, ending: null, concluded: false})

/** A line is answered only while the session is serving: after an ending the rest are dropped. */
export const serving = (h: Hub): boolean => h.ending === null

/** A request accepted: it will be answered exactly once. */
export function accept(h: Hub): void {
  if (!serving(h)) throw new Error('serve: a request accepted after the session began to end')
  h.open++
  h.accepted++
}

/** A request's one answer. Answering a request twice (or one never accepted) is a programming error. */
export function answer(h: Hub): void {
  if (h.open === 0) throw new Error('serve: an answer without an open request')
  h.open--
  h.answered++
}

/** Running session children: live and not finished, those still starting included. */
export const running = (h: Hub): number => {
  let n = 0
  for (const c of h.children.values()) if (c.live && !c.finished) n++
  return n
}

/** Whether another session child may start. */
export const room = (h: Hub): boolean => running(h) < CHILDREN_MAX

/** A child being spawned (only while serving): live from the moment its directory exists, addressable once ready. */
export function starting(h: Hub, dir: string): void {
  if (!room(h)) throw new Error('serve: a session child started past the bound')
  if (!serving(h)) throw new Error('serve: a session child started after the session began to end')
  h.children.set(dir, {live: true, finished: false, pending: 0, ready: false, group: 'none'})
}

export function ready(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (c) c.ready = true
}

/** The child's receipt is published: it no longer counts toward the bound. */
export function finished(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (c) c.finished = true
}

/** The child's process group has started: listed until it is reaped. Once per child. */
export function spawned(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (!c || !c.live || c.group !== 'none') throw new Error('serve: a session child started twice, or after its supervision ended')
  c.group = 'listed'
}

/** The child's group has been reaped (and killed). Exactly once for a group that started. */
export function reaped(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (!c || c.group !== 'listed') throw new Error('serve: a session child reaped twice, or never started')
  c.group = 'reaped'
}

/** The groups this process still supervises: what the watchdog stops should it die. */
export const listed = (h: Hub): string[] => [...h.children].flatMap(([dir, c]) => (c.group === 'listed' ? [dir] : []))

/** The child's supervision has ended. Never while its group is unreaped. */
export function exited(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (c?.group === 'listed') throw new Error('serve: a session child left supervision with its group unreaped')
  if (c) {
    c.live = false
    c.finished = true
  }
}

/** The child a request may address: one of this connection's, ready. */
export function addressed(h: Hub, dir: string): Child | null {
  const c = h.children.get(dir)
  return c?.ready ? c : null
}

/** Queues one write, close or stop for a child, within its bound; false when it is full. */
export function queue(h: Hub, dir: string): boolean {
  const c = h.children.get(dir)
  if (!c || c.pending >= PENDING_MAX) return false
  c.pending++
  return true
}

/** A queued request for a child has been applied (answered, or for a stop handed on). */
export function fed(h: Hub, dir: string): void {
  const c = h.children.get(dir)
  if (c && c.pending > 0) c.pending--
}

/** The first ending wins; true when this call began it. */
export function end(h: Hub, code: number, message: string): boolean {
  if (h.ending !== null) return false
  h.ending = {code, message}
  return true
}

/** The children's directories, for the ending (stop) and the conclusion (remove). */
export const dirs = (h: Hub): string[] => [...h.children.keys()]

/**
 * The children that started (announced themselves): what `list` with
 * `"scope":"session"` shows and what the conclusion removes. One that never
 * started is forgotten, as 0.8.1 forgot it: unlisted, its directory left.
 */
export const started = (h: Hub): string[] => [...h.children].flatMap(([dir, c]) => (c.ready ? [dir] : []))

/** Whether every child has exited with nothing queued. */
export function settled(h: Hub): boolean {
  for (const c of h.children.values()) if (c.live || c.pending !== 0) return false
  return true
}

/** The session ends once it is ending and nothing is left in flight. */
export const drained = (h: Hub): boolean => h.ending !== null && h.open === 0 && settled(h)

export function conclude(h: Hub): boolean {
  if (!drained(h)) return false
  h.concluded = true
  return true
}

// ---------------------------------------------------------------------------
// One session child's stdin (Serve.bend's feeder): writes and closes wait
// their turn behind a write in flight; a stop is handed on at once.

export type Item<I> = {kind: 'write'; id: I; text: string} | {kind: 'close'; id: I}

export type Feeder<I> = {
  /** The child's stdin: open, or closed (closeInput, `stdin: "null"`). */
  input: 'open' | 'closed'
  /** A write is in flight. */
  busy: boolean
  queue: Item<I>[]
  ending: boolean
  /** Input released for good (the feeder is done). */
  released: boolean
}

/** What the driver does next for a child. */
export type Effect<I> =
  | {e: 'write'; id: I; text: string}
  | {e: 'respond'; id: I; error: Err | null; closed: boolean; bytes: number}
  | {e: 'close'}

export const feeder = <I>(pipe: boolean): Feeder<I> => ({input: pipe ? 'open' : 'closed', busy: false, queue: [], ending: false, released: false})

/** Starts one write or close; the feeder is not busy. */
function apply<I>(f: Feeder<I>, item: Item<I>, out: Effect<I>[]): void {
  if (item.kind === 'write') {
    if (f.input === 'closed') return void out.push({e: 'respond', id: item.id, error: {code: 1, message: 'session child stdin is closed'}, closed: false, bytes: 0})
    f.busy = true
    out.push({e: 'write', id: item.id, text: item.text})
    return
  }
  if (f.input === 'open') out.push({e: 'close'})
  f.input = 'closed'
  out.push({e: 'respond', id: item.id, error: null, closed: true, bytes: 0})
}

/** Starts queued requests in order until one is in flight again. */
function drain<I>(f: Feeder<I>, out: Effect<I>[]): void {
  while (!f.busy && f.queue.length > 0) apply(f, f.queue.shift()!, out)
  if (f.ending && !f.busy && f.queue.length === 0 && !f.released) {
    if (f.input === 'open') out.push({e: 'close'})
    f.input = 'closed'
    f.released = true
  }
}

/** A write or close arrives: it queues behind a write in flight or earlier queued requests. */
export function arrive<I>(f: Feeder<I>, item: Item<I>): Effect<I>[] {
  const out: Effect<I>[] = []
  f.queue.push(item)
  drain(f, out)
  return out
}

/** The write in flight has finished (`ok`: the pipe took every byte). */
export function wrote<I>(f: Feeder<I>, id: I, ok: boolean, bytes: number): Effect<I>[] {
  if (!f.busy) throw new Error('serve: a write finished that was never started')
  f.busy = false
  const out: Effect<I>[] = [{e: 'respond', id, error: ok ? null : {code: 1, message: 'session child is no longer reading its input'}, closed: false, bytes}]
  drain(f, out)
  return out
}

/** The connection is ending: once nothing is in flight or queued, the child's stdin is closed. */
export function ending<I>(f: Feeder<I>): Effect<I>[] {
  const out: Effect<I>[] = []
  f.ending = true
  drain(f, out)
  return out
}
