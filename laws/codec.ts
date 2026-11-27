// The codec's machines: strict UTF-8 decoding, the textual scan that bounds
// depth and work before parsing, the number grammar of the parser, the
// encoder's fuel, and the wire's exact probability-mass tolerance. Each rule
// is held to the real src/codec code, character by character or byte by
// byte, and keeps the bug it rules out.
//
// What the Bend fixtures and the 0.8.1 safe-core ledger claimed of the codec:
// strict scalar UTF-8 (no overlong forms, surrogates, values past U+10FFFF,
// stray continuations), depth and work bounded before any AST exists,
// numbers by the JSON grammar only, an encoder that fails rather than runs
// without fuel, and exact (not floating) mass tolerance.

import {bool, nat, oneOf, rule, when} from 'gdp-wired'
import * as Codec from '../src/codec/codec.ts'
import type {Json} from '../src/codec/json.ts'
import {jarr, jbool, jnull, jnum, jobj, jstr, parse, writeWithFuel} from '../src/codec/json.ts'
import * as Wire from '../src/codec/wire.ts'
import type {Entry} from './kit.ts'
import {rand} from './kit.ts'

type Raw = Record<string, unknown>
// A rule's compiled machine stepped beside the code: `step` gives the
// request (or the params, first) and what the code's state is after it.
function beside(
  r: {compiled(): any; encodeParams(p: any): any; encodeInput(i: any, p?: any): any; decode(s: any): Raw; name: string},
  trials: number,
  seed: number,
  body: (draw: (n: number) => number, step: (params: Raw | null, input: Raw | null, want: Raw) => string | undefined) => string | undefined,
): {checked: number; failure?: string} {
  const g = r.compiled()
  let checked = 0
  for (let t = 0; t < trials; t++) {
    const draw = rand(seed + t)
    let ps: unknown
    let raw: Raw = {}
    let st: unknown
    const trace: unknown[] = []
    const failure = body(draw, (params, input, want) => {
      if (params) {
        raw = params
        ps = r.encodeParams(params)
        st = g.init(ps)
      }
      if (input) {
        trace.push(input)
        st = g.step(ps, st, r.encodeInput(input, raw))
      }
      checked++
      const got = r.decode(st)
      for (const [k, v] of Object.entries(want)) if (got[k] !== v) return `${r.name}: ${k} is ${String(got[k])} in the rule, ${String(v)} in the code, after ${JSON.stringify(trace).slice(0, 400)}`
      return undefined
    })
    if (failure) return {checked, failure}
  }
  return {checked}
}

// ---- Strict UTF-8 (Codec.utf8_with_error) ------------------------------------------

type Utf8Bugs = {noMinimum?: boolean; surrogates?: boolean; strayAscii?: boolean}

const utf8Rule = (bug: Utf8Bugs = {}) =>
  rule('utf-8')
    .inputs({b: nat})
    .state({rem: 0, code: 0, min: 0, failed: bool.from(false), count: 0, last: 0})
    .flags(({b, rem, code, min}) => {
      const start = rem.eq(0)
      const ascii = start.and(b.lt(128))
      const lead = start.and(b.atLeast(194)).and(b.atMost(244))
      const stray = start.and(b.atLeast(128)).and(b.atMost(191))
      const cont = start.not().and(b.atLeast(128)).and(b.atMost(191))
      const next = code.times(64).plus(b.minus(128))
      const lastByte = cont.and(rem.eq(1))
      const scalar = next.atMost(1114111).and(bug.surrogates ? next.atLeast(0) : next.lt(55296).or(next.gt(57343)))
      const canonical = (bug.noMinimum ? next.atLeast(0) : next.atLeast(min)).and(scalar)
      const asciiLike = bug.strayAscii ? ascii.or(stray) : ascii
      return {start, ascii: asciiLike, lead, cont, lastByte, canonical}
    })
    .step(({b, rem, code, min, failed, count, last, start, ascii, lead, cont, lastByte, canonical}) => {
      const next = code.times(64).plus(b.minus(128))
      const bad = failed.not().and(start.and(ascii.not()).and(lead.not()).or(start.not().and(cont.not())).or(lastByte.and(canonical.not())))
      const emit = failed.not().and(ascii.or(lastByte.and(canonical)))
      const opens = failed.not().and(lead)
      const goesOn = failed.not().and(cont).and(lastByte.not())
      const two = b.lt(224)
      const three = b.lt(240)
      return {
        failed: failed.or(bad),
        count: count.plus(when(emit, 1, 0)),
        last: when(emit.and(ascii), b, when(emit, next, last)),
        rem: when(opens, when(two, 1, when(three, 2, 3)), when(goesOn, rem.minus(1), when(emit.or(bad), 0, rem))),
        code: when(opens, when(two, b.minus(192), when(three, b.minus(224), b.minus(240))), when(goesOn, next, when(emit.or(bad), 0, code))),
        min: when(opens, when(two, 128, when(three, 2048, 65536)), when(emit.or(bad), 0, min)),
      }
    })

const utf8 = utf8Rule()
const utf8Laws = (r: typeof utf8) => ({
  laws: [r.law('a sequence has at most three bytes left', ({rem}) => rem.atMost(3))],
  steps: [
    r.stepLaw('every scalar decoded is a Unicode scalar: at most U+10FFFF, never a surrogate', (_b, a) => a.last.atMost(1114111).and(a.last.lt(55296).or(a.last.gt(57343))), (b) => b.failed.not().and(b.ascii.or(b.lastByte.and(b.canonical)))),
    r.stepLaw('no overlong form: a multi-byte scalar is at least the smallest of its length', (b, a) => a.count.gt(b.count).implies(a.last.atLeast(b.min)), (b) => b.start.not()),
    r.stepLaw('a stray continuation byte fails', (_b, a) => a.failed, (b) => b.failed.not().and(b.rem.eq(0)).and(b.b.atLeast(128)).and(b.b.atMost(193))),
    r.stepLaw('after a failure nothing more is decoded', (b, a) => a.count.eq(b.count).and(a.failed), (b) => b.failed),
  ],
})

const utf8Held = () => {
  const interesting = [0, 65, 127, 128, 143, 159, 160, 191, 192, 193, 194, 223, 224, 237, 239, 240, 243, 244, 245, 255]
  return beside(utf8, 1500, 31, (draw, step) => {
    const bytes: number[] = []
    let failure = step({}, null, {failed: false, count: 0, rem: 0})
    for (let i = 0; i < 10 && !failure; i++) {
      const b = draw(3) === 0 ? draw(256) : interesting[draw(interesting.length)]!
      bytes.push(b)
      const real = Codec.decodeUtf8(bytes)
      const cps = real.ok ? Array.from(real.value, (c) => c.codePointAt(0)!) : []
      const want: Raw = real.ok
        ? {failed: false, rem: 0, count: cps.length, ...(cps.length ? {last: cps.at(-1)} : {})}
        : real.error.message === 'truncated UTF-8'
          ? {failed: false}
          : {failed: true}
      failure = step(null, {b}, want)
    }
    return failure
  })
}

// ---- The textual scan (Codec.scan_step) ---------------------------------------------

const CHARS = ['open', 'close', 'quote', 'slash', 'space', 'other'] as const
const charOf: Record<(typeof CHARS)[number], string> = {open: '[', close: ']', quote: '"', slash: '\\', space: ' ', other: 'a'}
type ScanBugs = {countStrings?: boolean; ignoreEscape?: boolean; saturate?: boolean}

const scanRule = (bug: ScanBugs = {}) =>
  rule('scan')
    .params({D: nat, W: nat})
    .inputs({c: oneOf(...CHARS)})
    .state({quoted: bool.from(false), escaped: bool.from(false), depth: 0, work: 0, failed: bool.from(false)})
    .flags(({c, quoted, escaped, depth}) => ({
      inString: quoted,
      ends: quoted.and(bug.ignoreEscape ? c.is('quote') : escaped.not().and(c.is('quote'))),
      underflow: quoted.not().and(c.is('close')).and(depth.eq(0)).and(bug.saturate ? depth.gt(0) : depth.eq(0)),
    }))
    .step(({c, quoted, escaped, depth, work, failed, ends, underflow, D, W}) => {
      const outside = quoted.not()
      const nextDepth = when(outside.and(c.is('open')), depth.plus(1), when(outside.and(c.is('close')), depth.minus(1), depth))
      const counted = (bug.countStrings ? c.is('space').not() : outside.and(c.is('space').not()))
      const nextWork = work.plus(when(counted, 1, 0))
      return {
        quoted: when(failed, quoted, when(quoted, ends.not(), c.is('quote'))),
        escaped: when(failed, escaped, quoted.and(bug.ignoreEscape ? c.is('slash') : escaped.not().and(c.is('slash')))),
        depth: when(failed, depth, nextDepth),
        work: when(failed, work, nextWork),
        failed: failed.or(underflow).or(nextDepth.gt(D)).or(nextWork.gt(W)),
      }
    })

const scan = scanRule()
const scanLaws = (r: typeof scan) => ({
  laws: [r.law('depth and work never pass their limits unless the scan failed', ({failed, depth, work, D, W}) => failed.or(depth.atMost(D).and(work.atMost(W))))],
  steps: [
    r.stepLaw('inside a string nothing counts toward depth or work', (b, a) => a.depth.eq(b.depth).and(a.work.eq(b.work)), (b) => b.inString),
    r.stepLaw('an escaped character never ends a string', (_b, a) => a.quoted, (b) => b.failed.not().and(b.quoted).and(b.escaped)),
    r.stepLaw('a close at depth 0 fails (no saturating underflow)', (_b, a) => a.failed, (b) => b.quoted.not().and(b.depth.eq(0)).and(b.c.is('close'))),
  ],
})

const scanHeld = () =>
  beside(scan, 1500, 41, (draw, step) => {
    const D = 1 + draw(4)
    const W = 2 + draw(10)
    let failure = step({D, W}, null, {depth: 0, work: 0, quoted: false, failed: false})
    const s = Codec.newScan()
    let stopped = false
    for (let i = 0; i < 14 && !failure; i++) {
      const c = CHARS[draw(CHARS.length)]!
      // A close at depth 0 wraps the real (U32) depth past every limit.
      if (!stopped) Codec.scanStep(s, charOf[c].codePointAt(0)!, false)
      const over = s.depth > D || s.work > W
      failure = step(null, {c}, stopped || over ? {failed: true} : {quoted: s.quoted, escaped: s.escaped, depth: s.depth, work: s.work, failed: false})
      stopped ||= over
    }
    return failure
  })

// The real limit is depth 64: the rule's D, held at 64, against the real scan.
const scanAt64Held = () =>
  beside(scan, 400, 43, (draw, step) => {
    let failure = step({D: 64, W: 32768}, null, {failed: false})
    let text = ''
    for (let i = 0; i < 80 && !failure; i++) {
      const c = draw(3) === 0 ? CHARS[draw(CHARS.length)]! : 'open'
      text += charOf[c]
      const real = Codec.scanText(text, 1 << 20, 32768, 'x')
      failure = step(null, {c}, {failed: !real.ok})
      if (!real.ok) break
    }
    return failure
  })

// ---- The number grammar (the parser's number states) --------------------------------

const NS = ['minus', 'zero', 'int', 'dot', 'frac', 'e', 'esign', 'exp'] as const
const NC = ['zero', 'digit', 'minus', 'plus', 'dot', 'e', 'end'] as const
const ncChar: Record<(typeof NC)[number], string> = {zero: '0', digit: '7', minus: '-', plus: '+', dot: '.', e: 'e', end: ']'}

const numberRule = (bug: {dotEnds?: boolean; zeroGoesOn?: boolean} = {}) =>
  rule('number')
    .inputs({c: oneOf(...NC)})
    .state({st: oneOf(...NS).from('int'), started: bool.from(false), done: bool.from(false), failed: bool.from(false)})
    .flags(({c, st}) => {
      const digit = c.is('zero').or(c.is('digit'))
      const cont = st
        .is('minus')
        .and(digit)
        .or(st.is('zero').and(c.is('dot').or(c.is('e')).or(bug.zeroGoesOn ? digit : c.is('dot').and(c.is('e')))))
        .or(st.is('int').and(digit.or(c.is('dot')).or(c.is('e'))))
        .or(st.is('dot').and(digit))
        .or(st.is('frac').and(digit.or(c.is('e'))))
        .or(st.is('e').and(digit.or(c.is('minus')).or(c.is('plus'))))
        .or(st.is('esign').and(digit))
        .or(st.is('exp').and(digit))
      const canEnd = st.is('zero').or(st.is('int')).or(st.is('frac')).or(st.is('exp')).or(bug.dotEnds ? st.is('dot') : st.is('dot').and(st.is('int')))
      return {digit, cont, canEnd}
    })
    .step(({c, st, started, done, failed, digit, cont, canEnd}) => {
      const live = done.not().and(failed.not())
      const first = live.and(started.not())
      const go = live.and(started).and(cont)
      const stop = live.and(started).and(cont.not())
      // The first character opens a number (a minus, a zero or another digit).
      const opened = when(c.is('minus'), st.of('minus'), when(c.is('zero'), st.of('zero'), st.of('int')))
      const moved = when(
        st.is('minus'),
        when(c.is('zero'), st.of('zero'), st.of('int')),
        when(
          st.is('zero'),
          when(c.is('dot'), st.of('dot'), bug.zeroGoesOn ? when(digit, st.of('int'), st.of('e')) : st.of('e')),
          when(
            st.is('int'),
            when(digit, st.of('int'), when(c.is('dot'), st.of('dot'), st.of('e'))),
            when(st.is('dot'), st.of('frac'), when(st.is('frac'), when(digit, st.of('frac'), st.of('e')), when(st.is('e'), when(digit, st.of('exp'), st.of('esign')), st.of('exp')))),
          ),
        ),
      )
      return {
        st: when(first, opened, when(go, moved, st)),
        started: started.or(first),
        done: done.or(stop.and(canEnd)),
        failed: failed.or(stop.and(canEnd.not())).or(first.and(c.is('minus').or(digit).not())),
      }
    })

const number = numberRule()
const numberLaws = (r: typeof number) => ({
  laws: [r.law('a number ends only in a state that can end it: never after a sign, a dot or an e', ({done, st}) => done.implies(st.is('zero').or(st.is('int')).or(st.is('frac')).or(st.is('exp'))))],
  steps: [r.stepLaw('a leading zero is never followed by a digit', (_b, a) => a.st.is('zero'), (b) => b.started.and(b.done.not()).and(b.failed.not()).and(b.st.is('zero')).and(b.digit))],
})

// The parser takes `[lex]` exactly when the rule consumes every character of
// the lexeme and then ends the number at the bracket.
function numberHeld(): {checked: number; failure?: string} {
  const draw = rand(53)
  const g = number.compiled()
  const ps = number.encodeParams({})
  for (let t = 0; t < 4000; t++) {
    const tokens: (typeof NC)[number][] = [(['minus', 'zero', 'digit'] as const)[draw(3)]!]
    for (let i = draw(6); i > 0; i--) tokens.push((['zero', 'digit', 'digit', 'minus', 'plus', 'dot', 'e'] as const)[draw(7)]!)
    tokens.push('end')
    let s = g.init(ps)
    let consumedAll = true
    for (const tok of tokens) {
      const before = number.decode(s)
      s = g.step(ps, s, number.encodeInput({c: tok}))
      const after = number.decode(s)
      if (tok !== 'end' && !before.done && !before.failed && (after.done || after.failed)) consumedAll = false
    }
    const accepts = consumedAll && number.decode(s).done === true
    const lex = tokens.filter((x) => x !== 'end').map((x) => ncChar[x]).join('')
    const real = parse(`[${lex}]`)
    if (real.ok !== accepts) return {checked: t, failure: `number: [${lex}] is ${real.ok ? 'accepted' : 'refused'} by the parser, ${accepts ? 'accepted' : 'refused'} by the rule`}
    if (real.ok && !(real.value.t === 'arr' && real.value.items[0]?.t === 'num' && real.value.items[0].lex === lex)) return {checked: t, failure: `number: [${lex}] parsed to something else`}
  }
  return {checked: 4000}
}

// ---- The encoder's fuel (JSON.write_with_fuel) ---------------------------------------

const fuelRule = (bug: {free?: boolean} = {}) =>
  rule('encoder fuel')
    .params({fuel: nat})
    .inputs({job: bool})
    .state({used: 0, written: 0, failed: bool.from(false)})
    .flags(({job, used, fuel, failed}) => ({runs: job.and(failed.not()).and(bug.free ? used.atLeast(0) : used.lt(fuel)), starves: job.and(failed.not()).and(used.atLeast(fuel))}))
    .step(({runs, starves, used, written, failed}) => ({
      used: used.plus(when(runs, 1, 0)),
      written: written.plus(when(runs, 1, 0)),
      failed: failed.or(starves.and(bug.free ? starves.not() : starves)),
    }))
const fuel = fuelRule()
const fuelLaws = (r: typeof fuel) => ({
  laws: [r.law('encoding_without_fuel_fails: no job runs past the fuel', ({used, fuel}) => used.atMost(fuel))],
  steps: [r.stepLaw('a job with no fuel left fails the encoding', (_b, a) => a.failed, (b) => b.job.and(b.used.atLeast(b.fuel)))],
})

// The encoder's own count of jobs: a scalar 1, an array 3 + n + its items',
// an object 3 + 2m + its values'.
const jobsOf = (v: Json): number =>
  v.t === 'arr' ? 3 + v.items.length + v.items.reduce((s, x) => s + jobsOf(x), 0) : v.t === 'obj' ? 3 + 2 * v.fields.length + v.fields.reduce((s, [, x]) => s + jobsOf(x), 0) : 1

function randomJson(draw: (n: number) => number, depth: number): Json {
  const k = depth > 3 ? draw(4) : draw(6)
  if (k === 0) return jnull()
  if (k === 1) return jbool(draw(2) === 0)
  if (k === 2) return jnum(['0', '-1.5e3', '12'][draw(3)]!)
  if (k === 3) return jstr(['', 'a', '"\n'][draw(3)]!)
  if (k === 4) return jarr(Array.from({length: draw(4)}, () => randomJson(draw, depth + 1)))
  return jobj(Array.from({length: draw(4)}, (_, i) => [`k${i}`, randomJson(draw, depth + 1)] as [string, Json]))
}

const fuelHeld = () =>
  beside(fuel, 800, 61, (draw, step) => {
    const v = randomJson(draw, 0)
    const jobs = jobsOf(v)
    const f = Math.max(0, jobs + draw(5) - 2)
    let failure = step({fuel: f}, null, {used: 0})
    for (let i = 0; i < jobs && !failure; i++) failure = step(null, {job: true}, {})
    if (failure) return failure
    const real = writeWithFuel(f, v)
    const g = fuel.compiled()
    let s = g.init(fuel.encodeParams({fuel: f}))
    for (let i = 0; i < jobs; i++) s = g.step(fuel.encodeParams({fuel: f}), s, fuel.encodeInput({job: true}))
    const end = fuel.decode(s) as Raw
    if (real.ok === Boolean(end.failed)) return `encoder fuel: ${jobs} jobs with fuel ${f}: the writer ${real.ok ? 'wrote' : 'failed'}, the rule ${end.failed ? 'failed' : 'wrote'}`
    if (!real.ok && real.error.message !== 'JSON encoding work limit') return `encoder fuel: ${real.error.message}`
    if (real.ok && !parse(real.value).ok) return 'encoder fuel: output that does not parse back'
    return undefined
  })

// ---- Exact mass tolerance (Wire.common) -------------------------------------------------
//
// Probabilities in millionths: a distribution is taken only when every
// probability is at most 1 and their sum is within [0.98, 1.02], exactly.

const massRule = (bug: {loose?: boolean} = {}) =>
  rule('probability mass')
    .params({unit: nat})
    .carriesList('P', nat, {total: {from: 0, step: (acc: any, p: any) => acc.plus(p)}}, {})
    .state({taken: 0})
    .flags(({P, unit}) => ({
      ok: P.every((p: any) => p.atMost(unit))
        .and(P.fold.total.times(100).atLeast(unit.times(98)))
        .and(P.fold.total.times(100).atMost(unit.times(bug.loose ? 103 : 102))),
    }))
    .step(({ok, taken}) => ({taken: taken.plus(when(ok, 1, 0))}))
const mass = massRule()
const massLaws = (r: typeof mass) => ({
  steps: [
    r.stepLaw('a distribution is taken only with its mass within [0.98, 1.02]', (b, a) => a.taken.gt(b.taken).implies(b.P.fold.total.times(100).atLeast(b.unit.times(98)).and(b.P.fold.total.times(100).atMost(b.unit.times(102))))),
    r.stepLaw('no probability above 1 is taken', (b, a) => a.taken.gt(b.taken).implies(b.P.every((p: any) => p.atMost(b.unit)))),
  ],
})

const UNIT = 1_000_000
const lexOf = (p: number, draw: (n: number) => number): string => {
  const whole = Math.floor(p / UNIT)
  const frac = String(p % UNIT).padStart(6, '0')
  const plain = `${whole}.${frac}`
  const k = draw(3)
  if (k === 0) return plain
  if (k === 1) return `${p}e-6`
  return `${plain}${'0'.repeat(draw(20))}`
}

const massHeld = () =>
  beside(mass, 600, 71, (draw, step) => {
    let failure = step({unit: UNIT}, null, {taken: 0})
    for (let i = 0; i < 4 && !failure; i++) {
      const n = 1 + draw(4)
      const target = [980000, 979999, 1020000, 1020001, 1000000, 500000][draw(6)]!
      const ps = Array.from({length: n}, () => draw(Math.floor(UNIT / n)))
      const fix = target - ps.slice(1).reduce((s, x) => s + x, 0)
      ps[0] = Math.max(0, fix + (draw(4) === 0 ? draw(3) - 1 : 0))
      if (draw(8) === 0) ps[0] = UNIT + 1
      const keys = ps.map((_, j) => `k${j}`)
      const request = JSON.stringify({state: {}, questions: {q: {type: 'choice', instructions: 'x', criteria: Object.fromEntries(keys.map((k) => [k, null]))}}})
      const probs = keys.map((k, j) => `"${k}":${lexOf(ps[j]!, draw)}`).join(',')
      const response = `{"model":"jev","answers":{"q":{"type":"choice","choice":"k0","confidence":1,"probabilities":{${probs}}}},"usage":{"input_tokens":0,"output_tokens":0}}`
      const req = Wire.request(request)
      if (!req.ok) return `mass: request ${req.error.message}`
      const real = Wire.response(response, req.value)
      // Compare the rule's verdict for this request with the wire's.
      const g = mass.compiled()
      const ps0 = mass.encodeParams({unit: UNIT})
      const s = g.step(ps0, g.init(ps0), mass.encodeInput({P: ps}, {unit: UNIT}))
      const taken = (mass.decode(s) as Raw).taken === 1
      if (taken !== real.ok) return `mass: ${JSON.stringify(ps)} is ${real.ok ? 'taken' : `refused (${real.error.message})`} by the wire, ${taken ? 'taken' : 'refused'} by the rule`
    }
    return failure
  })

export const entries: Entry[] = [
  (() => {
    const l = utf8Laws(utf8)
    const bad = (what: string, bug: Utf8Bugs, i: number) => ({what, rule: utf8Rule(bug), laws: utf8Laws(utf8Rule(bug)).laws, steps: [utf8Laws(utf8Rule(bug)).steps[i]!]})
    return {
      area: 'strict UTF-8',
      rule: utf8,
      laws: l.laws,
      steps: l.steps,
      from: 'any' as const,
      broken: [
        bad('surrogates decoded', {surrogates: true}, 0),
        bad('no minimum per sequence length (overlong forms)', {noMinimum: true}, 1),
        bad('a stray continuation byte taken as a character', {strayAscii: true}, 2),
      ],
      held: [{against: 'Codec.decodeUtf8 on every prefix of random bytes', run: utf8Held}],
    }
  })(),
  (() => {
    const l = scanLaws(scan)
    const bad = (what: string, bug: ScanBugs, i: number) => ({what, rule: scanRule(bug), laws: scanLaws(scanRule(bug)).laws, steps: [scanLaws(scanRule(bug)).steps[i]!]})
    return {
      area: 'the textual scan',
      rule: scan,
      laws: l.laws,
      steps: l.steps,
      broken: [
        bad('work counted inside strings', {countStrings: true}, 0),
        bad('an escaped quote ends the string', {ignoreEscape: true}, 1),
        bad('a saturating close at depth 0', {saturate: true}, 2),
      ],
      held: [
        {against: 'Codec.scanStep and Codec.scanText', run: scanHeld},
        {against: 'Codec.scanText at depth 64 and work 32768', run: scanAt64Held},
      ],
    }
  })(),
  (() => {
    const l = numberLaws(number)
    return {
      area: 'the number grammar',
      rule: number,
      laws: l.laws,
      steps: l.steps,
      broken: [
        {what: 'a number ended after its dot', rule: numberRule({dotEnds: true}), laws: numberLaws(numberRule({dotEnds: true})).laws},
        {what: 'a leading zero followed by digits', rule: numberRule({zeroGoesOn: true}), steps: numberLaws(numberRule({zeroGoesOn: true})).steps},
      ],
      held: [{against: 'json.parse on random lexemes', run: numberHeld}],
    }
  })(),
  (() => {
    const l = fuelLaws(fuel)
    return {
      area: 'the encoder',
      rule: fuel,
      laws: l.laws,
      steps: l.steps,
      broken: [{what: 'an encoder that runs without fuel', rule: fuelRule({free: true}), laws: fuelLaws(fuelRule({free: true})).laws}],
      held: [{against: 'json.writeWithFuel (its job count, exactly)', run: fuelHeld}],
    }
  })(),
  (() => {
    const l = massLaws(mass)
    return {
      area: 'exact probability mass',
      rule: mass,
      steps: l.steps,
      broken: [{what: 'a tolerance of 1.03', rule: massRule({loose: true}), steps: [massLaws(massRule({loose: true})).steps[0]!]}],
      held: [{against: 'Wire.response (exact decimals)', run: massHeld}],
    }
  })(),
]
