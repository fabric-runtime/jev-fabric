// One decision (native/Decision.bend), on the session's Jev client and
// budget.
//
// The order is 0.8.1's: resolve the target (request, profile, environment,
// adapter preflight), reserve one call (an exhausted budget answers without
// dispatch), check the deadline, resolve the credential (a loopback bearer
// target with no key and no command goes anonymous), check the deadline
// again, dispatch once, and account the reported usage before validating the
// reply. A dispatched reply that fails validation still prints, as a
// status:error envelope with the provider's text; usage that is unknown or
// invalid stops the budget. Nothing is retried. The client's own cached Jev
// key is never changed by a decision.

import type {Json} from '../codec/json.ts'
import {field} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {fail} from '../codec/result.ts'
import * as Codec from '../codec/codec.ts'
import {capture as defaultCapture} from '../jev/capture.ts'
import type {Budget} from '../jev/core.ts'
import * as JevCore from '../jev/core.ts'
import * as Credentials from '../jev/credentials.ts'
import type {Client, Deps as JevDeps, Returned} from '../jev/jev.ts'
import * as Policy from '../jev/jev-core.ts'
import type {Scope} from '../jev/session.ts'
import {remaining as scopeRemaining} from '../jev/session.ts'
import * as D from './decision-core.ts'
import * as HttpPolicy from './http-core.ts'
import type {Transport} from './http.ts'
import * as Http from './http.ts'
import * as Local from './local.ts'
import * as Targets from './targets.ts'
import * as Wire from './wire.ts'

export {encode, LIMIT} from './decision-core.ts'

// What a decision reaches: the Jev deps (env, capture, clock, signal) and
// the decision transport (fetch under the decision policy by default).
export type Deps = JevDeps & {decisionTransport?: Transport}

const transportOf = (deps: Deps): Transport => deps.decisionTransport ?? Http.fetchExchange(deps.env)
const nowOf = (deps: Deps) => deps.now ?? Date.now
const envOf = (deps: Deps, name: string) => deps.env[name] ?? ''

type Ctx = {settings: Policy.Settings; original: Budget; cached: string}

const back = (c: Ctx, b: Budget, result: Result<Json>): Returned => Policy.returned(c.settings, b, c.cached, result)

function normalized(c: Ctx, b: Budget, reason: string, prepared: Targets.PreparedTarget, text: string, usage: D.Usage, result: Result<Json>): Returned {
  if (result.ok) return back(c, b, {ok: true, value: D.decorate(D.status(result.value), b, reason)})
  return back(c, b, {ok: true, value: D.decorate(D.invalidResponse(prepared.config, text, usage, result.error), b, reason)})
}

function responded(c: Ctx, b: Budget, prepared: Targets.PreparedTarget, text: string, httpStatus: number): Returned {
  const {provider, api, model} = prepared.config
  const usage = D.usageOf(Wire.rawUsage(text, api))
  const reply = httpStatus >= 200 && httpStatus < 300 ? Wire.reply(text, prepared.request, provider, api, model) : fail(httpStatus, `decision HTTP status ${httpStatus}`)
  const [next, reason] = D.account(b, usage)
  return normalized(c, next, reason, prepared, text, usage, reply)
}

function received(c: Ctx, b: Budget, prepared: Targets.PreparedTarget, response: Result<Http.Exchange>): Returned {
  if (!response.ok) return back(c, D.stopBudget(b), response)
  const {status, bytes} = response.value
  const text = Codec.decodeUtf8WithLimit(bytes, D.LIMIT)
  const [client, result] = text.ok ? responded(c, b, prepared, text.value, status) : back(c, D.stopBudget(b), text)
  return [client, D.withHttpStatus(result, status)]
}

function localReturned(c: Ctx, b: Budget, result: Result<Json>): Returned {
  if (!result.ok) return back(c, D.stopBudget(b), result)
  const value = result.value
  const [next, reason] = D.account(b, D.usageOf(Wire.maybeUsage(field(value, 'usage'), 'input_tokens', 'output_tokens')))
  return back(c, next, {ok: true, value: D.decorate(D.status(value), next, reason)})
}

async function send(c: Ctx, b: Budget, prepared: Targets.PreparedTarget, key: string, timeout: number, deps: Deps): Promise<Returned> {
  const {provider, api, endpoint, model, auth, allowLocal} = prepared.config
  if (api === 'llama-cpp') {
    const result = await Local.evaluate(prepared.request, provider, model, endpoint, key, timeout, allowLocal, {transport: transportOf(deps), now: deps.now, signal: deps.signal})
    return localReturned(c, b, result)
  }
  const response = await Http.exchangeWith(endpoint, key, prepared.body, timeout, allowLocal, auth, Wire.headers(prepared.request, provider, api), transportOf(deps), deps.signal)
  return received(c, b, prepared, response)
}

// The provider's key: GEMINI_API_KEY or else GOOGLE_API_KEY, and
// CLOUDFLARE_API_TOKEN or else CLOUDFLARE_API_KEY.
export function credentialEnv(name: string, env: Deps['env']): string {
  const alias = (primary: string, other: string) => Policy.pickModel(env[primary] ?? '', env[other] ?? '')
  if (name === 'CLOUDFLARE_API_TOKEN') return alias('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY')
  if (name === 'GEMINI_API_KEY') return alias('GEMINI_API_KEY', 'GOOGLE_API_KEY')
  return env[name] ?? ''
}

async function reserved(c: Ctx, prepared: Targets.PreparedTarget, credential: string, reservation: Budget, started: number, deps: Deps): Promise<Returned> {
  const now = nowOf(deps)
  const timeout = c.settings.timeout
  let elapsed = Math.max(0, now() - started)
  if (elapsed >= timeout) return back(c, c.original, fail(124, 'decision deadline expired before credentials'))
  const left = timeout - elapsed
  const {endpoint, keyEnv, auth, allowLocal} = prepared.config
  const inherited = credentialEnv(keyEnv, deps.env)
  const command = envOf(deps, 'DECISION_CREDENTIAL_COMMAND')
  const key = Policy.pickModel(credential, inherited)
  const anonymous = allowLocal && auth === 'bearer' && HttpPolicy.isLocal(endpoint) && key === '' && command === ''
  const resolved = anonymous ? ({ok: true, value: ''} as Result<string>) : await Credentials.resolve(key, command, left, deps.capture ?? defaultCapture, deps.env)
  if (!resolved.ok) return back(c, c.original, resolved)
  elapsed = Math.max(0, now() - started)
  if (elapsed >= timeout) return back(c, c.original, fail(124, 'decision deadline expired before dispatch'))
  return send(c, reservation, prepared, resolved.value, timeout - elapsed, deps)
}

// Decision.evaluate: `credential`, when not empty, is this request's key.
export async function evaluate(client: Client, requestJson: string, credential: string, deps: Deps): Promise<Returned> {
  const {settings, budget, key} = Policy.consume(client)
  const c: Ctx = {settings, original: budget, cached: key}
  const started = nowOf(deps)()
  const prepared = await Targets.resolve(requestJson, deps.env, deps.capture)
  if (!prepared.ok) return back(c, budget, prepared)
  const reservation = JevCore.reserve(budget)
  if (reservation === null) return back(c, budget, fail(1, 'decision budget exhausted'))
  return reserved(c, prepared.value, credential, reservation, started, deps)
}

// Decision.evaluate_for: within a session scope's deadline, `cap` and the
// client's timeout, whichever is least; the client's settings come back
// unchanged. A cap outside 1..3600000 is an error here (0.8.1 exited).
export async function evaluateFor(scope: Scope, client: Client, requestJson: string, credential: string, cap: number, deps: Deps): Promise<Returned> {
  const bounded = Math.min(cap, client.settings.timeout)
  if (!(Number.isInteger(bounded) && bounded >= 1 && bounded <= 3600000)) {
    const {settings, budget, key} = Policy.consume(client)
    return Policy.returned(settings, budget, key, fail(2, 'timeout must be an integer within the operation limit'))
  }
  const ms = Math.min(scopeRemaining(scope, nowOf(deps)()), bounded)
  if (ms === 0) {
    const {settings, budget, key} = Policy.consume(client)
    return Policy.returned(settings, budget, key, fail(124, 'scope deadline expired before decision'))
  }
  const {settings, budget, key} = Policy.consume(client)
  const [after, result] = await evaluate(Policy.client({...settings, timeout: ms}, budget, key), requestJson, credential, deps)
  return [Policy.client(settings, after.budget, after.key), result]
}

// Serve's decision_evaluated: the answer encoded as a session line value.
export const encoded = ([c, result]: Returned): [Client, Result<string>] => [c, result.ok ? D.encode(result.value) : result]
