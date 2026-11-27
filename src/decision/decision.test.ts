// One decision on the Jev client's budget, against an injected transport
// (the useful cases of native/tests/decisions.test.ts): the order of
// checks, what each failure spends, and the printed envelope.
import {expect, test} from 'bun:test'
import type {Result} from '../codec/result.ts'
import type {Client} from '../jev/jev.ts'
import * as Jev from '../jev/jev.ts'
import * as Cli from './cli.ts'
import * as D from './decision.ts'
import type {Exchange, Transport} from './http.ts'

const key = 'SYNTHETIC_DECISION_KEY'
const usage = {input_tokens: 4, output_tokens: 2}
const questions = {q: {type: 'boolean', instructions: 'Is this correct?'}}
const request = {provider: 'openai', state: {text: 'evidence'}, questions}
const openaiReply = (answers: unknown[] = [{name: 'q', type: 'predicate', probability: 0.8}], counts: unknown = usage) =>
  JSON.stringify({model: 'actual-model', answers, usage: counts, provider_metadata: {trace: 'retained'}})

type Sent = {url: string; body: string; key: string; extra: readonly string[]}
function fake(replies: string[], status = 200) {
  const sent: Sent[] = []
  const transport: Transport = async (req) => {
    sent.push({url: req.url, body: req.body, key: req.key, extra: req.extra})
    const body = replies[Math.min(sent.length - 1, replies.length - 1)]!
    return {ok: true, value: {status, bytes: new TextEncoder().encode(body)}} as Result<Exchange>
  }
  return {sent, transport}
}

const noJev = {pooled: async () => ({ok: false, unavailable: false}) as const, capture: async () => ({ok: false, error: {code: 1, message: 'no'}}) as never}

function session(env: Record<string, string>, calls = 4, tokens = 100) {
  const c = Jev.fromEnv(30000, calls, tokens, env)
  if (!c.ok) throw new Error(c.error.message)
  return c.value
}

async function decide(c: Client, req: object, deps: D.Deps, credential = '') {
  const [next, result] = await D.evaluate(c, JSON.stringify(req), credential, deps)
  return {next, result, value: result.ok ? (JSON.parse((D.encode(result.value) as {value: string}).value) as any) : undefined}
}

test('a native reply prints httpStatus, budget, status and the lossless envelope', async () => {
  const f = fake([openaiReply()])
  const env = {OPENAI_API_KEY: key}
  const r = await decide(session(env), request, {env, decisionTransport: f.transport, transport: noJev})
  expect(Object.keys(r.value).slice(0, 4)).toEqual(['httpStatus', 'budget', 'status', 'provider'])
  expect(r.value).toMatchObject({httpStatus: 200, budget: {exhausted: false, reason: ''}, status: 'ok', answers: {q: {type: 'boolean', probability: 0.8}}, usage})
  expect(r.value.raw.provider_metadata.trace).toBe('retained')
  expect(f.sent[0]!.url).toBe('https://api.openai.com/v1/decisions')
  expect(f.sent[0]!.key).toBe(key)
  expect(r.next.budget).toMatchObject({remaining: 3, evaluations: 1, tokens: 6})
})

test('unknown usage stays unknown and stops the budget: the next call does not dispatch', async () => {
  const f = fake([JSON.stringify({model: 'm', answers: [{name: 'q', type: 'predicate', probability: 0.8}]})])
  const env = {OPENAI_API_KEY: key}
  const first = await decide(session(env), request, {env, decisionTransport: f.transport})
  expect(first.value.usage).toEqual({input_tokens: null, output_tokens: null})
  expect(first.value.budget).toEqual({exhausted: true, reason: 'unknown-usage'})
  const second = await decide(first.next, request, {env, decisionTransport: f.transport})
  expect(second.result).toEqual({ok: false, error: {code: 1, message: 'decision budget exhausted'}})
  expect(f.sent).toHaveLength(1)
})

test('malformed answers keep the raw text and account usage before ending the budget', async () => {
  const raw = openaiReply([{name: 'wrong', type: 'predicate', probability: 0.8}])
  const f = fake([raw])
  const env = {OPENAI_API_KEY: key}
  const r = await decide(session(env, 4, 5), request, {env, decisionTransport: f.transport})
  expect(r.value).toMatchObject({status: 'error', usage, rawJson: raw, budget: {exhausted: true, reason: 'reported-token-limit'}})
  expect(r.value.error).toEqual({code: 22, message: 'missing wire field'})
})

test('an HTTP failure is a status:error envelope, spends the call and never retries', async () => {
  const raw = '{"error":{"type":"rate_limit","opaque":9007199254740993}}'
  const f = fake([raw], 429)
  const env = {OPENAI_API_KEY: ''}
  const r = await decide(session(env), request, {env, decisionTransport: f.transport}, key)
  expect(r.value).toMatchObject({httpStatus: 429, status: 'error', rawJson: raw, budget: {exhausted: true}})
  expect(f.sent).toHaveLength(1)
  // The request's credential is used, and the client's cached key is untouched.
  expect(f.sent[0]!.key).toBe(key)
  expect(r.next.key).toBe('')
})

test('invalid targets, missing credentials and an exhausted budget spend nothing', async () => {
  const f = fake([openaiReply()])
  const env = {OPENAI_API_KEY: '', ANTHROPIC_API_KEY: ''}
  const c = session(env, 1)
  const bad = await decide(c, {...request, provider: 'unregistered'}, {env, decisionTransport: f.transport})
  expect(bad.result).toEqual({ok: false, error: {code: 22, message: 'Unknown decision provider'}})
  const local = {...request, provider: 'anthropic', allowGenerated: true, allowLocal: true, endpoint: 'http://127.0.0.1:8080/v1/messages'}
  const missing = await decide(bad.next, local, {env, decisionTransport: f.transport})
  expect(missing.result).toEqual({ok: false, error: {code: 1, message: 'Missing provider key or JEV_CREDENTIAL_COMMAND'}})
  expect(missing.next.budget.remaining).toBe(1)
  expect(f.sent).toHaveLength(0)
  const okay = await decide(missing.next, local, {env, decisionTransport: f.transport}, key)
  expect(okay.result.ok).toBe(true)
  expect(f.sent).toHaveLength(1)
  const after = await decide(okay.next, local, {env, decisionTransport: f.transport}, key)
  expect(after.result).toEqual({ok: false, error: {code: 1, message: 'decision budget exhausted'}})
})

test('a loopback bearer target with no key and no command goes anonymous', async () => {
  const f = fake([JSON.stringify({model: 'local', answers: {q: {type: 'noul', noul: 0.8}}, usage})])
  const env = {}
  const r = await decide(session(env), {...request, provider: 'llama-system-one', allowLocal: true}, {env, decisionTransport: f.transport})
  expect(r.value.status).toBe('ok')
  expect(f.sent[0]).toMatchObject({url: 'http://127.0.0.1:8080/v1/systemone', key: ''})
})

test('the deadline is checked before credentials and before dispatch', async () => {
  const f = fake([openaiReply()])
  const env = {OPENAI_API_KEY: key}
  let t = 0
  const late = await decide(session(env), request, {env, decisionTransport: f.transport, now: () => (t += 40000)})
  expect(late.result).toEqual({ok: false, error: {code: 124, message: 'decision deadline expired before credentials'}})
  let u = 0
  const ticks = [0, 0, 40000]
  const later = await decide(late.next, request, {env, decisionTransport: f.transport, now: () => ticks[u++] ?? 40000})
  expect(later.result).toEqual({ok: false, error: {code: 124, message: 'decision deadline expired before dispatch'}})
  expect(later.next.budget.remaining).toBe(4)
  expect(f.sent).toHaveLength(0)
})

test('evaluateFor caps the timeout by the scope and restores the client settings', async () => {
  const f = fake([openaiReply()])
  const env = {OPENAI_API_KEY: key}
  const c = session(env)
  const expired = await D.evaluateFor({started: 0, duration: 10}, c, JSON.stringify(request), '', 3600000, {env, decisionTransport: f.transport, now: () => 20})
  expect(expired[1]).toEqual({ok: false, error: {code: 124, message: 'scope deadline expired before decision'}})
  const [after, result] = await D.evaluateFor({started: 0, duration: 1000000}, expired[0], JSON.stringify(request), '', 3600000, {env, decisionTransport: f.transport, now: () => 1})
  expect(result.ok).toBe(true)
  expect(after.settings.timeout).toBe(30000)
})

test('a used client cannot be evaluated again (affine)', async () => {
  const env = {OPENAI_API_KEY: key}
  const c = session(env)
  await decide(c, {...request, provider: 'unregistered'}, {env, decisionTransport: fake([]).transport})
  await expect(decide(c, request, {env, decisionTransport: fake([]).transport})).rejects.toThrow('consumed')
})

test('the CLI verbs: argument errors and decision-providers', async () => {
  expect(await Cli.decideFlagsFile('x', 'none.json', '1', '{}', {env: {}})).toEqual({stdout: '', stderr: 'decision timeout and token limit must be integers\n', exit: 2})
  const providers = Cli.decisionProviders()
  expect(providers.exit).toBe(0)
  expect(JSON.parse(providers.stdout)).toHaveLength(14)
})
