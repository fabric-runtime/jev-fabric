// native/tests/http.bend and http.test.ts, against src/jev/http.ts: a local
// HTTPS server with a self-signed certificate, posted to by fetch (pooled),
// by the curl executable (exec) and by auto. Nothing leaves 127.0.0.1.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {type Server, createServer} from 'node:https'
import {join, resolve} from 'node:path'
import * as Http from './http.ts'
import * as Policy from './http-core.ts'

const KEY = 'SYNTHETIC_NOT_A_SECRET'
mkdirSync(resolve('.tmp'), {recursive: true})
const dir = mkdtempSync(resolve('.tmp', 'ts-http-'))
const keyFile = join(dir, 'key.pem')
const certFile = join(dir, 'cert.pem')
const unreachableProxy = 'http://127.0.0.1:1'
let server: ReturnType<typeof Bun.serve>
let counting: Server
let handshakes = 0
const requests: {path: string; auth: string | null; body: string}[] = []
const body = JSON.stringify({state: 'quotes " slashes \\ newline\n tab\t emoji 🙂; \\nurl = https://invalid.test/'})

async function respond(req: Request) {
  const path = new URL(req.url).pathname
  requests.push({path, auth: req.headers.get('authorization'), body: await req.text()})
  if (path === '/redirect') return new Response('', {status: 302, headers: {location: `https://localhost:${server.port}/unexpected`}})
  if (path === '/huge') return new Response('x'.repeat(1048577))
  if (path === '/error') return new Response(KEY, {status: 401})
  if (path === '/slow') await Bun.sleep(2500)
  return new Response('ok')
}

beforeAll(() => {
  const p = Bun.spawnSync(
    ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
    {stdout: 'ignore', stderr: 'pipe'},
  )
  expect(p.exitCode, p.stderr.toString()).toBe(0)
  server = Bun.serve({hostname: '127.0.0.1', port: 0, tls: {key: Bun.file(keyFile), cert: Bun.file(certFile)}, fetch: respond})
  counting = createServer({key: readFileSync(keyFile), cert: readFileSync(certFile)}, (req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  counting.on('secureConnection', () => handshakes++)
  return new Promise<void>((ready) => counting.listen(0, '127.0.0.1', ready))
}, 60000)

afterAll(() => {
  server?.stop(true)
  counting?.close()
  rmSync(dir, {recursive: true, force: true})
})

type Options = {trust?: boolean; host?: string; input?: string; port?: number; timeout?: number; transport?: string}

function envOf(o: Options): Http.Env {
  return {
    ...(o.trust === false ? {} : {CURL_CA_BUNDLE: certFile}),
    ...(o.transport === undefined ? {} : {JEV_FABRIC_HTTP: o.transport}),
    HTTPS_PROXY: unreachableProxy,
    ALL_PROXY: unreachableProxy,
  }
}

// The fixture's show(): "ok:<bytes>" or "error".
async function post(path: string, o: Options = {}): Promise<string> {
  const url = `https://${o.host ?? 'localhost'}:${o.port ?? server.port}${path}`
  const env = envOf(o)
  // The exec transport's curl gets the CA bundle through its environment.
  const t: Http.Transport = {
    ...Http.defaultTransport(env),
    capture: (argv, input, ms, limit) =>
      Http.defaultTransport(env).capture(argv[0] === 'curl' ? ['/usr/bin/env', ...(o.trust === false ? [] : [`CURL_CA_BUNDLE=${certFile}`]), ...argv] : argv, input, ms, limit),
  }
  const r = await Http.post(url, KEY, o.input ?? body, o.timeout ?? 1500, env, t)
  const text = r.ok ? `ok:${r.value.length}` : `error:${r.error.message}`
  expect(text).not.toContain(KEY)
  return text
}

describe.each(['auto', 'pooled', 'exec'])('%s transport', (transport) => {
  const run = (path: string, o: Options = {}) => post(path, {...o, transport})

  test('verifies trusted TLS and sends the config and body literally', async () => {
    const before = requests.length
    expect(await run('/ok')).toBe('ok:2')
    const got = requests.slice(before)
    expect(got).toEqual([{path: '/ok', auth: `Bearer ${KEY}`, body}])
  })

  test('unknown CA and wrong hostname fail closed', async () => {
    expect(await run('/ok', {trust: false})).toBe('error:Jev transport failed, was interrupted, or exceeded its output bound')
    expect(await run('/ok', {host: '127.0.0.1'})).toBe('error:Jev transport failed, was interrupted, or exceeded its output bound')
  })

  test('a redirect is not followed and a status error never shows the body', async () => {
    const before = requests.length
    expect(await run('/redirect')).toBe('error:Jev HTTP 302; no automatic retry')
    expect(requests.slice(before).map((r) => r.path)).toEqual(['/redirect'])
    expect(await run('/error')).toBe('error:Jev HTTP 401; no automatic retry')
  })

  test('the body bound and the deadline are enforced', async () => {
    expect(await run('/huge')).toBe('error:Jev transport failed, was interrupted, or exceeded its output bound')
    const started = Date.now()
    expect(await run('/slow')).toBe('error:Jev transport failed, was interrupted, or exceeded its output bound')
    expect(Date.now() - started).toBeLessThan(2400)
  }, 10000)

  test('a request outside the policy is refused before the network', async () => {
    const before = requests.length
    for (const input of ['@/etc/passwd', '', 'x{}']) expect(await run('/ok', {input})).toBe('error:Invalid HTTPS request configuration')
    expect(requests.length).toBe(before)
  })
})

test('pooled reuses one TLS connection; exec pays a handshake per request', async () => {
  handshakes = 0
  for (let i = 0; i < 3; i++) expect(await post('/', {port: (counting.address() as {port: number}).port, transport: 'pooled'})).toBe('ok:2')
  expect(handshakes).toBe(1)
  handshakes = 0
  for (let i = 0; i < 3; i++) expect(await post('/', {port: (counting.address() as {port: number}).port, transport: 'exec'})).toBe('ok:2')
  expect(handshakes).toBe(3)
}, 20000)

test('an unknown transport fails closed before any network access', async () => {
  const before = requests.length
  expect(await post('/ok', {transport: 'curl'})).toBe('error:JEV_FABRIC_HTTP must be auto, pooled or exec')
  expect(requests.length).toBe(before)
})

test('auto falls back to exec only when pooling is unavailable; pooled and exec do not', async () => {
  const exec: string[] = []
  const t = (unavailable: boolean): Http.Transport => ({
    pooled: async () => ({ok: false, unavailable}),
    capture: async (argv, input) => {
      exec.push(argv[0]!)
      expect(input).toContain('data-binary')
      return {ok: true, value: {code: 0, flags: 0, stdout: new TextEncoder().encode('{}\n200'), stderr: new Uint8Array()}}
    },
  })
  const go = (mode: string, unavailable: boolean) => Http.post('https://x.invalid/', KEY, '{}', 1000, {JEV_FABRIC_HTTP: mode}, t(unavailable))
  expect(await go('auto', true)).toEqual({ok: true, value: new TextEncoder().encode('{}')})
  expect(exec).toEqual(['curl'])
  expect(await go('pooled', true)).toEqual(Policy.unavailable())
  expect(await go('auto', false)).toEqual(Policy.transportFailed())
  expect(exec).toEqual(['curl'])
})

describe('HttpCore policy', () => {
  test('valid requests', () => {
    const ok = (url: string, key = KEY, b = '{}', t = 1000) => Policy.valid(url, key, b, t)
    expect(ok('https://h/')).toBe(true)
    expect(ok('http://h/')).toBe(false)
    expect(ok('https://h /')).toBe(false)
    expect(ok(`https://${'h'.repeat(4089)}`)).toBe(false)
    expect(ok(`https://${'h'.repeat(4088)}`)).toBe(true)
    expect(ok('https://h/', '')).toBe(false)
    expect(ok('https://h/', 'a b')).toBe(false)
    expect(ok('https://h/', 'k'.repeat(16385))).toBe(false)
    expect(ok('https://h/', KEY, '[]')).toBe(false)
    expect(ok('https://h/', KEY, '{\u0000}')).toBe(false)
    expect(ok('https://h/', KEY, `{${' '.repeat(1048575)}`)).toBe(true)
    expect(ok('https://h/', KEY, `{${' '.repeat(1048576)}`)).toBe(false)
    expect(ok('https://h/', KEY, '{}', 0)).toBe(false)
    expect(ok('https://h/', KEY, '{}', 3600001)).toBe(false)
  })

  test('the curl config escapes only what curl reads', () => {
    expect(Policy.config('https://h/', KEY, '{"a":"\\"\n\t\r\u000b"}', 1001)).toBe(
      `url = "https://h/"\nrequest = "POST"\nheader = "Content-Type: application/json"\nheader = "Authorization: Bearer ${KEY}"\n` +
        'data-binary = "{\\"a\\":\\"\\\\\\"\\n\\t\\r\\v\\"}"\nmax-time = 2\n',
    )
  })

  test("curl's trailing status", () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(Policy.status(enc('body\n200'))).toEqual({ok: true, value: enc('body')})
    expect(Policy.status(enc('\n204'))).toEqual({ok: true, value: enc('')})
    expect(Policy.status(enc('x\n500'))).toEqual({ok: false, error: {code: 1, message: 'Jev HTTP 500; no automatic retry'}})
    expect(Policy.status(enc('x200'))).toEqual({ok: false, error: {code: 1, message: 'Invalid HTTP transport status'}})
    expect(Policy.status(enc('200'))).toEqual({ok: false, error: {code: 1, message: 'Missing HTTP transport status'}})
    expect(Policy.captured({ok: true, value: {code: 0, flags: 2, stdout: enc('x\n200')}})).toEqual(Policy.transportFailed())
    expect(Policy.captured({ok: false, error: {code: 2, message: 'x'}})).toEqual({ok: false, error: {code: 1, message: 'Jev transport could not start'}})
  })
})
