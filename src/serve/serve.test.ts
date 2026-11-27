// The serve driver from source (`bun src/main.ts -- serve`), for what the
// conformance suite does not cover: the session's one Jev client (one
// credential lookup, a session-wide budget, per-request providers and
// credentials never cached or echoed) and offline target resolution that
// spends nothing. Ported from native/tests/serve.test.ts.
//
// No network: JEV_FABRIC_HTTP=exec sends every legacy Jev request to a fake
// curl first on PATH, which records one letter per dispatch (x for the
// session's credential, r for a per-request one, o for OpenRouter), and
// nothing here dispatches a decision.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {join, resolve} from 'node:path'

const REPO = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO, '.tmp'), {recursive: true})
const root = mkdtempSync(join(REPO, '.tmp', 'serve-unit-'))
const bin = join(root, 'bin')
const home = join(root, 'home')
mkdirSync(bin)
afterAll(() => rmSync(root, {recursive: true, force: true}))

const secret = 'SYNTHETIC_KEY_FOR_SERVE_TESTS'
const requestKey = 'SYNTHETIC_REQUEST_KEY_FOR_SERVE_TESTS'
const noul = {state: 'synthetic', questions: {ok: {type: 'noul', instructions: 'Is two plus two four?'}}}
const reply = {model: 'jev-test', answers: {ok: {type: 'noul', noul: 0.99}}, usage: {input_tokens: 4, output_tokens: 2}}

const fakeCurl = `
import { appendFileSync } from 'node:fs';
const config = await Bun.stdin.text();
const session = config.includes('Authorization: Bearer ${secret}');
const request = config.includes('Authorization: Bearer ${requestKey}');
if (!session && !request) process.exit(9);
appendFileSync(process.env.CURL_RECORD, (request ? 'r' : 'x') + (config.includes('openrouter.ai') ? 'o' : ''));
process.stdout.write(process.env.FAKE_RESPONSE + '\\n200');
`

beforeAll(async () => {
  await Bun.write(join(root, 'curl.ts'), fakeCurl)
  const curl = join(bin, 'curl')
  await Bun.write(curl, `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'curl.ts')}' "$@"\n`)
  chmodSync(curl, 0o700)
  const credential = join(root, 'credential.sh')
  await Bun.write(credential, `#!/bin/sh\nprintf x >> "$CREDENTIAL_RECORD"\nprintf '%s\\n' '${secret}'\n`)
  chmodSync(credential, 0o700)
})

type Env = Record<string, string>

function jevEnv(extra: Env = {}): Env & {CURL_RECORD: string; CREDENTIAL_RECORD: string} {
  const n = Math.random().toString(16).slice(2)
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    JEV_FABRIC_HOME: home,
    JEV_FABRIC_HTTP: 'exec',
    JEV_PROVIDER: 'typesafe',
    TYPESAFE_API_KEY: '',
    JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', join(root, 'credential.sh')]),
    CURL_RECORD: join(root, `curl-${n}`),
    CREDENTIAL_RECORD: join(root, `cred-${n}`),
    FAKE_RESPONSE: JSON.stringify(reply),
    ...extra,
  }
}
const record = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** One serve process from source with a line reader over its stdout. */
class Session {
  readonly child
  private buffered = ''
  private readonly reader
  private readonly decoder = new TextDecoder()

  constructor(args: string[], env: Env) {
    this.child = Bun.spawn([process.execPath, join(REPO, 'src/main.ts'), '--', 'serve', ...args], {env, cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
    this.reader = this.child.stdout.getReader()
  }

  async line(): Promise<any> {
    for (;;) {
      const at = this.buffered.indexOf('\n')
      if (at >= 0) {
        const text = this.buffered.slice(0, at)
        this.buffered = this.buffered.slice(at + 1)
        return JSON.parse(text)
      }
      const {value, done} = await this.reader.read()
      if (done) return undefined
      this.buffered += this.decoder.decode(value, {stream: true})
    }
  }

  async ask(request: unknown): Promise<any> {
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
    this.child.stdin.flush()
    return this.line()
  }

  async close() {
    this.child.stdin.end()
    const [code, err] = await Promise.all([this.child.exited, new Response(this.child.stderr).text()])
    return {code, err}
  }
}

async function session(args: string[], env: Env) {
  const s = new Session(args, env)
  const banner = await s.line()
  return {s, banner}
}

describe.concurrent('one Jev client per session', () => {
  test('one credential lookup and a session-wide call budget', async () => {
    const env = jevEnv()
    const {s} = await session(['2', '1000'], env)
    expect(await s.ask({id: 1, op: 'jev', request: noul})).toEqual({id: 1, ok: true, result: reply})
    expect((await s.ask({id: 2, op: 'jev', request: noul, timeoutMs: 5000})).ok).toBe(true)
    expect(await s.ask({id: 3, op: 'jev', request: noul})).toEqual({id: 3, ok: false, error: {code: 1, message: 'Jev budget exhausted'}})
    const {code, err} = await s.close()
    expect(code).toBe(0)
    expect(err).not.toContain(secret)
    expect(record(env.CURL_RECORD)).toBe('xx')
    // The credential resolved once and stayed cached in the threaded client.
    expect(record(env.CREDENTIAL_RECORD)).toBe('x')
  })

  test('jev never dispatches invalid requests, and defaults to one evaluation; a zero budget dispatches nothing', async () => {
    const env = jevEnv()
    const {s} = await session([], env)
    expect(await s.ask({id: 1, op: 'jev', request: {state: 'x', questions: {}}})).toMatchObject({ok: false, error: {code: 22, message: 'invalid question count'}})
    expect((await s.ask({id: 2, op: 'jev', request: noul})).ok).toBe(true)
    expect((await s.ask({id: 3, op: 'jev', request: noul})).error.message).toBe('Jev budget exhausted')
    await s.close()
    expect(record(env.CURL_RECORD)).toBe('x')
    const none = jevEnv({JEV_CREDENTIAL_COMMAND: ''})
    const bare = await session(['0'], none)
    expect((await bare.s.ask({id: 1, op: 'jev', request: noul})).error.message).toBe('Jev budget exhausted')
    await bare.s.close()
    expect(record(none.CURL_RECORD)).toBe('')
    expect(record(none.CREDENTIAL_RECORD)).toBe('')
  })

  test('jev requests sent together answer in arrival order on the one client', async () => {
    const env = jevEnv()
    const {s} = await session(['2', '1000'], env)
    s.child.stdin.write(`${[1, 2, 3].map((id) => JSON.stringify({id, op: 'jev', request: noul})).join('\n')}\n`)
    s.child.stdin.flush()
    const answers = [await s.line(), await s.line(), await s.line()]
    expect(answers.map((a) => [a.id, a.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ])
    await s.close()
    expect(record(env.CURL_RECORD)).toBe('xx')
  })

  test('a per-request provider and credential apply once, never cached, echoed or logged', async () => {
    const env = jevEnv()
    const {s} = await session(['4', '1000'], env)
    expect(await s.ask({id: 1, op: 'jev', request: noul, credential: requestKey})).toEqual({id: 1, ok: true, result: reply})
    expect(record(env.CREDENTIAL_RECORD)).toBe('')
    expect((await s.ask({id: 2, op: 'jev', request: noul, provider: 'openrouter', credential: requestKey})).ok).toBe(true)
    expect((await s.ask({id: 3, op: 'jev', request: noul})).ok).toBe(true)
    expect(record(env.CREDENTIAL_RECORD)).toBe('x')
    expect(record(env.CURL_RECORD)).toBe('rrox')
    const cases: [Record<string, unknown>, number, string][] = [
      [{id: 4, op: 'jev', request: noul, provider: 'elsewhere'}, 2, 'provider must be typesafe, openrouter, vercel or subq'],
      [{id: 5, op: 'jev', request: noul, credential: ''}, 2, 'credential must be a non-empty string'],
      [{id: 6, op: 'jev', request: noul, credential: 7}, 2, 'credential must be a non-empty string'],
      [{id: 7, op: 'jev', request: noul, credential: `${requestKey}\nsecond line`}, 1, 'Invalid private credential'],
      [{id: 8, op: 'jev', request: {state: 'x', questions: {}}, credential: requestKey}, 22, 'invalid question count'],
    ]
    for (const [request, code, message] of cases) {
      const response = await s.ask(request)
      expect(response).toMatchObject({ok: false, error: {code, message}})
      expect(JSON.stringify(response)).not.toContain(requestKey)
    }
    expect((await s.ask({id: 9, op: 'jev', request: noul, credential: requestKey})).ok).toBe(true)
    expect((await s.ask({id: 10, op: 'jev', request: noul, credential: requestKey})).error.message).toBe('Jev budget exhausted')
    const {code, err} = await s.close()
    expect(code).toBe(0)
    expect(err).not.toContain(requestKey)
    expect(record(env.CURL_RECORD)).toBe('rroxr')
  })
})

describe.concurrent('offline decision targets', () => {
  test('resolveDecision is offline, sanitized and spends none of the session budget', async () => {
    const env = jevEnv({
      DECISION_PROFILES: JSON.stringify({version: 1, defaultProfile: 'direct', profiles: {direct: {provider: 'openai', model: 'profile-model'}}}),
      DECISION_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', join(root, 'credential.sh')]),
    })
    const {s, banner} = await session(['1', '1000'], env)
    expect(banner.ready.features).toContain('decision-targets')
    const expected = {
      target: {provider: 'openai', api: 'openai-decisions', model: 'profile-model', endpoint: 'https://api.openai.com/v1/decisions', allowLocal: false, allowGenerated: false},
      credential: {env: 'OPENAI_API_KEY', resolved: false},
      imageSupport: 'supported',
      generated: false,
      profile: 'direct',
    }
    for (const id of [1, 2]) expect(await s.ask({id, op: 'resolveDecision', request: noul})).toEqual({id, ok: true, result: expected})
    expect(record(env.CREDENTIAL_RECORD)).toBe('')
    expect(record(env.CURL_RECORD)).toBe('')
    expect((await s.ask({id: 3, op: 'jev', request: noul})).ok).toBe(true)
    expect((await s.ask({id: 4, op: 'jev', request: noul})).ok).toBe(false)
    expect((await s.ask({id: 5, op: 'resolveDecision', request: noul})).result).toEqual(expected)
    expect(record(env.CREDENTIAL_RECORD)).toBe('x')
    expect(record(env.CURL_RECORD)).toBe('x')
    expect(await s.close()).toEqual({code: 0, err: ''})
  })

  test('a profile conflict is refused offline without spending a call', async () => {
    const env = jevEnv({DECISION_PROFILES: JSON.stringify({version: 1, profiles: {direct: {provider: 'typesafe'}}})})
    const {s} = await session(['1', '1000'], env)
    const request = {...noul, profile: 'direct'}
    expect((await s.ask({id: 1, op: 'resolveDecision', request})).ok).toBe(true)
    for (const op of ['resolveDecision', 'decide']) {
      const rejected = await s.ask({id: op, op, request: {...request, provider: 'openai'}})
      expect(rejected.ok).toBe(false)
      expect(rejected.error.message).toContain('conflicts')
    }
    // The call refused before dispatch was not spent: the legacy client still has it.
    expect((await s.ask({id: 2, op: 'jev', request: noul})).ok).toBe(true)
    expect(record(env.CURL_RECORD)).toBe('x')
    expect(await s.close()).toEqual({code: 0, err: ''})
  })

  test('malformed profiles do not affect legacy jev or structural validateDecision', async () => {
    const env = jevEnv({DECISION_PROFILES: '{'})
    const {s} = await session([], env)
    const request = {...noul, profile: 'not-configured'}
    expect((await s.ask({id: 1, op: 'validateDecision', request})).result).toEqual(request)
    expect((await s.ask({id: 2, op: 'resolveDecision', request})).ok).toBe(false)
    expect((await s.ask({id: 3, op: 'jev', request: noul})).ok).toBe(true)
    expect(record(env.CURL_RECORD)).toBe('x')
    expect(await s.close()).toEqual({code: 0, err: ''})
  })
})
