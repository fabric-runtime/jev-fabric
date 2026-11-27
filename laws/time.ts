// Deadlines (src/time/core.ts, native/tests/time-proofs.bend): a refused
// timeout never becomes a limit, an unset setting is the default, a budget's
// elapsed time is subtracted and never renewed, and a local cap applies
// before narrowing. Each held to the real functions.

import {bool, fun, min, nat, rule, when} from 'gdp-wired'
import * as T from '../src/time/core.ts'
import type {Agreement, Entry} from './kit.ts'
import {rand} from './kit.ts'

// TimeCore.parsed / checked: a value was given (`given`) and is `ms`; the
// operation admits 1..max. The answer is a limit (`ok`, `limit`) or the refusal.
const parsedFun = (sloppy = false) =>
  fun('parsed timeout')
    .params({max: nat})
    .inputs({given: bool, ms: nat})
    .returns(({given, ms, max}) => {
      const valid = sloppy ? given.and(ms.atMost(max)) : given.and(ms.atLeast(1)).and(ms.atMost(max))
      return {ok: valid, limit: when(valid, ms, 0)}
    })
const parsed = parsedFun()
const deniedNeverLimit = (f: ReturnType<typeof parsedFun>) => [
  f.law('denied_timeout_never_becomes_a_limit: no limit outside 1..max', () => [], ({ok, limit}, {max}) => ok.implies(limit.atLeast(1).and(limit.atMost(max)))),
  f.law('a value not given is refused', ({given}) => [given.not()], ({ok}) => ok.not()),
]
const parsedLaws = deniedNeverLimit(parsed)
const sloppyParsed = deniedNeverLimit(parsedFun(true))[0]!

const draw = (r: (n: number) => number) => ({given: r(4) !== 0, ms: [0, 1, 2, 3599999, 3600000, 3600001, 86400000, 86400001, r(5000000)][r(9)]!})
const parsedHeld = () =>
  parsed.compare(
    ({given, ms}, {max}) => {
      const r = T.parsed(given ? ms : null, max)
      return {ok: r.ok, limit: r.ok ? r.value : 0}
    },
    {params: {max: 3600000}, trials: 4000, draw},
  )

// TimeCore.parse over text: the parser every timeout goes through agrees with
// the decision on what U32.read gives, on digits, padding and junk alike.
function parseHeld(): Agreement {
  const r = rand(31)
  const pieces = ['0', '00', '1', '5', '60', '3600000', '3600001', '86400000', '4294967297', '-1', '1.5', '+', ' ', 'x', '٣']
  let checked = 0
  for (let t = 0; t < 5000; t++) {
    const raw = Array.from({length: r(4)}, () => pieces[r(pieces.length)]).join('')
    for (const max of [100, 300000, 3600000, T.jobMax]) {
      const trimmed = raw.replace(/^0+/, '')
      const value = [...trimmed].length <= 8 ? T.readU32(trimmed) : null
      const want = parsed.run({given: value !== null, ms: value ?? 0}, {max})
      const got = T.parse(raw, max)
      if (got.ok !== want.ok || (got.ok && got.value !== want.limit)) return {checked, failure: `parse(${JSON.stringify(raw)}, ${max})`}
      if (!got.ok && got.error.code !== 2) return {checked, failure: `parse(${JSON.stringify(raw)}) refused with ${got.error.code}`}
      checked++
    }
  }
  return {checked}
}

// TimeCore.config: an unset setting is its fallback; a set one must parse.
const configFun = (sloppy = false) =>
  fun('configured timeout')
    .params({max: nat})
    .inputs({set: bool, parsedOk: bool, parsedMs: nat, fallback: nat})
    .returns(({set, parsedOk, parsedMs, fallback}) => ({
      ok: set.not().or(parsedOk),
      limit: when(set.not(), sloppy ? when(parsedOk, parsedMs, fallback) : fallback, parsedMs),
    }))
const omittedUsesDefault = (f: ReturnType<typeof configFun>) =>
  f.law('omitted_configuration_uses_default: an unset setting is the default', ({set}) => [set.not()], ({ok, limit}, {fallback}) => ok.and(limit.eq(fallback)))
const configHeld = () =>
  configFun().compare(
    ({set, parsedOk, parsedMs, fallback}, {max}) => {
      // The raw text: "" when unset; else a number that parses to parsedMs, or junk.
      const raw = !set ? '' : parsedOk && parsedMs >= 1 && parsedMs <= max ? String(parsedMs) : 'junk'
      const r = T.config(raw, fallback, max)
      return {ok: r.ok, limit: r.ok ? r.value : parsedMs}
    },
    {
      params: {max: 3600000},
      trials: 3000,
      draw: (r) => {
        const set = r(2) === 0
        const parsedMs = 1 + r(3600000)
        return {set, parsedOk: set ? r(2) === 0 : false, parsedMs, fallback: r(4000000)}
      },
    },
  )

// TimeCore.remaining over a budget's life: each step the clock moves `dt`;
// `left` is what remaining() reports. Elapsed time is subtracted, never
// renewed: what is left never grows and never passes the duration.
const budgetRule = (sloppy = false) =>
  rule('budget')
    .params({duration: nat})
    .inputs({dt: nat, renew: bool})
    .state({elapsed: 0, left: ({duration}) => duration})
    .step(({elapsed, dt, duration, renew}) => {
      const e = sloppy ? when(renew, 0, elapsed.plus(dt)) : elapsed.plus(dt)
      return {elapsed: e, left: duration.minus(e)}
    })
const budget = budgetRule()
const budgetLaws = (r: ReturnType<typeof budgetRule>) => ({
  laws: [
    r.law('what is left is the duration less the time elapsed', ({left, elapsed, duration}) => left.eq(duration.minus(elapsed))),
    r.law('what is left never passes the duration', ({left, duration}) => left.atMost(duration)),
  ],
  steps: [r.stepLaw('elapsed_time_is_subtracted_not_renewed: what is left never grows', ({left}, after) => after.left.atMost(left))],
})
const budgetHeld = () =>
  budget.compare(
    {
      // The budget started at clock 1000; the clock is 1000 + elapsed.
      init: ({duration}) => ({elapsed: 0, left: T.remaining({started: 1000, duration}, 1000)}),
      step: ({duration}, st, {dt}) => {
        const now = 1000 + (st.elapsed as number) + dt
        return {elapsed: now - 1000, left: T.remaining({started: 1000, duration}, now)}
      },
    },
    {trials: 400, depth: 12, bound: 50, params: (r) => ({duration: r(200)})},
  )

// TimeCore.cap: the local cap applies before the value narrows to 32 bits,
// so a budget left beyond 2^32 is still at most the cap.
const capFun = (sloppy = false) =>
  fun('local cap')
    .inputs({left: nat, local: nat})
    .returns(({left, local}) => ({ms: sloppy ? left : min(left, local)}))
const capLaws = (f: ReturnType<typeof capFun>) => [
  f.law('local_cap_is_applied_before_narrowing: never above the local cap', () => [], ({ms}, {local}) => ms.atMost(local)),
  f.law('never above what is left', () => [], ({ms}, {left}) => ms.atMost(left)),
]
const capHeld = () =>
  capFun().compare(({left, local}) => ({ms: T.cap(left, local)}), {
    trials: 4000,
    draw: (r) => ({left: [0, 1, 99, 100, 101, 2 ** 32 - 1, 2 ** 32 + 1, r(10 ** 12)][r(8)]!, local: [0, 1, 100, 3600000, 2 ** 32 - 1][r(5)]!}),
  })

export const entries: Entry[] = [
  {
    area: 'time',
    decisions: parsedLaws,
    broken: [{what: 'a zero timeout admitted as a limit', decision: sloppyParsed}],
    held: [
      {against: 'TimeCore.parsed (fun.compare)', run: parsedHeld},
      {against: 'TimeCore.parse on padded, oversized and junk text', run: parseHeld},
    ],
  },
  {
    area: 'time',
    decisions: [omittedUsesDefault(configFun())],
    broken: [{what: 'an unset setting that still takes a parsed value', decision: omittedUsesDefault(configFun(true))}],
    held: [{against: 'TimeCore.config (fun.compare)', run: configHeld}],
  },
  {
    area: 'time',
    rule: budget,
    ...budgetLaws(budget),
    from: 'any',
    broken: [{what: 'a budget renewed mid-way', rule: budgetRule(true), ...budgetLaws(budgetRule(true))}],
    held: [{against: 'TimeCore.remaining on a moving clock (rule.compare)', run: budgetHeld}],
  },
  {
    area: 'time',
    decisions: capLaws(capFun()),
    broken: [{what: 'a cap that narrows what is left without the local cap', decision: capLaws(capFun(true))[0]!}],
    held: [{against: 'TimeCore.cap past 2^32 (fun.compare)', run: capHeld}],
  },
]
