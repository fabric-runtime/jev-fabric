// The Jev side of jev-fabric, as the CLI, `serve` and the monitor call it.
//
// CLI verbs (each returns {stdout, stderr, exit}: write both, exit with it):
//   jevFile(timeout: string, path: string, tokens: string | undefined, deps: Deps): Promise<Outcome>
//       `jev <ms> <request.json> [max-tokens]` after the CLI parser chose <ms>
//       (--timeout-ms or JEV_FABRIC_JEV_TIMEOUT_MS); tokens default 100000.
//   validateFile(path: string, deps?: {capture?}): Promise<Outcome>   `validate <request.json>`
//   die(code, message) / error(err) / ok(line): Outcome               how 0.8.1 died and printed
//
// The client (affine: thread the returned client into the next call):
//   fromEnv(timeoutMs, maxEvaluations, maxTokens, env): Result<Client>
//   connect(maxEvaluations, maxTokens, env): Result<Client>      timer from JEV_FABRIC_JEV_TIMEOUT_MS
//   evaluate(client, requestJson, deps): Promise<[Client, Result<Json>]>
//   evaluateWithin(client, requestJson, ms, deps)                ms 0: 124 "scope deadline expired ..."
//
// A serve session (one client, one budget, evaluations one at a time):
//   new JevSession(client).evaluate(scope, requestJson, cap, provider, credential, deps): Promise<Result<string>>
//   JevSession.use(body): run any client-threading body (decisions too) in arrival order
//   evaluateFor(scope, client, requestJson, cap, deps), evaluateRequest(...), scopedMs(scope, cap, now)
//
// Deps: {env, transport?, capture?, now?, signal?}. Leave transport and
// capture out to use fetch and Bun.spawn; tests pass fakes.
//
// Core (budget, settle, after, monitor line filter, batchPush) is pure and
// also used by the monitor.

export * as Core from './core.ts'
export type {Budget, Batch, State, Receipt, Next} from './core.ts'
export {jevFile, validateFile, die, error, ok} from './cli.ts'
export type {Outcome} from './cli.ts'
export {connect, evaluate, evaluateWithin, fromEnv, jevTimeout, transportOf, MAX_TIMEOUT} from './jev.ts'
export type {Client, Deps, Env, Returned, Settings, Transport} from './jev.ts'
export {client, consume, returned, route, pickModel, ROUTES} from './jev-core.ts'
export {JevSession, encoded, evaluateFor, evaluateRequest, remaining, scopedMs} from './session.ts'
export type {Scope} from './session.ts'
export {post, fetchPooled, defaultTransport} from './http.ts'
export {capture} from './capture.ts'
export type {CaptureFn, Captured} from './capture.ts'
export {read as readInput, readLimit as readInputLimit} from './input.ts'
export {resolve as resolveCredential} from './credentials.ts'
