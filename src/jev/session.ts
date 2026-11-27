// One Jev client for a whole `serve` session (the Jev half of
// native/Serve.bend and Scope.bend): evaluations run one at a time, in
// arrival order, each with the client the one before handed back, so the
// session has one budget and one cached credential.
//
// A request's own provider or credential applies to that request only: the
// session's settings and cached key come back unchanged, and only the budget
// the evaluation spent is kept.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Codec from '../codec/codec.ts'
import type {Client, Deps, Returned} from './jev.ts'
import * as Jev from './jev.ts'
import * as Policy from './jev-core.ts'

// A deadline shared by a session (TimeCore.Budget): what is left at `now`.
export type Scope = {started: number; duration: number}

export const remaining = (scope: Scope, now: number): number => Math.max(0, scope.duration - Math.max(0, now - scope.started))

const timeoutError = () => fail(2, 'timeout must be an integer within the operation limit')

// Scope.remaining: what is left of the scope, at most `cap`. `cap` must be a
// valid timeout (0.8.1 exited the process on a bad one; here it is an error).
export function scopedMs(scope: Scope, cap: number, now: number): Result<number> {
  if (!(Number.isInteger(cap) && cap >= 1 && cap <= Jev.MAX_TIMEOUT)) return timeoutError()
  return done(Math.min(remaining(scope, now), cap))
}

// Scope.evaluate_for: one evaluation within the scope's deadline, its own
// cap and the client's timeout, whichever is least.
export async function evaluateFor(scope: Scope, c: Client, request: string, cap: number, deps: Deps): Promise<Returned> {
  const now = (deps.now ?? Date.now)()
  if (!(Number.isInteger(cap) && cap >= 1 && cap <= Jev.MAX_TIMEOUT)) {
    const {settings, budget, key} = Policy.consume(c)
    return Policy.returned(settings, budget, key, timeoutError())
  }
  const ms = Math.min(remaining(scope, now), cap, c.settings.timeout)
  return Jev.evaluateWithin(c, request, ms, deps)
}

const restored = ([after, result]: Returned, c: {settings: Policy.Settings; key: string}): Returned => [
  Policy.client(c.settings, after.budget, c.key),
  result,
]

// Serve.evaluate_request: a plain request evaluates with the session client
// (and may cache its credential); one with its own provider or credential
// borrows the budget only.
export async function evaluateRequest(
  scope: Scope,
  c: Client,
  request: string,
  cap: number,
  provider: string,
  credential: string,
  deps: Deps,
): Promise<Returned> {
  if (provider === '' && credential === '') return evaluateFor(scope, c, request, cap, deps)
  const {settings, budget, key} = Policy.consume(c)
  if (provider === '') return restored(await evaluateFor(scope, Policy.client(settings, budget, credential), request, cap, deps), {settings, key})
  const r = Policy.route(provider)
  if (!r.ok) return [Policy.client(settings, budget, key), r]
  const {endpoint, keyEnv, model: fallback} = r.value
  const chosen: Policy.Settings = {endpoint, model: Policy.pickModel(deps.env.JEV_MODEL ?? '', fallback), command: settings.command, timeout: settings.timeout}
  const providerKey = deps.env[keyEnv] ?? ''
  const borrowed = Policy.client(chosen, budget, credential === '' ? providerKey : credential)
  return restored(await evaluateFor(scope, borrowed, request, cap, deps), {settings, key})
}

// Serve.evaluated: the answer as the session writes it.
export const encoded = ([c, result]: Returned): [Client, Result<string>] => [c, result.ok ? Codec.encode(result.value) : result]

// The session's one client. `use` runs each body with the current client and
// keeps the client it hands back; bodies run one at a time in call order.
export class JevSession {
  #client: Client
  #tail: Promise<unknown> = Promise.resolve()

  constructor(client: Client) {
    this.#client = client
  }

  get client(): Client {
    return this.#client
  }

  use<T>(body: (c: Client) => Promise<[Client, T]>): Promise<T> {
    const run = this.#tail.then(async () => {
      const [next, value] = await body(this.#client)
      this.#client = next
      return value
    })
    this.#tail = run.catch(() => {})
    return run
  }

  // A Jev request of the session: the encoded answer or the error.
  evaluate(scope: Scope, request: string, cap: number, provider: string, credential: string, deps: Deps): Promise<Result<string>> {
    return this.use(async (c) => encoded(await evaluateRequest(scope, c, request, cap, provider, credential, deps)))
  }
}
