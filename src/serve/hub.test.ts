// The hub's bookkeeping (src/serve/hub.ts): the answer ledger, the child and
// queue bounds, the first ending, and a child's feeder applying writes and
// closes in arrival order with one write in flight.

import {describe, expect, test} from 'bun:test'
import * as Core from './core.ts'
import * as Hub from './hub.ts'

describe('the answer ledger', () => {
  test('every accepted request is answered once; answering twice is refused', () => {
    const h = Hub.hub()
    Hub.accept(h)
    Hub.accept(h)
    Hub.answer(h)
    expect([h.open, h.accepted, h.answered]).toEqual([1, 2, 1])
    Hub.answer(h)
    expect(() => Hub.answer(h)).toThrow()
  })

  test('the session concludes only once ending, with nothing open and every child settled', () => {
    const h = Hub.hub()
    Hub.accept(h)
    Hub.starting(h, 'a')
    expect(Hub.conclude(h)).toBe(false)
    expect(Hub.end(h, 0, '')).toBe(true)
    expect(Hub.end(h, 124, 'late')).toBe(false)
    expect(h.ending).toEqual({code: 0, message: ''})
    expect(() => Hub.accept(h)).toThrow()
    Hub.answer(h)
    expect(Hub.conclude(h)).toBe(false)
    Hub.exited(h, 'a')
    expect(Hub.conclude(h)).toBe(true)
  })
})

describe('bounds', () => {
  test('16 running children; a finished one makes room before its worker exits', () => {
    const h = Hub.hub()
    for (let i = 0; i < Core.CHILDREN_MAX; i++) Hub.starting(h, `c${i}`)
    expect(Hub.room(h)).toBe(false)
    expect(() => Hub.starting(h, 'extra')).toThrow()
    Hub.finished(h, 'c0')
    expect(Hub.room(h)).toBe(true)
    expect(Hub.settled(h)).toBe(false)
  })

  test('64 queued requests per child; each applied one frees a place', () => {
    const h = Hub.hub()
    Hub.starting(h, 'a')
    for (let i = 0; i < Core.PENDING_MAX; i++) expect(Hub.queue(h, 'a')).toBe(true)
    expect(Hub.queue(h, 'a')).toBe(false)
    Hub.fed(h, 'a')
    expect(Hub.queue(h, 'a')).toBe(true)
    expect(Hub.queue(h, 'missing')).toBe(false)
  })

  test('a child is addressable only once it has announced itself', () => {
    const h = Hub.hub()
    Hub.starting(h, 'a')
    expect(Hub.addressed(h, 'a')).toBe(null)
    Hub.ready(h, 'a')
    expect(Hub.addressed(h, 'a')).not.toBe(null)
  })
})

describe('a child feeder', () => {
  const kinds = (fx: Hub.Effect<number>[]) => fx.map((e) => (e.e === 'respond' ? `respond ${e.id}${e.error ? ' error' : ''}${e.closed ? ' closed' : ''}` : e.e === 'write' ? `write ${e.id}` : 'close'))

  test('writes start in arrival order, one in flight; a close waits its turn', () => {
    const f = Hub.feeder<number>(true)
    expect(kinds(Hub.arrive(f, {kind: 'write', id: 1, text: 'a'}))).toEqual(['write 1'])
    expect(kinds(Hub.arrive(f, {kind: 'write', id: 2, text: 'b'}))).toEqual([])
    expect(kinds(Hub.arrive(f, {kind: 'close', id: 3}))).toEqual([])
    expect(kinds(Hub.arrive(f, {kind: 'write', id: 4, text: 'c'}))).toEqual([])
    expect(kinds(Hub.wrote(f, 1, true, 1))).toEqual(['respond 1', 'write 2'])
    expect(kinds(Hub.wrote(f, 2, true, 1))).toEqual(['respond 2', 'close', 'respond 3 closed', 'respond 4 error'])
    expect(kinds(Hub.arrive(f, {kind: 'close', id: 5}))).toEqual(['respond 5 closed'])
  })

  test('a failed write answers that the child is gone; later writes try again', () => {
    const f = Hub.feeder<number>(true)
    Hub.arrive(f, {kind: 'write', id: 1, text: 'a'})
    Hub.arrive(f, {kind: 'write', id: 2, text: 'b'})
    const fx = Hub.wrote(f, 1, false, 1)
    expect(fx[0]).toEqual({e: 'respond', id: 1, error: Core.GONE, closed: false, bytes: 1})
    expect(kinds(fx)).toEqual(['respond 1 error', 'write 2'])
  })

  test('stdin "null" refuses every write; the ending closes stdin once idle', () => {
    const n = Hub.feeder<number>(false)
    expect(Hub.arrive(n, {kind: 'write', id: 1, text: 'a'})).toEqual([{e: 'respond', id: 1, error: Core.CLOSED, closed: false, bytes: 0}])
    const f = Hub.feeder<number>(true)
    Hub.arrive(f, {kind: 'write', id: 1, text: 'a'})
    expect(kinds(Hub.ending(f))).toEqual([])
    expect(kinds(Hub.wrote(f, 1, false, 1))).toEqual(['respond 1 error', 'close'])
    expect(f.released).toBe(true)
  })
})

describe('in-process supervision', () => {
  test("a child's group is listed from its start until it is reaped, once; it leaves supervision only after", () => {
    const h = Hub.hub()
    Hub.starting(h, 'a')
    Hub.starting(h, 'b')
    expect(() => Hub.reaped(h, 'a')).toThrow()
    Hub.spawned(h, 'a')
    expect(() => Hub.spawned(h, 'a')).toThrow()
    expect(Hub.listed(h)).toEqual(['a'])
    expect(() => Hub.exited(h, 'a')).toThrow()
    Hub.reaped(h, 'a')
    expect(() => Hub.reaped(h, 'a')).toThrow()
    expect(Hub.listed(h)).toEqual([])
    Hub.exited(h, 'a')
    // A child that never started has no group to reap.
    Hub.exited(h, 'b')
    expect(() => Hub.spawned(h, 'b')).toThrow()
    Hub.end(h, 0, '')
    expect(Hub.conclude(h)).toBe(true)
    expect(Hub.listed(h)).toEqual([])
  })

  test('no child starts once the session is ending; only started children are listed and removed', () => {
    const h = Hub.hub()
    Hub.starting(h, 'ok')
    Hub.ready(h, 'ok')
    Hub.starting(h, 'never')
    Hub.exited(h, 'never')
    expect(Hub.started(h)).toEqual(['ok'])
    Hub.end(h, 0, '')
    expect(() => Hub.starting(h, 'late')).toThrow()
  })
})
