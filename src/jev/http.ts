// The Jev HTTPS POST (native/Http.bend, native/http.c): fetch for the pooled
// transport, the curl executable for exec, both under HttpCore's policy.
//
// fetch is called with the policy http.c set on libcurl: the request checked
// first (https only, bounded URL, key and body), no redirects followed (a
// 3xx is a non-2xx status), no proxy whatever the environment says, peer
// and hostname verified (CURL_CA_BUNDLE may name the trust anchors), no
// netrc (fetch reads none), a 1 MiB body bound that aborts rather than
// truncates, the request's whole timeout, and no retries. The transport is
// injectable: tests hand it a local fake and never reach the network.

import {readFileSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import type {CaptureFn} from './capture.ts'
import {capture as defaultCapture} from './capture.ts'
import * as Policy from './http-core.ts'

export type Env = Readonly<Record<string, string | undefined>>

// What the pooled transport answers: a status and the body in order, or a
// failure (`unavailable` when the transport cannot run at all, which lets
// `auto` fall back to exec).
export type Pooled = {ok: true; status: number; body: Uint8Array} | {ok: false; unavailable: boolean}

export type PostRequest = {url: string; key: string; body: string; timeoutMs: number; headers?: readonly [string, string][]}

export type Transport = {
  // The pooled POST (fetch by default).
  pooled: (req: PostRequest, signal?: AbortSignal) => Promise<Pooled>
  // A bounded child process capture, for the exec transport.
  capture: CaptureFn
}

type FetchFn = (input: string, init: RequestInit & Record<string, unknown>) => Promise<Response>

// Reads a response body up to `limit` bytes; past it the transfer is cancelled.
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
    const {value, done: end} = await reader.read()
    if (end) break
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

// A pooled transport over `fetch` (the global one unless given).
export function fetchPooled(env: Env = process.env, fetchImpl: FetchFn = fetch as unknown as FetchFn) {
  return async (req: PostRequest, signal?: AbortSignal): Promise<Pooled> => {
    const ca = env.CURL_CA_BUNDLE
    let tls: Record<string, unknown> = {rejectUnauthorized: true}
    if (ca) {
      try {
        tls = {rejectUnauthorized: true, ca: readFileSync(ca, 'utf8')}
      } catch {
        return {ok: false, unavailable: false}
      }
    }
    const timeout = AbortSignal.timeout(req.timeoutMs)
    const headers: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['Accept-Encoding', 'identity'],
      ...(req.headers ?? []),
      ['Authorization', `Bearer ${req.key}`],
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
      const body = await boundedBody(res, Policy.BODY_LIMIT)
      if (body === null) return {ok: false, unavailable: false}
      return {ok: true, status: res.status, body}
    } catch {
      return {ok: false, unavailable: false}
    }
  }
}

export const defaultTransport = (env: Env = process.env): Transport => ({pooled: fetchPooled(env), capture: defaultCapture})

// The exec transport: the checked request's config on curl's stdin, the
// fixed argv, the capture bounded to the body plus the status curl writes.
// `curl` is found on the PATH of the environment the request runs in, as
// 0.8.1's execvp found it; the child runs in that environment.
async function execute(plan: Result<Policy.Request>, t: Transport, env: Env, signal?: AbortSignal): Promise<Result<Uint8Array>> {
  if (!plan.ok) return plan
  const raw = await t.capture(Policy.ARGV, plan.value.config, plan.value.timeout, Policy.CAPTURE_LIMIT, signal, env)
  return Policy.captured(raw.ok ? done({code: raw.value.code, flags: raw.value.flags, stdout: raw.value.stdout}) : raw)
}

async function send(
  env: Env,
  selected: Result<Policy.Transport>,
  url: string,
  key: string,
  body: string,
  timeout: number,
  t: Transport,
  signal?: AbortSignal,
): Promise<Result<Uint8Array>> {
  if (!selected.ok) return selected
  if (selected.value === 'exec') return execute(Policy.request(url, key, body, timeout), t, env, signal)
  if (!Policy.valid(url, key, body, timeout)) return execute(Policy.request(url, key, body, timeout), t, env, signal)
  const result = await t.pooled({url, key, body, timeoutMs: timeout}, signal)
  if (result.ok) return Policy.pooledStatus(result.status, result.body)
  if (!result.unavailable) return Policy.transportFailed()
  if (selected.value === 'auto') return execute(Policy.request(url, key, body, timeout), t, env, signal)
  return Policy.unavailable()
}

// Http.post: JEV_FABRIC_HTTP selects the transport; both enforce the same
// checks, HTTPS-only, no-redirect and no-proxy policy and bounds.
export function post(url: string, key: string, body: string, timeout: number, env: Env, t: Transport = defaultTransport(env), signal?: AbortSignal): Promise<Result<Uint8Array>> {
  return send(env, Policy.transport(env.JEV_FABRIC_HTTP ?? ''), url, key, body, timeout, t, signal)
}

export {fail}
