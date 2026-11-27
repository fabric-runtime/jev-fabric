// The Jev client's pure policy (native/JevCore.bend): provider routes, the
// client and its settings, and how a transport's answer becomes a typed reply
// and an accounted budget. Pure: no IO.
//
// The client is affine in 0.8.1 (one evaluation at a time owns it, and gets
// it back with the budget it spent). Here a client is an immutable value an
// evaluation consumes: handing a consumed client to another evaluation is a
// programming error and throws (see `consume`).

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Wire from '../codec/wire.ts'
import type {Budget} from './core.ts'
import * as Core from './core.ts'

export type Route = {endpoint: string; keyEnv: string; model: string}
export type Settings = {endpoint: string; model: string; command: string; timeout: number}
export type Client = Readonly<{settings: Settings; budget: Budget; key: string}>
export type Evaluation = Result<Json>
export type Returned = [Client, Evaluation]

export const ROUTES: Readonly<Record<'typesafe' | 'openrouter' | 'vercel' | 'subq', Route>> = {
  typesafe: {endpoint: 'https://api.typesafe.ai/v1/systemone', keyEnv: 'TYPESAFE_API_KEY', model: 'jev-latest'},
  openrouter: {endpoint: 'https://openrouter.ai/api/alpha/decisions', keyEnv: 'OPENROUTER_API_KEY', model: '~typesafe/jev-latest'},
  vercel: {endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', keyEnv: 'AI_GATEWAY_API_KEY', model: 'typesafe-ai/jev'},
  subq: {endpoint: 'https://api.subq.ai/v1/systemone', keyEnv: 'SUBQ_API_KEY', model: 'subq-snap-preview'},
}

// JEV_PROVIDER: empty means typesafe.
export function route(provider: string): Result<Route> {
  const name = provider === '' ? 'typesafe' : provider
  if (name === 'typesafe' || name === 'openrouter' || name === 'vercel' || name === 'subq') return done(ROUTES[name])
  return fail(1, 'JEV_PROVIDER must be typesafe, openrouter, vercel, or subq')
}

export const pickModel = (override: string, fallback: string): string => (override === '' ? fallback : override)

const consumed = new WeakSet<object>()

export function client(settings: Settings, budget: Budget, key: string): Client {
  return Object.freeze({settings, budget, key})
}

// Takes the client for one evaluation. A client is used once: the returned
// one carries on.
export function consume(c: Client): Client {
  if (consumed.has(c)) throw new Error('Jev client already consumed: thread the returned client into the next evaluation')
  consumed.add(c)
  return c
}

export const isConsumed = (c: Client): boolean => consumed.has(c)

export function make(settings: Settings, key: string, calls: number, tokens: number, valid: boolean): Result<Client> {
  if (!valid) return fail(1, 'Invalid Jev timeout or model')
  return done(client(settings, Core.budget(calls, tokens), key))
}

export const returned = (settings: Settings, budget: Budget, key: string, result: Evaluation): Returned => [client(settings, budget, key), result]

const OVER = 'Jev reported-token budget exceeded; final request may still be billed'

// A single report above the whole limit is an overshoot before any addition:
// the budget saturates past its limit and allows nothing more.
export function account(settings: Settings, b: Budget, key: string, response: Json, input: number, output: number): Returned {
  if (input > b.limit || output > b.limit) return returned(settings, {remaining: 0, evaluations: b.evaluations, tokens: b.limit + 1, limit: b.limit}, key, fail(1, OVER))
  const next = Core.account(b, input + output)
  return returned(settings, next, key, Core.within(next) ? done(response) : fail(1, OVER))
}

// Wire.reply_usage accepts exactly what Wire.usage would on the normalized
// reply, reusing the counts normalize already parsed.
export function responseReady(settings: Settings, b: Budget, key: string, response: Result<Wire.Reply>): Returned {
  if (!response.ok) return returned(settings, b, key, fail(1, 'Invalid typed Jev response'))
  const usage = Wire.replyUsage(response.value)
  if (!usage.ok) return returned(settings, b, key, fail(1, 'Invalid Jev usage'))
  const [input, output] = usage.value
  return account(settings, b, key, response.value.value, Number(input), Number(output))
}

export function decoded(settings: Settings, b: Budget, key: string, request: Json, text: Result<string>): Returned {
  if (!text.ok) return returned(settings, b, key, fail(1, 'Invalid UTF-8 Jev response'))
  return responseReady(settings, b, key, Wire.reply(text.value, request))
}

// The transport's answer with the reserved budget: an error spends the call.
export function received(settings: Settings, b: Budget, key: string, request: Json, raw: Result<Uint8Array>): Returned {
  if (!raw.ok) return returned(settings, b, key, raw)
  return decoded(settings, b, key, request, Codec.decodeUtf8(raw.value))
}

// ---- One evaluation, as a pure walk over its effects ---------------------------
//
// Jev.evaluate's decisions without its IO: the walk yields each effect it
// needs (the clock, the credential, the HTTPS POST) and takes the answer
// back. The driver answers with real IO; the laws (laws/jev.ts) answer from
// a script and hold the rule to this very walk.

export type Effect =
  | {k: 'now'}
  | {k: 'credential'; key: string; command: string; timeout: number}
  | {k: 'post'; url: string; key: string; body: string; timeoutMs: number}
export type Walk = Generator<Effect, Returned, unknown>

const refuse = (settings: Settings, b: Budget, key: string, message: string): Returned => returned(settings, b, key, fail(1, message))

export function* evaluation(c: Client, requestJson: string): Walk {
  const {settings, budget: b, key} = consume(c)
  const request = Wire.request(requestJson)
  if (!request.ok) return [client(settings, b, key), fail(1, 'Invalid Jev request')]
  const body = Wire.body(request.value, settings.model)
  if (!body.ok) return refuse(settings, b, key, 'Invalid Jev request model')
  const reservation = Core.reserve(b)
  if (reservation === null) return refuse(settings, b, key, 'Jev budget exhausted')
  const started = (yield {k: 'now'}) as number
  // Credential resolution spends from the same timeout as the HTTP call.
  const resolved = (yield {k: 'credential', key, command: settings.command, timeout: settings.timeout}) as Result<string>
  if (!resolved.ok) return returned(settings, b, '', resolved)
  const elapsed = Math.max(0, ((yield {k: 'now'}) as number) - started)
  if (elapsed >= settings.timeout) return refuse(settings, b, resolved.value, 'Jev request timed out before dispatch')
  const raw = (yield {k: 'post', url: settings.endpoint, key: resolved.value, body: body.value, timeoutMs: settings.timeout - elapsed}) as Result<Uint8Array>
  return received(settings, reservation, resolved.value, request.value, raw)
}
