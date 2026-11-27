// The decision HTTP policy (native/DecisionHttpCore.bend): which endpoints,
// credentials and bodies may be sent, the curl config of the exec
// transport, and how a transport's capture becomes an exchange. Pure: no
// environment, no shell, no redirects, no retry.
//
// HTTPS anywhere; plain HTTP only to the exact loopback 127.0.0.1 or [::1]
// with allowLocal. No userinfo, query, fragment or backslash; percent
// escapes only in the path. A 16 MiB request and response bound.

import * as Codec from '../codec/codec.ts'
import type {Result} from '../codec/result.ts'
import {Failure, attempt, done, fail, guard, unwrap} from '../codec/result.ts'
import {cpLength} from '../codec/text.ts'
import {keyValid, quote, visible} from '../jev/http-core.ts'

export const BYTES_MAX = 16777216
export const CAPTURE_LIMIT = 16777220

const isDigit = (n: number) => n >= 48 && n <= 57

// 1..65535 in decimal digits (leading zeros allowed), at least one digit.
function port(s: string): boolean {
  if (s.length === 0) return false
  let value = 0
  for (let i = 0; i < s.length; i++) {
    const n = s.charCodeAt(i)
    if (!(isDigit(n) && value <= 6553)) return false
    value = value * 10 + (n - 48)
  }
  return value >= 1 && value <= 65535
}

const suffix = (s: string): boolean => s === '' || (s.startsWith(':') && port(s.slice(1)))

export const hostChars = (s: string): boolean => /^[0-9A-Za-z.-]*$/.test(s)
const host = (s: string) => s !== '' && hostChars(s)

function hostPort(parts: string[]): boolean {
  if (parts.length === 1) return host(parts[0]!)
  if (parts.length === 2) return host(parts[0]!) && port(parts[1]!)
  return false
}

const authorityValid = (a: string, ipv6: boolean): boolean => (ipv6 ? suffix(a.slice(5)) : hostPort(a.split(':')))

// What follows the scheme, up to the first slash.
export function authority(url: string): string {
  const rest = url.startsWith('https://') ? url.slice(8) : Array.from(url).slice(7).join('')
  return rest.split('/')[0] ?? ''
}

const localAuthority = (s: string): boolean => (s.startsWith('127.0.0.1') && suffix(s.slice(9))) || (s.startsWith('[::1]') && suffix(s.slice(5)))

export const isLocal = (url: string): boolean => (url.startsWith('https://') || url.startsWith('http://')) && localAuthority(authority(url))

export function urlValid(url: string, allowLocal: boolean): boolean {
  const a = authority(url)
  return (
    cpLength(url) <= 4096 &&
    visible(url) &&
    !url.includes('?') &&
    !url.includes('#') &&
    !url.includes('\\') &&
    authorityValid(a, a.startsWith('[::1]')) &&
    (url.startsWith('https://') || (allowLocal && url.startsWith('http://') && localAuthority(a)))
  )
}

export function authValid(key: string, local: boolean, auth: string): boolean {
  switch (auth) {
    case 'bearer':
      return keyValid(key) || (local && key === '')
    case 'anthropic':
    case 'google':
      return keyValid(key)
    case 'none':
      return local && key === ''
    default:
      return false
  }
}

// The provider's auth headers, as [name, value] (no Authorization for an
// anonymous loopback request).
export function authHeaders(key: string, auth: string): [string, string][] {
  switch (auth) {
    case 'bearer':
      return key === '' ? [] : [['Authorization', `Bearer ${key}`]]
    case 'anthropic':
      return [
        ['x-api-key', key],
        ['anthropic-version', '2023-06-01'],
      ]
    case 'google':
      return [['x-goog-api-key', key]]
    default:
      return []
  }
}

// The curl config lines of those headers.
export const headers = (key: string, auth: string): string =>
  authHeaders(key, auth)
    .map(([n, v]) => (n === 'anthropic-version' ? `header = "${n}: ${v}"\n` : `header = ${quote(`${n}: ${v}`)}\n`))
    .join('')

// curl --json concatenates chunks, but a chunk-leading @ means a file even
// in config quotes: escape only that @ (the body is strict JSON, so it is
// inside a string), preserving every value and lexeme.
export const safeChunk = (s: string): string => (s.startsWith('@') ? `\\u0040${s.slice(1)}` : s)

export type Chunk = {remaining: number; line: string}

export function chunkLine(chunk: string, budget: number): Result<Chunk> {
  const extra = chunk.startsWith('@') ? 5 : 0
  if (budget < extra) return fail(22, 'Decision encoded request exceeds 16 MiB')
  return done({remaining: budget - extra, line: `json = ${quote(safeChunk(chunk))}\n`})
}

// Chunks of 16384 scalars, each at most 64 KiB of UTF-8, below curl's
// config-line limit; their escape expansion shares the byte budget.
export function bodyConfig(body: string, budget: number): string {
  const cps = Array.from(body)
  const lines: string[] = []
  for (let i = 0; i === 0 || i < cps.length; i += 16384) {
    const chunk = unwrap(chunkLine(cps.slice(i, i + 16384).join(''), budget))
    budget = chunk.remaining
    lines.push(chunk.line)
  }
  return lines.join('')
}

export const EXTRA_HEADERS = ['TypeSafe-Danger-Zone-Images: true', 'TypeSafe-Danger-Zone-Long-Context: true']
export const extraValid = (extra: readonly string[]): boolean => extra.every((line) => EXTRA_HEADERS.includes(line))

const headerLines = (extra: readonly string[]) => extra.map((line) => `header = ${quote(line)}\n`).join('')

export function config(url: string, key: string, data: string, ms: number, auth: string, extra: readonly string[]): string {
  return (
    `url = ${quote(url)}\nrequest = "POST"\n` +
    `header = "Content-Type: application/json"\n${headers(key, auth)}${headerLines(extra)}${data}max-time = ${Math.floor((ms + 999) / 1000)}\n`
  )
}

// A checked request: what may be sent, and the exec transport's config.
export type Request = {url: string; key: string; body: string; timeout: number; auth: string; extra: readonly string[]; config: string}

export const requestWith = (url: string, key: string, body: string, timeout: number, allowLocal: boolean, auth: string, extra: readonly string[]): Result<Request> =>
  attempt(() => {
    guard(extraValid(extra), 'Invalid decision header')
    guard(urlValid(url, allowLocal), 'Invalid decision endpoint')
    guard(authValid(key, allowLocal && isLocal(url), auth), 'Invalid decision authentication')
    guard(timeout >= 1 && timeout <= 3600000, 'Invalid decision timeout')
    const checked = unwrap(Codec.readWithLimit(body, BYTES_MAX))
    if (checked.t !== 'obj') throw new Failure(22, 'Decision request body must be a JSON object')
    const left = stringCost(body, BYTES_MAX)
    const data = bodyConfig(body, left)
    return {url, key, body, timeout, auth, extra, config: config(url, key, data, timeout, auth, extra)}
  })

export const request = (url: string, key: string, body: string, timeout: number, allowLocal: boolean, auth: string): Result<Request> =>
  requestWith(url, key, body, timeout, allowLocal, auth, [])

function stringCost(s: string, budget: number): number {
  const bytes = new TextEncoder().encode(s).length
  guard(bytes <= budget, 'JSON string/byte limit')
  return budget - bytes
}

// No caller inputs in argv; --disable first; an explicit empty proxy; no redirect.
export const ARGV: readonly string[] = [
  'curl',
  '--disable',
  '--silent',
  '--show-error',
  '--globoff',
  '--proto',
  '=https,http',
  '--proto-redir',
  '=https',
  '--max-redirs',
  '0',
  '--proxy',
  '',
  '--noproxy',
  '*',
  '--connect-timeout',
  '10',
  '--max-filesize',
  '16777216',
  '--write-out',
  '\n%{http_code}',
  '--config',
  '-',
]

export type Exchange = {status: number; bytes: Uint8Array}

export const TRANSPORT_FAILED = 'Decision transport failed, timed out, was interrupted, or exceeded its output bound'

const httpFailure = (code: number) => fail(code, `Decision HTTP ${code}; no automatic retry`)

// Every status 100..599 is an exchange with its bounded body; a redirect is
// returned, never followed.
export function exchangeOf(status: number, bytes: Uint8Array): Result<Exchange> {
  if (!(status >= 100 && status <= 599)) return fail(22, 'Invalid decision HTTP status')
  if (bytes.length > BYTES_MAX) return fail(22, 'Decision response exceeds 16 MiB')
  return done({status, bytes})
}

// curl's --write-out appends "\n%{http_code}".
export function exchangeStatus(bytes: Uint8Array): Result<Exchange> {
  const n = bytes.length
  if (n < 4) return fail(1, 'Missing decision HTTP status')
  const [nl, a, b, c] = [bytes[n - 4]!, bytes[n - 3]!, bytes[n - 2]!, bytes[n - 1]!]
  if (!(isDigit(a) && isDigit(b) && isDigit(c) && nl === 10)) return fail(1, 'Invalid decision HTTP status')
  return exchangeOf((a - 48) * 100 + (b - 48) * 10 + (c - 48), bytes.subarray(0, n - 4))
}

export type Capture = {code: number; flags: number; stdout: Uint8Array}

export function capturedExchange(result: Result<Capture>): Result<Exchange> {
  if (!result.ok) return fail(1, 'Decision transport could not start')
  const {code, flags, stdout} = result.value
  if (code !== 0 || flags !== 0) return fail(1, TRANSPORT_FAILED)
  return exchangeStatus(stdout)
}

// A non-2xx status as an error whose code is the status.
export function acceptExchange(e: Exchange): Result<Uint8Array> {
  return e.status >= 200 && e.status < 300 ? done(e.bytes) : httpFailure(e.status)
}

export function captured(result: Result<Capture>): Result<Uint8Array> {
  const e = capturedExchange(result)
  return e.ok ? acceptExchange(e.value) : e
}

export const status = (bytes: Uint8Array): Result<Uint8Array> => {
  const e = exchangeStatus(bytes)
  return e.ok ? acceptExchange(e.value) : e
}
