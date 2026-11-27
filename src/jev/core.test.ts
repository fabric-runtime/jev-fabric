// native/tests/core.bend and proofs.bend's examples, against src/jev/core.ts.

import {expect, test} from 'bun:test'
import * as Core from './core.ts'

const b = (remaining: number, evaluations: number, tokens: number, limit: number): Core.Budget => ({remaining, evaluations, tokens, limit})

test('core.bend assertions', () => {
  const splitAb = [
    {key: 'a', value: 0.75},
    {key: 'b', value: 0.25},
  ]
  const split01 = [
    {key: '0', value: 0.2},
    {key: '1', value: 0.8},
  ]
  const checks = [
    Core.reserve(b(0, 4, 0, 10)) === null,
    Core.reserve(b(1, 0, 10, 10)) === null,
    Core.reserve(b(1, 0, 9, 10)) !== null,
    !Core.within(Core.account(b(1, 0, 9, 10), 2)),
    Core.noul(0),
    Core.noul(1),
    !Core.probability(-0.1),
    !Core.probability(1.1),
    !Core.probability(Number.NaN),
    !Core.probability(Number.POSITIVE_INFINITY),
    Core.choice(['a', 'b'], 'a', 0.9, splitAb),
    !Core.choice(['a', 'b'], 'missing', 0.9, splitAb),
    !Core.choice(['a', 'b'], 'a', 0.9, [
      {key: 'a', value: 0.75},
      {key: 'a', value: 0.25},
    ]),
    !Core.choice(['a'], 'a', 1, [{key: 'a', value: 0.2}]),
    Core.score(2, 0.8, 0.7, split01),
    !Core.score(2, 2, 0.7, split01),
    Core.monitor('quiet', 'STATUS:', '') === null,
    Core.monitor('STATUS: ready', 'STATUS:', 'STATUS: ready') === null,
    Core.monitor('STATUS: ready', 'STATUS:', '') !== null,
  ]
  expect(checks.map((c, i) => (c ? 'ok' : `failed at ${i}`)).filter((c) => c !== 'ok')).toEqual([])
  expect(Core.batchPush({lines: ['b', 'a'], omitted: 0, clipped: 0}, 'c', 2)).toEqual({lines: ['c', 'b'], omitted: 1, clipped: 0})
  const clipped = Core.batchPush({lines: [], omitted: 0, clipped: 0}, '0123456789'.repeat(11), 2)
  expect(clipped.lines[0]!.length).toBe(100)
  expect([clipped.omitted, clipped.clipped]).toEqual([0, 1])
})

test('a reservation spends one call and counts one evaluation; accounting adds tokens', () => {
  expect(Core.reserve(b(3, 1, 5, 10))).toEqual(b(2, 2, 5, 10))
  expect(Core.account(b(2, 2, 5, 10), 4)).toEqual(b(2, 2, 9, 10))
  expect(Core.within(b(0, 0, 10, 10))).toBe(true)
  expect(Core.within(b(0, 0, 11, 10))).toBe(false)
})

test('proofs.bend examples', () => {
  for (const used of [0, 3])
    for (const tokens of [0, 9])
      for (const limit of [0, 10]) expect(Core.reserve(b(0, used, tokens, limit))).toBeNull()
  const states: Core.State[] = ['running', 'completed', 'attention', 'failed', 'cancelled', 'timedOut']
  for (const r of states) {
    expect(Core.settle('cancelled', r)).toBe('cancelled')
    expect(Core.settle('completed', r)).toBe('completed')
    expect(Core.settle('running', r)).toBe(r)
  }
  expect(Core.after('unknown')).toBe('inspect')
  expect(Core.after('executed')).toBe('verify')
})
