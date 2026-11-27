// native/tests/jev-client.bend and jev.test.ts, against src/jev: two
// evaluations threaded through one client, a fake transport standing in for
// the network (it records what would have been sent), real credential
// commands under .tmp/. Nothing reaches the network.

import {afterAll, beforeAll, expect, test} from 'bun:test'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import type {Transport} from './http.ts'
import * as Jev from './jev.ts'
import * as Policy from './jev-core.ts'
import * as Session from './session.ts'

mkdirSync(resolve('.tmp'), {recursive: true})
const root = mkdtempSync(resolve('.tmp', 'ts-jev-'))
const secret = 'SYNTHETIC_KEY_FOR_NATIVE_TESTS'
const request = JSON.stringify({state: 'synthetic', questions: {ok: {type: 'noul', instructions: 'Is two plus two four?'}}})
const response = {model: 'jev-test', answers: {ok: {type: 'noul', noul: 0.99, debug: secret}}, usage: {input_tokens: 4, output_tokens: 2}, debug: secret}

beforeAll(() => {
  writeFileSync(join(root, 'credential.sh'), `#!/bin/sh\nprintf x >> "$1"\nprintf '%s\\n' '${secret}'\n`)
  writeFileSync(join(root, 'bad-credential.sh'), `#!/bin/sh\nprintf '${secret}\\n' >&2\nprintf '${secret}\\n'\nexit 1\n`)
  chmodSync(join(root, 'credential.sh'), 0o700)
  chmodSync(join(root, 'bad-credential.sh'), 0o700)
})
afterAll(() => rmSync(root, {recursive: true, force: true}))

type Row = {url: string; key: string; body: string; timeoutMs: number}
type Options = {
  calls?: number
  tokens?: number
  key?: string
  command?: string
  request?: string
  response?: unknown
  status?: number
  fail?: boolean
  provider?: string
  invalidUtf8?: boolean
}
let serial = 0

// The fake network: records each dispatch and answers as configured.
function fake(o: Options, rows: Row[]): Transport {
  return {
    pooled: async (req) => {
      rows.push({url: req.url, key: req.key, body: req.body, timeoutMs: req.timeoutMs})
      if (o.fail) return {ok: false, unavailable: false}
      const body = o.invalidUtf8 ? new Uint8Array([255]) : new TextEncoder().encode(JSON.stringify(o.response ?? response))
      return {ok: true, status: o.status ?? 200, body}
    },
    capture: async () => {
      throw new Error('the exec transport is not used here')
    },
  }
}

const show = (r: Result<Json>): string => {
  if (!r.ok) return `error:${r.error.message}`
  const e = Codec.encode(r.value)
  return e.ok ? e.value : `error:${e.error.message}`
}

// jev-client.bend: two evaluations of one request through one client.
async function run(o: Options = {}) {
  const n = serial++
  const cred = join(root, `cred-${n}`)
  const rows: Row[] = []
  const keyEnv = o.provider === 'subq' ? 'SUBQ_API_KEY' : 'TYPESAFE_API_KEY'
  const env = {[keyEnv]: o.key ?? secret, JEV_PROVIDER: o.provider ?? 'typesafe', JEV_MODEL: 'jev-test-model', JEV_CREDENTIAL_COMMAND: o.command?.replace('$RECORD', cred) ?? ''}
  const deps: Jev.Deps = {env, transport: fake(o, rows)}
  const client = Jev.fromEnv(1500, o.calls ?? 2, o.tokens ?? 100, env)
  const out: string[] = []
  if (!client.ok) out.push(`die:${client.error.message}`)
  else {
    const [next, first] = await Jev.evaluate(client.value, o.request ?? request, deps)
    out.push(show(first))
    const [, second] = await Jev.evaluate(next, o.request ?? request, deps)
    out.push(show(second))
  }
  const text = out.join('\n')
  expect(text).not.toContain(secret)
  return {out: text, rows, credentials: existsSync(cred) ? readFileSync(cred, 'utf8') : ''}
}

const credentialCommand = (...argv: string[]) => ({key: '', command: JSON.stringify(argv)})
const goodCredential = () => credentialCommand('/bin/sh', join(root, 'credential.sh'), '$RECORD')

test('the client normalizes typed replies and keeps secrets out of output', async () => {
  const r = await run()
  expect(r.rows.length).toBe(2)
  expect(r.out.split('\n')).toEqual(Array(2).fill('{"model":"jev-test","answers":{"ok":{"type":"noul","noul":0.99}},"usage":{"input_tokens":4,"output_tokens":2}}'))
  expect(r.rows.every((x) => x.url === 'https://api.typesafe.ai/v1/systemone' && x.key === secret)).toBe(true)
  expect(JSON.parse(r.rows[0]!.body).model).toBe('jev-test-model')
  expect(r.rows[0]!.body.startsWith('{"model":"jev-test-model","state":')).toBe(true)
})

test('JEV_PROVIDER=subq sends the same request to SubQ with SUBQ_API_KEY', async () => {
  const r = await run({provider: 'subq'})
  expect(r.rows.map((x) => x.url)).toEqual(Array(2).fill('https://api.subq.ai/v1/systemone'))
  expect((await run()).rows.some((x) => x.url.includes('subq'))).toBe(false)
})

test('a credential command resolves privately once, then is cached in the threaded client', async () => {
  const r = await run(goodCredential())
  expect(r.credentials).toBe('x')
  expect(r.rows.length).toBe(2)
  expect(r.rows.every((x) => x.key === secret)).toBe(true)
})

test('invalid request, provider, credential config and multiline keys never dispatch', async () => {
  const cases: [Options, string][] = [
    [{request: '{}'}, 'error:Invalid Jev request'],
    [{key: '', command: 'not-json'}, 'error:Credential command must be a JSON argv array'],
    [{key: 'x\ny'}, 'error:Invalid private credential'],
    [{provider: 'unknown'}, 'die:JEV_PROVIDER must be typesafe, openrouter, vercel, or subq'],
    [credentialCommand('/bin/sh', join(root, 'bad-credential.sh')), 'error:Private credential command failed'],
    [{key: '', command: ''}, 'error:Missing provider key or JEV_CREDENTIAL_COMMAND'],
  ]
  for (const [o, first] of cases) {
    const r = await run(o)
    expect(r.rows.length).toBe(0)
    expect(r.out.split('\n')[0]).toBe(first)
  }
})

test('a reservation limits calls; failed HTTP has no retries and no refund', async () => {
  for (const o of [{calls: 1}, {calls: 1, status: 401}, {calls: 1, fail: true}]) {
    const r = await run(o)
    expect(r.rows.length).toBe(1)
    expect(r.out.split('\n')[1]).toBe('error:Jev budget exhausted')
  }
  expect((await run({calls: 1, status: 401})).out.split('\n')[0]).toBe('error:Jev HTTP 401; no automatic retry')
})

test('a reported token overshoot disables later calls without overflow', async () => {
  const max = 281474976710655
  for (const usage of [
    {input_tokens: 4, output_tokens: 2},
    {input_tokens: max, output_tokens: max},
  ]) {
    const r = await run({tokens: 5, response: {...response, usage}})
    expect(r.rows.length).toBe(1)
    expect(r.out.split('\n')).toEqual(['error:Jev reported-token budget exceeded; final request may still be billed', 'error:Jev budget exhausted'])
  }
})

test('credential deadline and output bounds fail privately before dispatch', async () => {
  const start = Date.now()
  const slow = await run(credentialCommand('/bin/sh', '-c', 'sleep 3; printf never'))
  expect(slow.rows.length).toBe(0)
  expect(slow.out.split('\n')[0]).toBe('error:Private credential command failed')
  expect(Date.now() - start).toBeLessThan(4300)
  const flood = await run(credentialCommand('/bin/sh', '-c', 'head -c 20000 /dev/zero'))
  expect(flood.rows.length).toBe(0)
  expect(flood.out.split('\n')[0]).toBe('error:Private credential command failed')
  const zero = await run({tokens: 0, ...goodCredential()})
  expect(zero.credentials).toBe('')
  expect(zero.rows.length).toBe(0)
}, 15000)

test('a zero budget blocks credential retrieval; malformed responses are sanitized', async () => {
  const zero = await run({calls: 0, ...goodCredential()})
  expect(zero.credentials).toBe('')
  expect(zero.rows.length).toBe(0)
  const utf8 = await run({calls: 1, invalidUtf8: true})
  expect(utf8.rows.length).toBe(1)
  expect(utf8.out.split('\n')[0]).toBe('error:Invalid UTF-8 Jev response')
  const bad = await run({calls: 1, response: {secret}})
  expect(bad.rows.length).toBe(1)
  expect(bad.out.split('\n')).toEqual(['error:Invalid typed Jev response', 'error:Jev budget exhausted'])
})

const env = {TYPESAFE_API_KEY: secret}
const okBody = JSON.stringify(response)

test('the request timer: credential time is spent from it, an expired one never dispatches', async () => {
  const rows: Row[] = []
  let clock = 1000
  const c = Jev.fromEnv(500, 2, 100, env)
  if (!c.ok) throw new Error(c.error.message)
  const deps: Jev.Deps = {env, transport: fake({}, rows), now: () => (clock += 200)}
  const [next, first] = await Jev.evaluate(c.value, request, deps)
  expect(first.ok).toBe(true)
  expect(rows.map((r) => r.timeoutMs)).toEqual([300])
  expect(next.budget).toEqual({remaining: 1, evaluations: 1, tokens: 6, limit: 100})
  const late: Jev.Deps = {...deps, now: () => (clock += 600)}
  const [after, second] = await Jev.evaluate(next, request, late)
  expect(second).toEqual({ok: false, error: {code: 1, message: 'Jev request timed out before dispatch'}})
  expect(after.budget).toEqual(next.budget)
  expect(rows.length).toBe(1)
})

test('a client is affine: a consumed client cannot evaluate again', async () => {
  const c = Jev.fromEnv(1000, 2, 100, env)
  if (!c.ok) throw new Error(c.error.message)
  const deps: Jev.Deps = {env, transport: fake({}, [])}
  await Jev.evaluate(c.value, request, deps)
  expect(Policy.isConsumed(c.value)).toBe(true)
  await expect(Jev.evaluate(c.value, request, deps)).rejects.toThrow('already consumed')
})

test('settings: timeout and model bounds, provider routes, model override', () => {
  expect(Jev.fromEnv(0, 1, 1, env)).toEqual({ok: false, error: {code: 1, message: 'Invalid Jev timeout or model'}})
  expect(Jev.fromEnv(3600001, 1, 1, env).ok).toBe(false)
  expect(Jev.fromEnv(1, 1, 1, {...env, JEV_MODEL: 'm'.repeat(129)}).ok).toBe(false)
  expect(Jev.fromEnv(1, 1, 1, {...env, JEV_MODEL: '🙂'.repeat(128)}).ok).toBe(true)
  const routed = (provider: string) => {
    const c = Jev.fromEnv(1, 1, 1, {JEV_PROVIDER: provider, OPENROUTER_API_KEY: 'o', AI_GATEWAY_API_KEY: 'v'})
    return c.ok ? [c.value.settings.endpoint, c.value.settings.model, c.value.key] : c.error.message
  }
  expect(routed('')).toEqual(['https://api.typesafe.ai/v1/systemone', 'jev-latest', ''])
  expect(routed('openrouter')).toEqual(['https://openrouter.ai/api/alpha/decisions', '~typesafe/jev-latest', 'o'])
  expect(routed('vercel')).toEqual(['https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev', 'v'])
  expect(Jev.connect(1, 1, {...env, JEV_FABRIC_JEV_TIMEOUT_MS: '0'})).toEqual({ok: false, error: {code: 2, message: 'timeout must be an integer within the operation limit'}})
  const c = Jev.connect(1, 1, {...env, JEV_FABRIC_JEV_TIMEOUT_MS: '000042'})
  expect(c.ok && c.value.settings.timeout).toBe(42)
})

test('a scope deadline: a spent scope never dispatches; the settings come back', async () => {
  const rows: Row[] = []
  const c = Jev.fromEnv(30000, 3, 100, env)
  if (!c.ok) throw new Error(c.error.message)
  const deps: Jev.Deps = {env, transport: fake({}, rows), now: () => 10_000}
  const [a, first] = await Session.evaluateFor({started: 0, duration: 10_000}, c.value, request, 30000, deps)
  expect(first).toEqual({ok: false, error: {code: 124, message: 'scope deadline expired before Jev evaluation'}})
  const [b, second] = await Session.evaluateFor({started: 0, duration: 12_000}, a, request, 5000, deps)
  expect(second.ok).toBe(true)
  expect(rows.map((r) => r.timeoutMs)).toEqual([2000])
  expect(b.settings.timeout).toBe(30000)
  const [, third] = await Session.evaluateFor({started: 0, duration: 12_000}, b, request, 0, deps)
  expect(third).toEqual({ok: false, error: {code: 2, message: 'timeout must be an integer within the operation limit'}})
})

test('a session: one budget, one cached key; per-request provider and credential apply once', async () => {
  const rows: Row[] = []
  const recorded = join(root, 'session-cred')
  const sessionEnv = {JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', join(root, 'credential.sh'), recorded]), SUBQ_API_KEY: 'subq-key', JEV_MODEL: ''}
  const c = Jev.fromEnv(30000, 4, 1000, sessionEnv)
  if (!c.ok) throw new Error(c.error.message)
  const s = new Session.JevSession(c.value)
  const deps: Jev.Deps = {env: sessionEnv, transport: fake({response: JSON.parse(okBody)}, rows)}
  const scope = {started: Date.now(), duration: 60_000}
  const answers = await Promise.all([
    s.evaluate(scope, request, 30000, '', '', deps),
    s.evaluate(scope, request, 30000, 'subq', '', deps),
    s.evaluate(scope, request, 30000, '', 'per-request-key', deps),
    s.evaluate(scope, request, 30000, '', '', deps),
    s.evaluate(scope, request, 30000, '', '', deps),
  ])
  expect(answers.map((a) => a.ok)).toEqual([true, true, true, true, false])
  expect(answers[4]).toEqual({ok: false, error: {code: 1, message: 'Jev budget exhausted'}})
  expect(rows.map((r) => [r.url, r.key])).toEqual([
    ['https://api.typesafe.ai/v1/systemone', secret],
    ['https://api.subq.ai/v1/systemone', 'subq-key'],
    ['https://api.typesafe.ai/v1/systemone', 'per-request-key'],
    ['https://api.typesafe.ai/v1/systemone', secret],
  ])
  expect(JSON.parse(rows[1]!.body).model).toBe('subq-snap-preview')
  // The command ran once: the key it gave was cached by the session.
  expect(readFileSync(recorded, 'utf8')).toBe('x')
  expect(s.client.budget).toEqual({remaining: 0, evaluations: 4, tokens: 24, limit: 1000})
  expect(s.client.settings.endpoint).toBe('https://api.typesafe.ai/v1/systemone')
})
