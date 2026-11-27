// The Jev client: its one budget, its cached credential, the order of its
// checks (validation before credentials, a reservation before dispatch, a
// deadline before dispatch), complete answer validation and no retries; and
// the budget's small decisions (Core.reserve, account, settle, after). Each
// rule or decision is held to the real code: the client rule beside the very
// walk Jev.evaluate drives (Policy.evaluation), answered from a script.
//
// Ported from native/tests/proofs.bend and the Jev, budget, HTTP and
// credential laws of native/tests/policy-proofs.bend.

import {bool, fun, nat, oneOf, rule, when} from 'gdp-wired'
import type {Result} from '../src/codec/result.ts'
import * as Core from '../src/jev/core.ts'
import * as CredentialCore from '../src/jev/credential-core.ts'
import * as HttpCore from '../src/jev/http-core.ts'
import * as Policy from '../src/jev/jev-core.ts'
import type {Entry} from './kit.ts'
import {rand} from './kit.ts'

// ---- The client over a run of evaluations ---------------------------------------
//
// One request is one evaluation. What it brings:
//   op      'invalid' (the request or its model fails validation) or 'send'
//   cred    whether the credential command (run only when no key is cached)
//           gives a valid key
//   late    whether the timer ran out while the credential resolved
//   reply   what the dispatch answers: a typed reply ('ok', with `input` and
//           `output` reported tokens), a non-2xx status or a transport
//           failure ('http'), or a reply that fails validation ('bad')
// The state is the budget (remaining calls, evaluations, reported tokens),
// whether a key is cached, how often the credential command ran and how many
// requests went out.

type Bugs = {refund?: boolean; retry?: boolean; ignoreTokens?: boolean; credFirst?: boolean; spendLate?: boolean; refetch?: boolean; acceptBad?: boolean}

const clientRule = (bug: Bugs = {}) =>
  rule('jev client')
    .params({calls: nat, limit: nat})
    .inputs({op: oneOf('invalid', 'send'), cred: bool, late: bool, reply: oneOf('ok', 'http', 'bad'), input: nat, output: nat})
    .state({remaining: ({calls}) => calls, evaluations: 0, tokens: 0, cached: bool.from(false), runs: 0, sent: 0, accepted: 0})
    .flags(({op, cred, late, reply, input, output, remaining, tokens, cached, limit}) => {
      const reserved = op.is('send').and(remaining.gt(0)).and(bug.ignoreTokens ? remaining.gt(0) : tokens.lt(limit))
      // The credential is resolved only once a call is reserved (or, with the
      // bug, as soon as the request is valid).
      const resolving = bug.credFirst ? op.is('send') : reserved
      const keyed = cached.or(cred)
      const go = reserved.and(keyed).and(bug.spendLate ? late.or(late.not()) : late.not())
      const over = input.gt(limit).or(output.gt(limit))
      const answered = go.and(reply.is('ok').or(bug.acceptBad ? reply.is('bad') : reply.is('ok').not().and(reply.is('ok'))))
      return {reserved, resolving, keyed, go, over, answered}
    })
    .step(({reserved, resolving, keyed, go, over, answered, reply, input, output, remaining, evaluations, tokens, cached, runs, sent, accepted, limit}) => {
      const counted = answered.and(over.not())
      const next = tokens.plus(when(counted, input.plus(output), 0))
      return {
        remaining: when(answered.and(over), 0, remaining.minus(when(go.and(bug.refund ? reply.is('ok') : go), 1, 0))),
        evaluations: evaluations.plus(when(go, 1, 0)),
        tokens: when(answered.and(over), limit.plus(1), next),
        cached: when(resolving, keyed, cached),
        runs: runs.plus(when(resolving.and(bug.refetch ? resolving : cached.not()), 1, 0)),
        sent: sent.plus(when(go, bug.retry ? when(reply.is('http'), 2, 1) : 1, 0)),
        accepted: accepted.plus(when(counted.and(next.atMost(limit)), 1, 0)),
      }
    })

const client = clientRule()
const clientLaws = (r: typeof client) => ({
  laws: [
    r.law('one budget: requests sent never pass the calls given', ({sent, calls}) => sent.atMost(calls)),
    r.law('a request sent is an evaluation counted: no retries', ({sent, evaluations}) => sent.eq(evaluations)),
    r.law('calls left and calls spent never pass the calls given', ({remaining, evaluations, calls}) => remaining.plus(evaluations).atMost(calls)),
  ],
  steps: [
    r.stepLaw('reservation before dispatch: a request goes out only with a call and tokens left', (b, a) => a.sent.gt(b.sent).implies(b.remaining.gt(0).and(b.tokens.lt(b.limit)))),
    r.stepLaw('validation before credentials: an invalid request runs no command and sends nothing', (b, a) => a.runs.eq(b.runs).and(a.sent.eq(b.sent)).and(a.remaining.eq(b.remaining)), (b) => b.op.is('invalid')),
    r.stepLaw('a budget spent never resolves a credential', (b, a) => a.runs.eq(b.runs), (b) => b.remaining.eq(0).or(b.tokens.atLeast(b.limit))),
    r.stepLaw('a cached credential is never fetched again', (b, a) => a.runs.eq(b.runs), (b) => b.cached),
    r.stepLaw('a deadline passed before dispatch sends nothing and spends nothing', (b, a) => a.sent.eq(b.sent).and(a.remaining.eq(b.remaining)), (b) => b.late),
    r.stepLaw('a failed dispatch spends its call: nothing refunds one', (b, a) => a.remaining.plus(1).eq(b.remaining), (b) => b.go.and(b.reply.is('http'))),
    r.stepLaw('a reply that fails validation is never accepted', (b, a) => a.accepted.eq(b.accepted), (b) => b.reply.is('bad')),
    r.stepLaw('an overshoot disables every later call', (b, a) => a.remaining.eq(0).and(a.tokens.gt(b.limit)), (b) => b.answered.and(b.over)),
    r.stepLaw('reported tokens never go down', (b, a) => a.tokens.atLeast(b.tokens)),
  ],
})

// The walk Jev.evaluate drives, answered from the request, beside the rule.
const KEY = 'SYNTHETIC_NOT_A_SECRET'
const noulRequest = JSON.stringify({state: {}, questions: {q: {type: 'noul', instructions: 'x'}}})
const replyText = (input: number, output: number) => JSON.stringify({model: 'jev', answers: {q: {type: 'noul', noul: 0.5}}, usage: {input_tokens: input, output_tokens: output}})
const settings: Policy.Settings = {endpoint: 'https://example.invalid/', model: 'jev-latest', command: '["cred"]', timeout: 1000}

type Req = {op: 'invalid' | 'send'; cred: boolean; late: boolean; reply: 'ok' | 'http' | 'bad'; input: number; output: number}
type Seen = {runs: number; sent: number; accepted: number}

function walk(c: Policy.Client, q: Req, seen: Seen): Policy.Client {
  const w = Policy.evaluation(c, q.op === 'invalid' ? '{"state":{}}' : noulRequest)
  let clock = 0
  let step = w.next()
  while (!step.done) {
    const e = step.value
    let answer: unknown
    if (e.k === 'now') answer = clock += q.late ? 1000 : 1
    else if (e.k === 'credential') {
      // Credentials.resolve: a cached key is checked; else the command runs.
      if (e.key !== '') answer = CredentialCore.check(e.key)
      else {
        seen.runs++
        answer = q.cred ? CredentialCore.check(`${KEY}\n`) : CredentialCore.captured({ok: true, value: {code: 1, flags: 0, stdout: new Uint8Array()}})
      }
    } else {
      seen.sent++
      const text = q.reply === 'ok' ? replyText(q.input, q.output) : '{"model":"jev"}'
      answer = q.reply === 'http' ? HttpCore.pooledStatus(500, new Uint8Array()) : HttpCore.pooledStatus(200, new TextEncoder().encode(text))
    }
    step = w.next(answer)
  }
  const [next, result] = step.value
  if (result.ok) seen.accepted++
  return next
}

type Raw = Record<string, unknown>
function beside<R extends {compiled(): any; encodeParams(p: any): any; encodeInput(i: any): any; decode(s: any): Raw; name: string}>(
  r: R,
  trials: number,
  body: (draw: (n: number) => number, step: (params: Raw | null, input: Raw | null, want: Raw) => string | undefined) => string | undefined,
): {checked: number; failure?: string} {
  const g = r.compiled()
  let checked = 0
  for (let t = 0; t < trials; t++) {
    const draw = rand(1000 + t)
    let ps: unknown
    let st: unknown
    const trace: unknown[] = []
    const failure = body(draw, (params, input, want) => {
      if (params) {
        ps = r.encodeParams(params)
        st = g.init(ps)
      }
      if (input) {
        trace.push(input)
        st = g.step(ps, st, r.encodeInput(input))
      }
      checked++
      const got = r.decode(st)
      for (const [k, v] of Object.entries(want)) if (got[k] !== v) return `${r.name}: ${k} is ${String(got[k])} in the rule, ${String(v)} in the code, after ${JSON.stringify(trace)}`
      return undefined
    })
    if (failure) return {checked, failure}
  }
  return {checked}
}

const clientHeld = () =>
  beside(client, 500, (draw, step) => {
    const calls = draw(4)
    const limit = draw(3) === 0 ? 0 : draw(30)
    let c = Policy.client(settings, Core.budget(calls, limit), '')
    const seen: Seen = {runs: 0, sent: 0, accepted: 0}
    const state = () => ({remaining: c.budget.remaining, evaluations: c.budget.evaluations, tokens: c.budget.tokens, cached: c.key !== '', ...seen})
    let failure = step({calls, limit}, null, state())
    for (let i = 0; i < 10 && !failure; i++) {
      const q: Req = {
        op: draw(5) === 0 ? 'invalid' : 'send',
        cred: draw(4) > 0,
        late: draw(6) === 0,
        reply: (['ok', 'ok', 'http', 'bad'] as const)[draw(4)]!,
        input: draw(8) === 0 ? 40 : draw(8),
        output: draw(8),
      }
      c = walk(c, q, seen)
      failure = step(null, q, state())
    }
    return failure
  })

// ---- Core's decisions (proofs.bend, policy-proofs.bend) -------------------------

const reserveFun = (bug: {ignoreZero?: boolean; ignoreTokens?: boolean} = {}) =>
  fun('reserve')
    .inputs({remaining: nat, evaluations: nat, tokens: nat, limit: nat})
    .returns(({remaining, evaluations, tokens, limit}) => {
      const ok = (bug.ignoreZero ? remaining.atLeast(0) : remaining.gt(0)).and(bug.ignoreTokens ? tokens.atLeast(0) : tokens.lt(limit))
      return {ok, remaining: when(ok, remaining.minus(1), remaining), evaluations: when(ok, evaluations.plus(1), evaluations), tokens}
    })
const reserve = reserveFun()
const reserveLaws = (f: typeof reserve) => [
  f.law('exhausted_never_reserves: no call left, no reservation', ({remaining}) => [remaining.eq(0)], ({ok}) => ok.not()),
  f.law('zero_token_budget_blocks: tokens at the limit, no reservation', ({tokens, limit}) => [tokens.atLeast(limit)], ({ok}) => ok.not()),
  f.law('reservation_consumes_one: a reservation takes exactly one call and counts one evaluation', (_e, {ok}) => [ok], (out, e) => out.remaining.plus(1).eq(e.remaining).and(out.evaluations.eq(e.evaluations.plus(1)))),
]
const reserveHeld = () => {
  let n = 0
  for (let remaining = 0; remaining < 5; remaining++)
    for (let evaluations = 0; evaluations < 4; evaluations++)
      for (let tokens = 0; tokens < 6; tokens++)
        for (let limit = 0; limit < 6; limit++) {
          const want = reserve.run({remaining, evaluations, tokens, limit}) as {ok: boolean; remaining: number; evaluations: number}
          const got = Core.reserve({remaining, evaluations, tokens, limit})
          const same = want.ok ? got !== null && got.remaining === want.remaining && got.evaluations === want.evaluations && got.tokens === tokens && got.limit === limit : got === null
          if (!same) return {checked: n, failure: `reserve(${remaining}, ${evaluations}, ${tokens}, ${limit}): ${JSON.stringify(got)} vs ${JSON.stringify(want)}`}
          n++
        }
  return {checked: n, exhaustive: true}
}

const accountFun = (refund = false) =>
  fun('account')
    .inputs({remaining: nat, tokens: nat, reported: nat})
    .returns(({remaining, tokens, reported}) => ({remaining: refund ? remaining.plus(1) : remaining, tokens: tokens.plus(reported)}))
const account = accountFun()
const accountLaw = (f: typeof account) => f.law('accounting_never_refunds_a_call: accounting adds the tokens and leaves the calls', () => [], (out, e) => out.remaining.eq(e.remaining).and(out.tokens.eq(e.tokens.plus(e.reported))))
const accountHeld = () => {
  const r = rand(7)
  for (let t = 0; t < 2000; t++) {
    const b: Core.Budget = {remaining: r(10), evaluations: r(10), tokens: r(1000), limit: r(1000)}
    const reported = r(1000)
    const got = Core.account(b, reported)
    const want = account.run({remaining: b.remaining, tokens: b.tokens, reported}) as {remaining: number; tokens: number}
    if (got.remaining !== want.remaining || got.tokens !== want.tokens || got.evaluations !== b.evaluations || got.limit !== b.limit) return {checked: t, failure: `account(${JSON.stringify(b)}, ${reported})`}
  }
  return {checked: 2000}
}

const STATES = ['running', 'completed', 'attention', 'failed', 'cancelled', 'timedOut'] as const
const settleFun = (sloppy = false) =>
  fun('settle')
    .inputs({state: oneOf(...STATES), result: oneOf(...STATES)})
    .returns(({state, result}) => ({next: when(state.is('running').or(sloppy ? state.is('failed') : state.is('running').not().and(state.is('running'))), result, state)}))
const settle = settleFun()
const terminal = (f: typeof settle, s: (typeof STATES)[number], name: string) => f.law(`${name}: a ${s} state never changes`, ({state}) => [state.is(s)], ({next}) => next.is(s))
const settleLaws = (f: typeof settle) => [
  terminal(f, 'cancelled', 'cancelled_is_terminal'),
  terminal(f, 'completed', 'completed_is_terminal'),
  terminal(f, 'failed', 'failure_is_terminal'),
  terminal(f, 'timedOut', 'timeout_is_terminal'),
]
const settleHeld = () => {
  let n = 0
  for (const state of STATES)
    for (const result of STATES) {
      const want = (settle.run({state, result}) as {next: string}).next
      const got = Core.settle(state, result)
      if (got !== want) return {checked: n, failure: `settle(${state}, ${result}): ${got} vs ${want}`}
      n++
    }
  return {checked: n, exhaustive: true}
}

const RECEIPTS = ['executed', 'stale', 'blocked', 'unknown'] as const
const afterFun = (sloppy = false) =>
  fun('after')
    .inputs({receipt: oneOf(...RECEIPTS)})
    .returns(({receipt}) => ({
      verify: receipt.is('executed').or(sloppy ? receipt.is('unknown') : receipt.is('executed')),
      inspect: receipt.is('unknown').and(sloppy ? receipt.is('executed') : receipt.is('unknown')),
      reobserve: receipt.is('stale'),
      escalate: receipt.is('blocked'),
    }))
const after = afterFun()
const afterLaws = (f: typeof after) => [
  f.law('unknown_requires_inspection: an unknown receipt asks for inspection, never verification', ({receipt}) => [receipt.is('unknown')], ({inspect, verify}) => inspect.and(verify.not())),
  f.law('dispatch_requires_verification: an executed receipt asks for verification', ({receipt}) => [receipt.is('executed')], ({verify}) => verify),
]
const afterHeld = () => {
  let n = 0
  for (const receipt of RECEIPTS) {
    const want = after.run({receipt}) as Record<string, boolean>
    const got = Core.after(receipt)
    const name = Object.entries(want).find(([, v]) => v)?.[0]
    if (got !== name || Object.values(want).filter(Boolean).length !== 1) return {checked: n, failure: `after(${receipt}): ${got} vs ${JSON.stringify(want)}`}
    n++
  }
  return {checked: n, exhaustive: true}
}

// ---- What may be sent (HttpCore.valid / request) ---------------------------------
//
// A request reaches a transport only when every check passes; a rejected one
// is the fixed configuration error, with no request and nothing of the key.

const sendFun = (sloppy = false) =>
  fun('https request')
    .inputs({https: bool, urlVisible: bool, urlLen: nat, keyLen: nat, keyVisible: bool, object: bool, nul: bool, bodyLen: nat, timeout: nat})
    .returns(({https, urlVisible, urlLen, keyLen, keyVisible, object, nul, bodyLen, timeout}) => ({
      sent: (sloppy ? urlVisible : https.and(urlVisible))
        .and(urlLen.atMost(4096))
        .and(keyLen.gt(0).and(keyLen.atMost(16384)).and(keyVisible))
        .and(object.and(nul.not()).and(bodyLen.atMost(1048576)))
        .and(timeout.atLeast(1).and(timeout.atMost(3600000))),
    }))
const send = sendFun()
const sendLaws = (f: typeof send) => [
  f.law('https_only: nothing but an https:// URL is ever sent', ({https}) => [https.not()], ({sent}) => sent.not()),
  f.law('rejected_http_has_no_request: an empty or invisible key is never sent', ({keyLen, keyVisible}) => [keyLen.eq(0).or(keyVisible.not())], ({sent}) => sent.not()),
  f.law('a body past 1 MiB, or not a JSON object, is never sent', ({bodyLen, object}) => [bodyLen.gt(1048576).or(object.not())], ({sent}) => sent.not()),
  f.law('the timeout is 1 ms to an hour', ({timeout}) => [timeout.eq(0).or(timeout.gt(3600000))], ({sent}) => sent.not()),
]
const sendHeld = () => {
  const r = rand(17)
  const pick = <T>(xs: readonly T[]) => xs[r(xs.length)]!
  for (let t = 0; t < 3000; t++) {
    const url = pick(['https://h/', 'http://h/', 'https://h /', `https://${'h'.repeat(4088)}`, `https://${'h'.repeat(4089)}`, 'https://é/', 'HTTPS://h/'])
    const key = pick(['', 'k', 'a b', 'x\ny', 'k'.repeat(16384), 'k'.repeat(16385), KEY])
    const body = pick(['{}', '[]', '{\u0000}', `{${' '.repeat(1048575)}`, `{${' '.repeat(1048576)}`, ''])
    const timeout = pick([0, 1, 1000, 3600000, 3600001])
    const visible = (s: string) => HttpCore.visible(s)
    const want = (send.run({
      https: url.startsWith('https://'),
      urlVisible: visible(url),
      urlLen: url.length,
      keyLen: key.length,
      keyVisible: visible(key),
      object: body.startsWith('{'),
      nul: body.includes('\u0000'),
      bodyLen: body.length,
      timeout,
    }) as {sent: boolean}).sent
    const got = HttpCore.request(url, key, body, timeout)
    if (got.ok !== want) return {checked: t, failure: `request(${url.slice(0, 20)}, key ${key.length}, body ${body.length}, ${timeout})`}
    if (!got.ok && (got.error.message !== 'Invalid HTTPS request configuration' || got.error.message.includes(key || '\u0001'))) return {checked: t, failure: 'a rejected request names more than the fixed error'}
  }
  return {checked: 3000}
}

// A rejected credential is the fixed error; the key never appears in it.
const credentialHeld = () => {
  const r = rand(19)
  const samples = [' ', 'a b', 'x\ny', '', '\u0000', 'é', 'k'.repeat(16385)]
  for (let t = 0; t < 500; t++) {
    const raw = `${samples[r(samples.length)]}${KEY.slice(0, r(KEY.length))}`
    const got = CredentialCore.check(raw)
    const trimmed = raw.trim()
    const ok = trimmed.length > 0 && trimmed.length <= 16384 && HttpCore.visible(trimmed)
    if (got.ok !== ok) return {checked: t, failure: `check(${JSON.stringify(raw.slice(0, 20))})`}
    if (!got.ok && (got.error.code !== 1 || got.error.message !== 'Invalid private credential')) return {checked: t, failure: 'rejected credential message'}
  }
  return {checked: 500}
}

// A failed transport (any flag, any exit) gives no bytes.
const transportHeld = () => {
  const r = rand(23)
  for (let t = 0; t < 500; t++) {
    const code = r(3)
    const flags = r(2) === 0 ? 0 : 1 << r(4)
    const got: Result<Uint8Array> = HttpCore.captured({ok: true, value: {code, flags, stdout: new TextEncoder().encode('{}\n200')}})
    if (got.ok !== (code === 0 && flags === 0)) return {checked: t, failure: `captured(${code}, ${flags})`}
  }
  return {checked: 500}
}

// The walk validates the request before anything else, with the codec.
const validationFirstHeld = () => {
  const bad = ['', '{', '{"state":{}}', JSON.stringify({state: {}, questions: {}}), '[]', 'x'.repeat(10)]
  let n = 0
  for (const text of bad) {
    const w = Policy.evaluation(Policy.client(settings, Core.budget(1, 10), ''), text)
    const first = w.next()
    if (!first.done) return {checked: n, failure: `an invalid request (${text}) reached ${first.value.k}`}
    if (first.value[1].ok) return {checked: n, failure: 'accepted'}
    n++
  }
  return {checked: n}
}

export const entries: Entry[] = [
  (() => {
    const l = clientLaws(client)
    const bad = (what: string, bug: Bugs, pick: (l: ReturnType<typeof clientLaws>) => {laws?: any[]; steps?: any[]}) => {
      const r = clientRule(bug)
      return {what, rule: r, ...pick(clientLaws(r))}
    }
    return {
      area: 'the Jev client',
      rule: client,
      laws: l.laws,
      steps: l.steps,
      broken: [
        bad('a failed dispatch refunded', {refund: true}, (x) => ({laws: x.laws, steps: [x.steps[5]!]})),
        bad('a failed dispatch retried', {retry: true}, (x) => ({laws: [x.laws[1]!]})),
        bad('a reservation that ignores the reported tokens', {ignoreTokens: true}, (x) => ({laws: x.laws, steps: [x.steps[0]!]})),
        bad('the credential resolved before the reservation', {credFirst: true}, (x) => ({laws: x.laws, steps: [x.steps[2]!]})),
        bad('a dispatch after the deadline', {spendLate: true}, (x) => ({laws: x.laws, steps: [x.steps[4]!]})),
        bad('a cached key fetched again', {refetch: true}, (x) => ({laws: x.laws, steps: [x.steps[3]!]})),
        bad('a reply that fails validation accepted', {acceptBad: true}, (x) => ({laws: x.laws, steps: [x.steps[6]!]})),
      ],
      held: [
        {against: 'JevCore.evaluation, the walk Jev.evaluate drives (answered from a script)', run: clientHeld},
        {against: 'JevCore.evaluation validates before any effect', run: validationFirstHeld},
      ],
    }
  })(),
  {
    area: 'the Jev budget',
    decisions: reserveLaws(reserve),
    broken: [
      {what: 'a reservation from an exhausted budget', decision: reserveLaws(reserveFun({ignoreZero: true}))[0]!},
      {what: 'a reservation past the token limit', decision: reserveLaws(reserveFun({ignoreTokens: true}))[1]!},
    ],
    held: [{against: 'Core.reserve (every value below 5, 4, 6, 6)', run: reserveHeld, exhaustive: true}],
  },
  {
    area: 'the Jev budget',
    decisions: [accountLaw(account)],
    broken: [{what: 'accounting that refunds a call', decision: accountLaw(accountFun(true))}],
    held: [{against: 'Core.account', run: accountHeld}],
  },
  {
    area: 'terminal states and receipts',
    decisions: settleLaws(settle),
    broken: [{what: 'a failed state settled again', decision: settleLaws(settleFun(true))[2]!}],
    held: [{against: 'Core.settle (every pair)', run: settleHeld, exhaustive: true}],
  },
  {
    area: 'terminal states and receipts',
    decisions: afterLaws(after),
    broken: [{what: 'an unknown receipt taken as verified', decision: afterLaws(afterFun(true))[0]!}],
    held: [{against: 'Core.after (every receipt)', run: afterHeld, exhaustive: true}],
  },
  {
    area: 'what HTTPS may send',
    decisions: sendLaws(send),
    broken: [{what: 'a plain http:// URL sent', decision: sendLaws(sendFun(true))[0]!}],
    held: [
      {against: 'HttpCore.request', run: sendHeld},
      {against: 'CredentialCore.check (rejections name no key)', run: credentialHeld},
      {against: 'HttpCore.captured (a failed transport gives no bytes)', run: transportHeld},
    ],
  },
]
