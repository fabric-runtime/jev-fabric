// Ported from native/tests/decision-http-core.bend (the pure policy) and
// decision-http-probe.bend + decision-transport.test.ts (the transport),
// against a loopback Bun.serve fake. Never the network.
import {afterAll, expect, test} from 'bun:test'
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import type {Result} from '../codec/result.ts'
import {capture} from '../jev/capture.ts'
import * as H from './http-core.ts'
import * as Http from './http.ts'

// ---- the pure policy (decision-http-core.bend) ---------------------------------

const bytes = (xs: number[]) => new Uint8Array(xs)
const cap = (code: number, flags: number, stdout: number[]): Result<H.Capture> => ({ok: true, value: {code, flags, stdout: bytes(stdout)}})
const failed = (r: Result<unknown>, code: number, message: string) => !r.ok && r.error.code === code && r.error.message === message
const exchangeBytes = (r: Result<H.Exchange>, status: number) => r.ok && r.value.status === status && [...r.value.bytes].join() === '0,255'
const invalid = (url: string) => !H.urlValid(url, true)

test('decision HTTP policy assertions', () => {
  const checks = [
    H.urlValid('https://api.example.com/v1/decision', false),
    exchangeBytes(H.capturedExchange(cap(0, 0, [0, 255, 10, 52, 48, 49])), 401),
    exchangeBytes(H.capturedExchange(cap(0, 0, [0, 255, 10, 51, 48, 50])), 302),
    exchangeBytes(H.capturedExchange(cap(0, 0, [0, 255, 10, 50, 48, 48])), 200),
    !exchangeBytes(H.capturedExchange(cap(0, 1, [0, 255, 10, 50, 48, 48])), 200),
    H.safeChunk('@/etc/passwd') === '\\u0040/etc/passwd',
    H.safeChunk('@-') === '\\u0040-',
    !H.chunkLine('@', 4).ok,
    H.chunkLine('@', 5).ok,
    H.safeChunk('@@@') === '\\u0040@@',
    H.safeChunk('x@-') === 'x@-',
    H.safeChunk('') === '',
    !H.safeChunk('@anything').startsWith('@'),
    H.urlValid('http://127.0.0.1', true),
    H.urlValid('http://[::1]', true),
    H.urlValid('http://[::1]:65535/a/b', true),
    H.urlValid('http://127.0.0.1:00080/a', true),
    H.urlValid('https://api.cloudflare.com/accounts/abc/ai/run/@cf/cloudflare/clef', false),
    !H.urlValid('http://127.0.0.1', false),
    ...[
      'http://localhost:8080',
      'http://127.0.0.2',
      'http://127.1',
      'http://2130706433',
      'http://0177.0.0.1',
      'http://127.0.0.1.evil.com',
      'http://127.0.0.1@evil.com',
      'http://evil@127.0.0.1',
      'http://[::1]evil',
      'http://[::ffff:127.0.0.1]',
      'http://[::1%25lo0]',
      'http://127.0.0.1:',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:80x',
      'http://127.0.0.1:4294967297',
      'http://127.0.0.1/?x=1',
      'https://example.com/#frag',
      'https://user:pass@example.com/path',
      'https://%65xample.com/path',
      'https://example.com\\@evil/path',
      'https://example.com/\nheader=x',
      'ftp://example.com/file',
      'https:///path',
    ].map(invalid),
    H.authValid('KEY', false, 'bearer'),
    !H.authValid('', false, 'bearer'),
    H.authValid('', true, 'bearer'),
    H.authValid('', true, 'none'),
    !H.authValid('', false, 'none'),
    !H.authValid('KEY', true, 'none'),
    !H.authValid('KEY\nInjected: x', true, 'bearer'),
    !H.authValid('', true, 'anthropic'),
    !H.authValid('', true, 'google'),
    !H.authValid('KEY', false, 'bad'),
    H.headers('', 'bearer') === '',
    H.headers('KEY', 'anthropic').includes('x-api-key: KEY'),
    H.headers('KEY', 'anthropic').includes('anthropic-version: 2023-06-01'),
    H.headers('KEY', 'google').includes('x-goog-api-key: KEY'),
    !H.headers('KEY', 'google').includes('Authorization'),
    H.request('http://127.0.0.1', '', '{}', 1, true, 'bearer').ok,
    !H.request('https://example.com', '', '{}', 1, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '{}', 0, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '{}', 3600001, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '\u0000', 10, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '@/etc/passwd', 10, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '@-', 10, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '[]', 10, false, 'bearer').ok,
    !H.request('https://example.com', 'KEY', '{"x":1,"x":2}', 10, false, 'bearer').ok,
    (() => {
      const r = H.captured(cap(0, 0, [0, 255, 10, 50, 48, 48]))
      return r.ok && [...r.value].join() === '0,255'
    })(),
    failed(H.captured(cap(0, 0, [83, 69, 67, 82, 69, 84, 10, 52, 48, 49])), 401, 'Decision HTTP 401; no automatic retry'),
    failed(H.captured(cap(0, 0, [10, 51, 48, 50])), 302, 'Decision HTTP 302; no automatic retry'),
    failed(H.captured({ok: false, error: {code: 5, message: 'SECRET'}}), 1, 'Decision transport could not start'),
    failed(H.captured(cap(7, 0, [])), 1, H.TRANSPORT_FAILED),
    failed(H.captured(cap(0, 1, [10, 50, 48, 48])), 1, H.TRANSPORT_FAILED),
    failed(H.captured(cap(0, 2, [10, 50, 48, 48])), 1, H.TRANSPORT_FAILED),
    failed(H.status(bytes([48, 48, 50])), 1, 'Missing decision HTTP status'),
    failed(H.status(bytes([120, 48, 50, 10])), 1, 'Invalid decision HTTP status'),
  ]
  checks.forEach((ok, i) => expect(ok, `assertion ${i}`).toBe(true))
})

// ---- the transport against a loopback fake ---------------------------------------

mkdirSync(resolve('.tmp'), {recursive: true})
const root = mkdtempSync(resolve('.tmp', 'decision-http-'))
const marker = 'SYNTHETIC_PRIVATE_DECISION_KEY'
const received: {path: string; headers: Headers; body: string}[] = []
let onRequest: (() => void) | undefined
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname
    received.push({path, headers: request.headers, body: await request.text()})
    onRequest?.()
    onRequest = undefined
    if (path === '/redirect') return Response.redirect(`${server.url}target`, 302)
    if (path === '/status') return new Response('PRIVATE_PROVIDER_ERROR_BODY', {status: 401})
    if (path === '/slow') {
      await Bun.sleep(1000)
      return new Response('late')
    }
    if (path === '/big') return new Response(new Uint8Array(2 * 1024 * 1024))
    if (path === '/max') return new Response(new Uint8Array(16 * 1024 * 1024))
    if (path === '/overflow') return new Response(new Uint8Array(16 * 1024 * 1024 + 1))
    if (path === '/chunked-overflow') {
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024 * 1024))
          controller.close()
        },
      })
      return new Response(stream)
    }
    return new Response(new Uint8Array([0, 255]))
  },
})
afterAll(() => {
  server.stop(true)
  rmSync(root, {recursive: true, force: true})
})

function bodyFor(mode: string): string {
  switch (mode) {
    case 'large':
      return `{"payload":"${'x'.repeat(1200000)}"}`
    case 'at-boundary':
      return `{"payload":"${'a'.repeat(16372)}@/does-not-exist${'@'.repeat(40000)}","number":1.234567890123456789e-99}`
    case 'at-stdin-boundary':
      return `{"payload":"${'a'.repeat(16372)}@-"}`
    case 'max-request':
      return `{"payload":"${'x'.repeat(16777202)}"}`
    case 'overflow-request':
      return `{"payload":"${'x'.repeat(16777203)}"}`
    default:
      return '{"payload":"private-body-🙂"}'
  }
}

// The probe's modes: post, exchange, or exchange with headers.
async function run(path = 'ok', auth = 'bearer', key = marker, mode = 'small', transport: Http.Transport = Http.fetchExchange({}), signal?: AbortSignal): Promise<string> {
  const url = `${server.url}${path}`
  const body = bodyFor(mode)
  const show = (r: Result<Uint8Array>) => (r.ok ? `ok:${r.value.length}` : `error:${r.error.code}:${r.error.message}`)
  const showExchange = (r: Result<H.Exchange>) => (r.ok ? `exchange:${r.value.status}:${r.value.bytes.length}` : `error:${r.error.code}:${r.error.message}`)
  let out: string
  if (mode === 'typesafe-headers' || mode === 'foreign-header') {
    const extra = mode === 'typesafe-headers' ? H.EXTRA_HEADERS : ['X-Injected: 1']
    out = showExchange(await Http.exchangeWith(url, key, body, 5000, true, auth, extra, transport, signal))
  } else if (mode === 'exchange') out = showExchange(await Http.exchange(url, key, body, 5000, true, auth, transport, signal))
  else out = show(await Http.post(url, key, body, mode === 'max-request' ? 10000 : mode === 'deadline' ? 350 : 5000, true, auth, transport, signal))
  expect(out).not.toContain(marker)
  expect(out).not.toContain('private-body')
  expect(out).not.toContain('PRIVATE_PROVIDER_ERROR_BODY')
  return out
}

test('byte-exact response and bearer request body', async () => {
  expect(await run()).toBe('ok:2')
  const last = received.at(-1)!
  expect(last.headers.get('authorization')).toBe(`Bearer ${marker}`)
  expect(last.headers.get('content-type')).toBe('application/json')
  expect(JSON.parse(last.body)).toEqual({payload: 'private-body-🙂'})
})

test('TypeSafe opt-in headers are sent; any other extra header is refused before the network', async () => {
  expect(await run('ok', 'bearer', marker, 'typesafe-headers')).toBe('exchange:200:2')
  const last = received.at(-1)!
  expect(last.headers.get('typesafe-danger-zone-images')).toBe('true')
  expect(last.headers.get('typesafe-danger-zone-long-context')).toBe('true')
  const before = received.length
  expect(await run('ok', 'bearer', marker, 'foreign-header')).toBe('error:22:Invalid decision header')
  expect(received.length).toBe(before)
  expect(await run()).toBe('ok:2')
  expect(received.at(-1)!.headers.get('typesafe-danger-zone-images')).toBeNull()
})

test('anthropic and google headers, no bearer header', async () => {
  expect(await run('ok', 'anthropic')).toBe('ok:2')
  expect(received.at(-1)!.headers.get('x-api-key')).toBe(marker)
  expect(received.at(-1)!.headers.get('anthropic-version')).toBe('2023-06-01')
  expect(received.at(-1)!.headers.get('authorization')).toBeNull()
  expect(await run('ok', 'google')).toBe('ok:2')
  expect(received.at(-1)!.headers.get('x-goog-api-key')).toBe(marker)
  expect(received.at(-1)!.headers.get('authorization')).toBeNull()
})

test('anonymous bearer and none only local; header injection rejected before network', async () => {
  expect(await run('ok', 'bearer', '')).toBe('ok:2')
  expect(received.at(-1)!.headers.get('authorization')).toBeNull()
  expect(await run('ok', 'none', '')).toBe('ok:2')
  const before = received.length
  expect(await run('ok', 'bearer', `${marker}\r\nInjected: yes`)).toContain('Invalid decision authentication')
  expect(await run('ok', 'anthropic', '')).toContain('Invalid decision authentication')
  expect(received.length).toBe(before)
})

test('status preserved without provider body, no redirect or retry', async () => {
  let before = received.length
  expect(await run('status')).toBe('error:401:Decision HTTP 401; no automatic retry')
  expect(received.length - before).toBe(1)
  before = received.length
  expect(await run('redirect')).toBe('error:302:Decision HTTP 302; no automatic retry')
  expect(received.length - before).toBe(1)
  expect(received.some((r) => r.path === '/target')).toBe(false)
})

test('exchange preserves non2xx status and bounded raw body without following redirects', async () => {
  expect(await run('ok', 'bearer', marker, 'exchange')).toBe('exchange:200:2')
  expect(await run('status', 'bearer', marker, 'exchange')).toBe(`exchange:401:${'PRIVATE_PROVIDER_ERROR_BODY'.length}`)
  expect(await run('redirect', 'bearer', marker, 'exchange')).toBe('exchange:302:0')
  expect(received.some((r) => r.path === '/target')).toBe(false)
})

test('environment proxies are ignored', async () => {
  const saved = {...process.env}
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) process.env[k] = 'http://127.0.0.1:1'
  try {
    expect(await run()).toBe('ok:2')
  } finally {
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})

test('curl exec: private config holds secrets and body, fixed argv never does', async () => {
  const fake = join(root, 'curl')
  const argvPath = join(root, 'argv')
  const configPath = join(root, 'config')
  writeFileSync(fake, `#!/bin/sh\nprintf "%s\\n" "$@" > '${argvPath}'\n/bin/cat > '${configPath}'\nprintf "\\000\\377\\n200"\n`)
  chmodSync(fake, 0o700)
  expect(await run('ok', 'bearer', marker, 'small', Http.curlExchange(capture, fake))).toBe('ok:2')
  const argv = readFileSync(argvPath, 'utf8')
  const config = readFileSync(configPath, 'utf8')
  expect(argv.split('\n')[0]).toBe('--disable')
  expect(argv).not.toContain(marker)
  expect(argv).not.toContain('private-body')
  expect(argv).not.toContain(server.url.toString())
  expect(config).toContain(marker)
  expect(config).toContain('private-body-🙂')
  for (const line of config.split('\n').filter((l) => l.startsWith('json = '))) expect(JSON.parse(line.slice(7)).startsWith('@')).toBe(false)
})

test('chunk-leading @ runs remain JSON data; the curl config escapes them', async () => {
  expect(await run('ok', 'bearer', marker, 'at-boundary')).toBe('ok:2')
  const body = received.at(-1)!.body
  expect(JSON.parse(body).payload).toBe(`${'a'.repeat(16372)}@/does-not-exist${'@'.repeat(40000)}`)
  expect(body).toContain('1.234567890123456789e-99')
  const plan = H.request(`${server.url}ok`, marker, bodyFor('at-boundary'), 5000, true, 'bearer')
  expect(plan.ok && plan.value.config.includes('\\\\u0040/does-not-exist')).toBe(true)
  expect(await run('ok', 'bearer', marker, 'at-stdin-boundary')).toBe('ok:2')
  expect(JSON.parse(received.at(-1)!.body).payload).toBe(`${'a'.repeat(16372)}@-`)
})

test('request and response above legacy 1 MiB succeed', async () => {
  expect(await run('ok', 'bearer', marker, 'large')).toBe('ok:2')
  expect(JSON.parse(received.at(-1)!.body).payload.length).toBe(1200000)
  expect(await run('big')).toBe('ok:2097152')
}, 30000)

test('16 MiB response succeeds; known and unknown-length overflow fail closed', async () => {
  expect(await run('max')).toBe('ok:16777216')
  expect(await run('overflow')).toContain('Decision transport failed')
  expect(await run('chunked-overflow')).toContain('Decision transport failed')
}, 60000)

test('16 MiB request succeeds and one extra byte is rejected before dispatch', async () => {
  expect(await run('ok', 'bearer', marker, 'max-request')).toBe('ok:2')
  expect(new TextEncoder().encode(received.at(-1)!.body).length).toBe(16777216)
  const before = received.length
  expect(await run('ok', 'bearer', marker, 'overflow-request')).toContain('JSON byte limit')
  expect(received.length).toBe(before)
}, 60000)

test('cancellation interrupts a running request', async () => {
  const controller = new AbortController()
  const seen = new Promise<void>((done) => {
    onRequest = done
  })
  const pending = run('slow', 'bearer', marker, 'small', Http.fetchExchange({}), controller.signal)
  await seen
  controller.abort()
  expect(await pending).toContain('Decision transport failed')
}, 10000)

test('the deadline interrupts exactly one attempt', async () => {
  const before = received.length
  const start = performance.now()
  expect(await run('slow', 'bearer', marker, 'deadline')).toContain('Decision transport failed')
  expect(performance.now() - start).toBeLessThan(2500)
  expect(received.length - before).toBe(1)
}, 10000)
