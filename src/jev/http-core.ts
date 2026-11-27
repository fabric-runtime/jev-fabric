// The HTTPS policy every Jev transport enforces (native/HttpCore.bend): what
// may be sent, the curl configuration and fixed argv of the exec transport,
// and how a transport's answer becomes a body or an error. Pure: no IO.
//
// A request is sent only if it passes `valid`: an https:// URL of visible
// ASCII up to 4096 characters, a key of 1..16384 visible ASCII characters, a
// JSON object body of at most 1 MiB characters without NUL, and a timeout of
// 1..3600000 ms. There are no retries: any non-2xx status is an error.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {cpLength} from '../codec/text.ts'

export const BODY_LIMIT = 1048576
export const URL_MAX = 4096
export const KEY_MAX = 16384
export const CONNECT_TIMEOUT_MS = 10000
export const TIMEOUT_MAX_MS = 3600000
// curl's 1 MiB --max-filesize body plus the "\n" and 3-digit status it writes after it.
export const CAPTURE_LIMIT = 1048580

// Curl config is not JSON: only these escapes have curl-config semantics.
function escaped(c: string): string {
  switch (c) {
    case '"':
      return '\\"'
    case '\\':
      return '\\\\'
    case '\n':
      return '\\n'
    case '\r':
      return '\\r'
    case '\t':
      return '\\t'
    case '\u000b':
      return '\\v'
    default:
      return c
  }
}

export const quote = (s: string): string => `"${Array.from(s, escaped).join('')}"`

export function visible(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i)
    if (n < 33 || n > 126) return false
  }
  return true
}

export const noNul = (s: string): boolean => !s.includes('\u0000')

export const keyValid = (key: string): boolean => key.length > 0 && cpLength(key) <= KEY_MAX && visible(key)

// The exec transport's config, read by curl from stdin: the key and body
// never reach argv.
export function config(url: string, key: string, body: string, ms: number): string {
  const seconds = Math.floor((ms + 999) / 1000)
  return (
    `url = ${quote(url)}\nrequest = "POST"\n` +
    `header = "Content-Type: application/json"\n` +
    `header = ${quote(`Authorization: Bearer ${key}`)}\n` +
    `data-binary = ${quote(body)}\nmax-time = ${seconds}\n`
  )
}

// There are no caller or credential inputs to argv.
export const ARGV: readonly string[] = [
  'curl',
  '--disable',
  '--silent',
  '--show-error',
  '--globoff',
  '--proto',
  '=https',
  '--proxy',
  '',
  '--noproxy',
  '*',
  '--connect-timeout',
  '10',
  '--max-filesize',
  '1048576',
  '--write-out',
  '\n%{http_code}',
  '--config',
  '-',
]

export function valid(url: string, key: string, body: string, timeout: number): boolean {
  return (
    url.startsWith('https://') &&
    visible(url) &&
    cpLength(url) <= URL_MAX &&
    keyValid(key) &&
    body.startsWith('{') &&
    noNul(body) &&
    cpLength(body) <= BODY_LIMIT &&
    timeout >= 1 &&
    timeout <= TIMEOUT_MAX_MS
  )
}

export type Request = {config: string; timeout: number}

export function request(url: string, key: string, body: string, timeout: number): Result<Request> {
  if (!valid(url, key, body, timeout)) return fail(1, 'Invalid HTTPS request configuration')
  return done({config: config(url, key, body, timeout), timeout})
}

export const httpError = (code: number): {ok: false; error: {code: number; message: string}} =>
  fail(1, `Jev HTTP ${code}; no automatic retry`)

const digit = (n: number) => n >= 48 && n <= 57

// curl's --write-out appends "\n%{http_code}": the body is what precedes it.
export function status(bytes: Uint8Array): Result<Uint8Array> {
  const n = bytes.length
  if (n < 4) return fail(1, 'Missing HTTP transport status')
  const [nl, a, b, c] = [bytes[n - 4]!, bytes[n - 3]!, bytes[n - 2]!, bytes[n - 1]!]
  if (!(digit(a) && digit(b) && digit(c) && nl === 10)) return fail(1, 'Invalid HTTP transport status')
  const code = (a - 48) * 100 + (b - 48) * 10 + (c - 48)
  return code >= 200 && code < 300 ? done(bytes.subarray(0, n - 4)) : httpError(code)
}

// A capture of the curl executable: exit code, flags (timed out, cut,
// cancelled), and stdout.
export type Capture = {code: number; flags: number; stdout: Uint8Array}

export function captured(result: Result<Capture>): Result<Uint8Array> {
  if (!result.ok) return fail(1, 'Jev transport could not start')
  const {code, flags, stdout} = result.value
  if (code !== 0 || flags !== 0) return transportFailed()
  return status(stdout)
}

// JEV_FABRIC_HTTP: `pooled` keeps warm connections (fetch here, the system
// libcurl in 0.8.1); `exec` runs the curl executable per request; `auto`, the
// default, is pooled with exec as the fallback when pooling is unavailable.
export type Transport = 'auto' | 'pooled' | 'exec'

export function transport(mode: string): Result<Transport> {
  if (mode === '' || mode === 'auto') return done('auto')
  if (mode === 'pooled' || mode === 'exec') return done(mode)
  return fail(1, 'JEV_FABRIC_HTTP must be auto, pooled or exec')
}

// The pooled body arrives in order with a separate status.
export const pooledStatus = (code: number, bytes: Uint8Array): Result<Uint8Array> =>
  code >= 200 && code < 300 ? done(bytes) : httpError(code)

export const transportFailed = () => fail(1, 'Jev transport failed, was interrupted, or exceeded its output bound')
export const unavailable = () => fail(1, 'Pooled HTTPS transport unavailable: libcurl could not be loaded')
