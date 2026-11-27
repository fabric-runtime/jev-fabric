// Decisions: which profile a request selects, how a profile merges into the
// request, why an explicit provider ignores ambient targets, alias
// canonicalization, and how a decision spends the shared budget. Each rule
// or function is held to the real src/decision code.
//
// Ported from native/tests/decision-proofs.bend (the claims of
// 0.8.1's decision proof coverage) and Decision.bend's accounting.

import {bool, fun, nat, oneOf, rule, when} from 'gdp-wired'
import type {Json} from '../src/codec/json.ts'
import {field, fromJs, jobj, jstr} from '../src/codec/json.ts'
import * as Core from '../src/jev/core.ts'
import * as Config from '../src/decision/config.ts'
import * as D from '../src/decision/decision-core.ts'
import * as Profiles from '../src/decision/profiles.ts'
import type {Entry} from './kit.ts'
import {rand} from './kit.ts'

// ---- Profile selection (DecisionProfiles.choose_profile) --------------------------
//
// A selector is a name or empty: as a natural, 0 is empty and k > 0 the k-th
// name. `provider` is whether the request names a provider.

const chooseFun = (bug: {ambientFirst?: boolean; providerIgnored?: boolean} = {}) =>
  fun('choose profile')
    .inputs({explicit: nat, provider: bool, ambient: nat, dflt: nat})
    .returns(({explicit, provider, ambient, dflt}) => {
      const rest = when(ambient.gt(0), ambient, dflt)
      const fallback = bug.providerIgnored ? rest : when(provider, 0, rest)
      return {profile: bug.ambientFirst ? when(ambient.gt(0), ambient, when(explicit.gt(0), explicit, fallback)) : when(explicit.gt(0), explicit, fallback)}
    })
const choose = chooseFun()
const chooseLaws = (f: typeof choose) => [
  f.law('explicit_profile_wins: a nonempty explicit selector wins over provider, ambient and default', ({explicit}) => [explicit.gt(0)], ({profile}, {explicit}) => profile.eq(explicit)),
  f.law('explicit_provider_suppresses_profiles: with no explicit selector, a named provider selects no profile', ({explicit, provider}) => [explicit.eq(0), provider], ({profile}) => profile.eq(0)),
  f.law('ambient_profile_wins_over_default', ({explicit, provider, ambient}) => [explicit.eq(0), provider.not(), ambient.gt(0)], ({profile}, {ambient}) => profile.eq(ambient)),
  f.law('absent_selectors_use_document_default', ({explicit, provider, ambient}) => [explicit.eq(0), provider.not(), ambient.eq(0)], ({profile}, {dflt}) => profile.eq(dflt)),
]

const NAMES = ['', 'router', 'direct', 'local']
function chooseHeld() {
  let n = 0
  for (let e = 0; e < NAMES.length; e++)
    for (const provider of [false, true])
      for (let a = 0; a < NAMES.length; a++)
        for (let d = 0; d < NAMES.length; d++) {
          n++
          const got = Profiles.chooseProfile(NAMES[e]!, provider ? jstr('openai') : undefined, NAMES[a]!, NAMES[d]!)
          const want = NAMES[(choose.run({explicit: e, provider, ambient: a, dflt: d}) as {profile: number}).profile]
          if (got !== want) return {checked: n, failure: `chooseProfile(${NAMES[e]}, ${provider}, ${NAMES[a]}, ${NAMES[d]}) = ${got}, the rule says ${want}`}
        }
  return {checked: n, exhaustive: true}
}

// explicit_provider_bypasses_document: a provider-only request comes back
// unchanged with no profile, whatever the document and ambient selector.
function bypassHeld() {
  const r = rand(31)
  const providers = ['openai', 'openrouter', 'vercel-ai-gateway', 'typesafe']
  for (let t = 0; t < 600; t++) {
    const entries = Array.from({length: r(4)}, (_, i) => [NAMES[i + 1]!, fromJs({provider: providers[r(4)], model: `m${r(5)}`})] as [string, Json])
    const doc: Profiles.Document = {profiles: entries, default: r(2) && entries.length ? entries[0]![0] : ''}
    const request = jobj([['provider', jstr(providers[r(4)]!)]])
    const got = Profiles.applyDocument(request, doc, NAMES[r(NAMES.length)]!)
    if (!got.ok || got.value.profile !== '' || JSON.stringify(got.value.request) !== JSON.stringify(request)) return {checked: t, failure: `applyDocument(${JSON.stringify(request)}) = ${JSON.stringify(got)}`}
  }
  return {checked: 600}
}

// ---- Whole-field overlay (DecisionProfiles.merge), one key at a time ---------------
//
// A key's value in the base and in the overrides: 0 absent, k > 0 the k-th
// value. The merged value is the override's whenever there is one.

const mergeFun = (deep = false) =>
  fun('merge one key')
    .inputs({base: nat, over: nat})
    // The broken one keeps an old value that is present (a recursive merge's habit).
    .returns(({base, over}) => ({out: deep ? when(base.gt(0), base, over) : when(over.gt(0), over, base)}))
const merge = mergeFun()
const mergeLaws = (f: typeof merge) => [
  f.law('provider_options_replaced_whole: an overridden field is exactly the replacement', ({over}) => [over.gt(0)], ({out}, {over}) => out.eq(over)),
  f.law('a field the overrides lack is kept', ({over}) => [over.eq(0)], ({out}, {base}) => out.eq(base)),
  f.relate('shadowed_provider_options_are_irrelevant: an overridden old value never reaches the result', (a, b) => a.over.eq(b.over).and(a.over.gt(0)), (x, y) => x.out.eq(y.out)),
]

function mergeHeld() {
  const r = rand(37)
  const KEYS = ['providerOptions', 'provider', 'model', 'temperature']
  const VALUES = [fromJs({order: ['x']}), fromJs({}), fromJs({nested: {deep: [1]}}), jstr('a'), fromJs(0.5), fromJs(null)]
  const id = (v: Json | undefined) => (v === undefined ? 0 : VALUES.findIndex((x) => JSON.stringify(x) === JSON.stringify(v)) + 1)
  let checked = 0
  for (let t = 0; t < 800; t++) {
    const pick = () => jobj(KEYS.filter(() => r(2) === 1).map((k) => [k, VALUES[r(VALUES.length)]!] as [string, Json]))
    const base = pick()
    const over = pick()
    const got = Profiles.merge(base, over)
    if (!got.ok) return {checked, failure: `merge failed: ${got.error.message}`}
    for (const k of KEYS) {
      checked++
      const want = (merge.run({base: id(field(base, k)), over: id(field(over, k))}) as {out: number}).out
      if (id(field(got.value, k)) !== want) return {checked, failure: `merge(${JSON.stringify(base)}, ${JSON.stringify(over)}) at ${k}`}
    }
    // The order: the base fields kept, then the overrides as given.
    const keys = got.value.t === 'obj' ? got.value.fields.map(([k]) => k) : []
    const expected = [...(base.t === 'obj' ? base.fields.map(([k]) => k).filter((k) => field(over, k) === undefined) : []), ...(over.t === 'obj' ? over.fields.map(([k]) => k) : [])]
    if (JSON.stringify(keys) !== JSON.stringify(expected)) return {checked, failure: `merge order ${keys} vs ${expected}`}
  }
  return {checked}
}

// ---- Explicit provider discards ambient targets (DecisionConfig.configure_explicit) --
//
// The model (and the endpoint, the same way): the request's, else (with no
// explicit provider) the ambient DECISION_MODEL, else the preset's.

const targetFun = (inherit = false) =>
  fun('target model')
    .inputs({explicit: bool, request: nat, ambient: nat, preset: nat})
    .returns(({explicit, request, ambient, preset}) => ({
      model: when(request.gt(0), request, when(explicit.and(!inherit ? explicit : explicit.not()), preset, when(ambient.gt(0), ambient, preset))),
    }))
const target = targetFun()
const targetLaws = (f: typeof target) => [
  f.relate(
    'explicit_provider_discards_ambient_target: with an explicit provider, the ambient model cannot change the result',
    (a, b) => a.explicit.and(b.explicit).and(a.request.eq(b.request)).and(a.preset.eq(b.preset)),
    (x, y) => x.model.eq(y.model),
  ),
  f.law('a request model always wins', ({request}) => [request.gt(0)], ({model}, {request}) => model.eq(request)),
]

function targetHeld() {
  const r = rand(41)
  const models = ['', 'request-model']
  const ambient = ['', 'ambient-a', 'ambient-b']
  const endpoints = ['', 'https://ambient-a.test/x', 'https://ambient-b.test/y', 'http://example.com/']
  const providers = ['openai', 'openrouter', 'typesafe', 'cloudflare-workers-ai', 'custom']
  let checked = 0
  for (let t = 0; t < 600; t++) {
    const provider = providers[r(providers.length)]!
    const settings = Config.PRESETS.find((p) => p.provider === provider)!
    const m = models[r(2)]!
    const req = jobj([['provider', jstr(provider)], ...(m ? ([['model', jstr(m)]] as [string, Json][]) : [])])
    const explicit = r(2) === 1 ? field(req, 'provider') : undefined
    const [ma, mb] = [ambient[r(3)]!, ambient[r(3)]!]
    const [ea, eb] = [endpoints[r(4)]!, endpoints[r(4)]!]
    const account = r(2) ? '0123456789abcdef0123456789abcdef' : 'bad'
    const a = Config.configureExplicit(req, settings, ma, ea, account, explicit)
    const b = Config.configureExplicit(req, settings, mb, eb, account, explicit)
    checked++
    // Noninterference on the real code, failures included.
    if (explicit !== undefined && JSON.stringify(a) !== JSON.stringify(b)) return {checked, failure: `configureExplicit differs on ambient ${ma}/${ea} vs ${mb}/${eb}`}
    if (a.ok && settings.provider !== 'cloudflare-workers-ai') {
      const names = ['', m || 'x', ma || 'y', settings.model]
      const want = (target.run({explicit: explicit !== undefined, request: m ? 1 : 0, ambient: ma ? 2 : 0, preset: 3}) as {model: number}).model
      if (a.value.model !== names[want]) return {checked, failure: `configure model ${a.value.model}, the rule says ${names[want]}`}
    }
  }
  return {checked}
}

// ---- Alias canonicalization (DecisionConfig.canonical) ------------------------------
//
// A provider name as a natural: 1 vercel-ai-gateway, 2 vercel, others themselves.

const canonicalFun = (swap = false) =>
  fun('canonical provider')
    .inputs({p: nat})
    .returns(({p}) => {
      const once = (x: ReturnType<typeof nat.from> | any) => when(x.eq(1), 2, swap ? when(x.eq(2), 1, x) : x)
      const c1 = once(p)
      return {c1, c2: once(c1)}
    })
const canonical = canonicalFun()
const canonicalLaws = (f: typeof canonical) => [f.law('canonical_provider_is_idempotent: canonicalizing twice is canonicalizing once', () => [], ({c1, c2}) => c2.eq(c1))]

function canonicalHeld() {
  const names = ['', 'vercel-ai-gateway', 'vercel', 'openai', 'custom', 'Vercel-AI-Gateway']
  let n = 0
  for (const [i, p] of names.entries()) {
    n++
    const c1 = Config.canonical(p)
    if (Config.canonical(c1) !== c1) return {checked: n, failure: `canonical(${p})`}
    const out = canonical.run({p: i}) as {c1: number}
    if (names[out.c1] !== c1) return {checked: n, failure: `canonical(${p}) = ${c1}, the rule says ${names[out.c1]}`}
  }
  return {checked: n, exhaustive: true}
}

// ---- The decision budget (Core.reserve, Decision.account) ---------------------------
//
// A run of reservations and accountings. Known usage spends; a report past
// what is left overshoots (checked before adding: the tokens saturate one
// past the limit and every call is gone); unknown or invalid usage stops the
// budget, since it cannot be bounded.

type Bugs = {keepOnUnknown?: boolean; overshootAfter?: boolean; refund?: boolean}
const USAGE = ['known', 'unknown', 'invalid'] as const

const budgetRule = (bug: Bugs = {}) =>
  rule('decision budget')
    .params({calls: nat, limit: nat})
    .inputs({op: oneOf('reserve', 'account'), usage: oneOf(...USAGE), input: nat, output: nat})
    .state({remaining: ({calls}) => calls, evaluations: 0, tokens: 0})
    .flags(({op, usage, input, output, remaining, tokens, limit}) => {
      const reserved = op.is('reserve').and(remaining.gt(0)).and(tokens.lt(limit))
      const accounting = op.is('account')
      const known = accounting.and(usage.is('known'))
      const unbounded = accounting.and(usage.is('known').not())
      const over = known.and(input.gt(limit).or(output.gt(limit)).or(bug.overshootAfter ? input.minus(input).gt(0) : input.plus(output).gt(limit.minus(tokens))))
      return {reserved, accounting, known, unbounded, over}
    })
    .step(({reserved, known, unbounded, over, input, output, remaining, evaluations, tokens, limit}) => ({
      remaining: when(over.or(bug.keepOnUnknown ? over : unbounded), 0, remaining.minus(when(reserved, 1, 0)).plus(when(bug.refund ? known : known.and(known.not()), 1, 0))),
      evaluations: evaluations.plus(when(reserved, 1, 0)),
      tokens: when(over, limit.plus(1), tokens.plus(when(known, input.plus(output), 0))),
    }))

const budget = budgetRule()
const budgetLaws = (r: typeof budget) => ({
  laws: [
    r.law('reported tokens never pass the limit but by the one saturating step', ({tokens, limit}) => tokens.atMost(limit.plus(1))),
    r.law('calls left and calls spent never pass the calls given', ({remaining, evaluations, calls}) => remaining.plus(evaluations).atMost(calls)),
  ],
  steps: [
    r.stepLaw('a reservation needs a call and tokens left', (b, a) => a.evaluations.gt(b.evaluations).implies(b.remaining.gt(0).and(b.tokens.lt(b.limit)))),
    r.stepLaw('unknown or invalid usage stops the budget', (_b, a) => a.remaining.eq(0), (b) => b.unbounded),
    r.stepLaw('reported_overshoot_disables_calls: an overshoot disables every later call', (b, a) => a.remaining.eq(0).and(a.tokens.gt(b.limit)), (b) => b.over),
    r.stepLaw('accounting_never_refunds_a_call: accounting never gives a call back', (b, a) => a.remaining.atMost(b.remaining).and(a.evaluations.eq(b.evaluations)), (b) => b.accounting),
    r.stepLaw('reported tokens never go down', (b, a) => a.tokens.atLeast(b.tokens)),
  ],
})

const budgetHeld = () =>
  budget.compare(
    {
      init: ({calls}) => ({remaining: calls, evaluations: 0, tokens: 0}),
      step: ({limit}, st, {op, usage, input, output}) => {
        const b: Core.Budget = {remaining: st.remaining as number, evaluations: st.evaluations as number, tokens: st.tokens as number, limit}
        if (op === 'reserve') {
          const next = Core.reserve(b) ?? b
          return {remaining: next.remaining, evaluations: next.evaluations, tokens: next.tokens}
        }
        const u: D.Usage = usage === 'known' ? {kind: 'known', input: BigInt(input), output: BigInt(output)} : {kind: usage as 'unknown' | 'invalid'}
        const [next] = D.account(b, u)
        return {remaining: next.remaining, evaluations: next.evaluations, tokens: next.tokens}
      },
    },
    {trials: 600, depth: 12, bound: 30, params: (r: (n: number) => number) => ({calls: r(6), limit: r(30)})},
  )

export const entries: Entry[] = [
  {
    area: 'decision profiles',
    decisions: chooseLaws(choose),
    broken: [
      {what: 'an ambient selector that wins over the explicit one', decision: chooseLaws(chooseFun({ambientFirst: true}))[0]!},
      {what: 'a named provider that still takes the ambient profile', decision: chooseLaws(chooseFun({providerIgnored: true}))[1]!},
    ],
    held: [
      {against: 'Profiles.chooseProfile (every selector over four names)', run: chooseHeld, exhaustive: true},
      {against: 'Profiles.applyDocument (a provider-only request bypasses the document)', run: bypassHeld},
    ],
  },
  {
    area: 'decision profiles',
    decisions: mergeLaws(merge),
    broken: [{what: 'a merge that keeps the old providerOptions', decision: mergeLaws(mergeFun(true))[0]!}],
    held: [{against: 'Profiles.merge (every key, and the field order)', run: mergeHeld}],
  },
  {
    area: 'decision targets',
    decisions: targetLaws(target),
    broken: [{what: 'an explicit provider that inherits DECISION_MODEL', decision: targetLaws(targetFun(true))[0]!}],
    held: [{against: 'Config.configureExplicit (ambient model and endpoint changed, failures included)', run: targetHeld}],
  },
  {
    area: 'decision targets',
    decisions: canonicalLaws(canonical),
    broken: [{what: 'an alias map that swaps vercel back', decision: canonicalLaws(canonicalFun(true))[0]!}],
    held: [{against: 'Config.canonical', run: canonicalHeld, exhaustive: true}],
  },
  (() => {
    const l = budgetLaws(budget)
    const broken = (what: string, bug: Bugs, pick: (x: ReturnType<typeof budgetLaws>) => {laws?: any[]; steps?: any[]}) => {
      const r = budgetRule(bug)
      return {what, rule: r, ...pick(budgetLaws(r))}
    }
    return {
      area: 'the decision budget',
      rule: budget,
      laws: l.laws,
      steps: l.steps,
      from: 'any' as const,
      broken: [
        broken('unknown usage that keeps the calls', {keepOnUnknown: true}, (x) => ({laws: x.laws, steps: [x.steps[1]!]})),
        broken('an overshoot checked only per report, not against what is left', {overshootAfter: true}, (x) => ({laws: [x.laws[0]!]})),
        broken('accounting that refunds a call', {refund: true}, (x) => ({laws: x.laws, steps: [x.steps[3]!]})),
      ],
      held: [{against: 'Core.reserve and Decision.account (rule.compare)', run: budgetHeld}],
    }
  })(),
]
