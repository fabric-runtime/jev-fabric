// The Jev client driver (native/Jev.bend): a client from the environment,
// and one evaluation.
//
// An evaluation validates the request, then builds its body, then reserves
// one call from the budget (an exhausted budget answers without dispatch),
// then resolves the credential (invalid requests and credentials spend
// nothing), then dispatches once within what is left of its timeout, and
// validates the answer completely. Nothing is retried: a failed dispatch
// spends its call. The resolved credential is cached in the returned client.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import type {CaptureFn} from './capture.ts'
import {capture as defaultCapture} from './capture.ts'
import * as Credentials from './credentials.ts'
import type {Env, Transport} from './http.ts'
import * as Http from './http.ts'
import type {Client, Returned, Route, Settings} from './jev-core.ts'
import * as Policy from './jev-core.ts'

export type {Client, Returned, Settings} from './jev-core.ts'
export type {Env, Transport} from './http.ts'

// What an evaluation reaches outside itself; every part injectable.
export type Deps = {
  env: Env
  transport?: Transport
  capture?: CaptureFn
  now?: () => number
  signal?: AbortSignal
}

export const MAX_TIMEOUT = 3600000
export const JEV_TIMEOUT_DEFAULT = 30000

const envOf = (env: Env, name: string): string => env[name] ?? ''

// The Jev timer: JEV_FABRIC_JEV_TIMEOUT_MS, else 30 s (TimeCore.config).
export function jevTimeout(env: Env): Result<number> {
  const raw = envOf(env, 'JEV_FABRIC_JEV_TIMEOUT_MS')
  if (raw === '') return done(JEV_TIMEOUT_DEFAULT)
  const trimmed = raw.replace(/^0+/, '')
  const bad = fail(2, 'timeout must be an integer within the operation limit')
  if (trimmed.length > 8 || !/^[0-9]+$/.test(trimmed)) return bad
  const ms = Number(trimmed)
  return ms >= 1 && ms <= MAX_TIMEOUT ? done(ms) : bad
}

const settingsValid = (timeout: number, model: string): boolean => timeout >= 1 && timeout <= MAX_TIMEOUT && Array.from(model).length <= 128

export function load(selected: Result<Route>, timeout: number, calls: number, tokens: number, env: Env): Result<Client> {
  if (!selected.ok) return selected
  const {endpoint, keyEnv, model: fallback} = selected.value
  const override = envOf(env, 'JEV_MODEL')
  const command = envOf(env, 'JEV_CREDENTIAL_COMMAND')
  const key = envOf(env, keyEnv)
  const model = Policy.pickModel(override, fallback)
  return Policy.make({endpoint, model, command, timeout}, key, calls, tokens, settingsValid(timeout, model))
}

// Jev.from_env: the provider's route, model and key from the environment.
export const fromEnv = (timeoutMs: number, maxEvaluations: number, maxTokens: number, env: Env): Result<Client> =>
  load(Policy.route(envOf(env, 'JEV_PROVIDER')), timeoutMs, maxEvaluations, maxTokens, env)

// Jev.connect: evaluation and token budgets explicit, the timer defaulted.
export function connect(maxEvaluations: number, maxTokens: number, env: Env): Result<Client> {
  const ms = jevTimeout(env)
  return ms.ok ? fromEnv(ms.value, maxEvaluations, maxTokens, env) : ms
}

// The transport an evaluation dispatches through: the injected one, else
// fetch with the injected capture (for the exec transport).
export const transportOf = (deps: Deps): Transport => deps.transport ?? {pooled: Http.fetchPooled(deps.env), capture: deps.capture ?? defaultCapture}

// Answers the walk's effects with real IO.
async function drive(walk: Policy.Walk, deps: Deps): Promise<Returned> {
  const now = deps.now ?? Date.now
  let step = walk.next()
  while (!step.done) {
    const e = step.value
    let answer: unknown
    if (e.k === 'now') answer = now()
    else if (e.k === 'credential') answer = await Credentials.resolve(e.key, e.command, e.timeout, deps.capture ?? defaultCapture, deps.env)
    else answer = await Http.post(e.url, e.key, e.body, e.timeoutMs, deps.env, transportOf(deps), deps.signal)
    step = walk.next(answer)
  }
  return step.value
}

// Jev.evaluate: thread the returned client into the next evaluation.
export const evaluate = (c: Client, requestJson: string, deps: Deps): Promise<Returned> => drive(Policy.evaluation(c, requestJson), deps)

export const withTimeout = (settings: Settings, ms: number): Settings => ({...settings, timeout: ms})

// Scope.evaluate_ready: evaluate with the timeout lowered to `ms` (what is
// left of a scope's deadline, capped), then hand back the original settings.
// `ms` 0 means the deadline passed: nothing is dispatched.
export async function evaluateWithin(c: Client, request: string, ms: number, deps: Deps): Promise<Returned> {
  const {settings, budget, key} = Policy.consume(c)
  if (ms === 0) return Policy.returned(settings, budget, key, fail(124, 'scope deadline expired before Jev evaluation'))
  const [after, result] = await evaluate(Policy.client(withTimeout(settings, ms), budget, key), request, deps)
  return [Policy.client(settings, after.budget, after.key), result]
}
