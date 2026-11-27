// The decision HTTP exchange (native/DecisionHttp.bend): one POST of a
// checked request, every status returned with its bounded body.
//
// 0.8.1 ran the curl executable for every decision. The default here is
// fetch under the same policy (the request checked by DecisionHttpCore
// first; no redirect followed, a 3xx is returned; no proxy, whatever the
// environment; peer and hostname verified, CURL_CA_BUNDLE naming the trust
// anchors; a 16 MiB response bound that fails the transfer rather than
// truncating; the request's whole timeout; no retry). `curlExchange` runs
// the curl executable as 0.8.1 did, with its fixed argv and the config on
// stdin. Both are injectable; tests use a local fake.

import {readFileSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {fail} from '../codec/result.ts'
import type {CaptureFn} from '../jev/capture.ts'
import * as Policy from './http-core.ts'

export type Env = Readonly<Record<string, string | undefined>>
export type Exchange = Policy.Exchange

// A transport sends one checked request and answers its exchange.
export type Transport = (req: Policy.Request, signal?: AbortSignal) => Promise<Result<Exchange>>

type FetchFn = (input: string, init: RequestInit & Record<string, unknown>) => Promise<Response>

async function boundedBody(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const {value, done} = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// fetch under the decision policy (the global fetch unless given).
export function fetchExchange(env: Env = process.env, fetchImpl: FetchFn = fetch as unknown as FetchFn): Transport {
  return async (req, signal) => {
    const failed = fail(1, Policy.TRANSPORT_FAILED)
    let tls: Record<string, unknown> = {rejectUnauthorized: true}
    const ca = env.CURL_CA_BUNDLE
    if (ca) {
      try {
        tls = {rejectUnauthorized: true, ca: readFileSync(ca, 'utf8')}
      } catch {
        return failed
      }
    }
    const timeout = AbortSignal.timeout(req.timeout)
    const headers: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
      ['Accept-Encoding', 'identity'],
      ...Policy.authHeaders(req.key, req.auth),
      ...req.extra.map((line): [string, string] => {
        const at = line.indexOf(': ')
        return [line.slice(0, at), line.slice(at + 2)]
      }),
    ]
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers,
        body: req.body,
        redirect: 'manual',
        proxy: false,
        tls,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
      const bytes = await boundedBody(res, Policy.BYTES_MAX)
      if (bytes === null) return failed
      return Policy.exchangeOf(res.status, bytes)
    } catch {
      return failed
    }
  }
}

// The curl executable, as 0.8.1 ran it: `curl` (a bare name is found on
// `env`'s PATH by the capture) with the fixed argv and the config on stdin.
export function curlExchange(capture: CaptureFn, curl = 'curl', env?: Env): Transport {
  return async (req, signal) => {
    const raw = await capture([curl, ...Policy.ARGV.slice(1)], req.config, req.timeout, Policy.CAPTURE_LIMIT, signal, env)
    return Policy.capturedExchange(raw.ok ? {ok: true, value: {code: raw.value.code, flags: raw.value.flags, stdout: raw.value.stdout}} : raw)
  }
}

export const defaultTransport = (env: Env = process.env): Transport => fetchExchange(env)

// DecisionHttp.exchange_with: the request checked, then sent once.
export async function exchangeWith(
  url: string,
  key: string,
  body: string,
  timeout: number,
  allowLocal: boolean,
  auth: string,
  headers: readonly string[],
  transport: Transport,
  signal?: AbortSignal,
): Promise<Result<Exchange>> {
  const plan = Policy.requestWith(url, key, body, timeout, allowLocal, auth, headers)
  if (!plan.ok) return plan
  return transport(plan.value, signal)
}

export const exchange = (url: string, key: string, body: string, timeout: number, allowLocal: boolean, auth: string, transport: Transport, signal?: AbortSignal) =>
  exchangeWith(url, key, body, timeout, allowLocal, auth, [], transport, signal)

// DecisionHttp.post: a non-2xx status as an error coded with the status.
export async function post(url: string, key: string, body: string, timeout: number, allowLocal: boolean, auth: string, transport: Transport, signal?: AbortSignal): Promise<Result<Uint8Array>> {
  const e = await exchange(url, key, body, timeout, allowLocal, auth, transport, signal)
  return e.ok ? Policy.acceptExchange(e.value) : e
}
