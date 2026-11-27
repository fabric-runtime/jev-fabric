// Decisions: typed questions to a chosen provider, on the session's Jev
// budget (native/Decision*.bend). Entry points for the CLI and `serve`:
//
// CLI (each returns the exact {stdout, stderr, exit} 0.8.1 printed):
//   parse(args: readonly string[], offline: boolean): Result<Arguments>
//       DecisionCli.parse, for `decide` (offline false) and `resolve-decision`
//       (true); Arguments = {path, tokens, timeout: number | null, overrides}.
//       A failure is died() by the CLI (code 2 or 22).
//   decideFlagsFile(timeout: string, path, tokens: string, overrides: string, deps: Deps): Promise<Outcome>
//       `decide`, canonical [ms, path, tokens, overrides].
//   decideFile(timeout: string, path, tokens: string | undefined, deps): Promise<Outcome>
//       the legacy flagless shape (main.decide_file).
//   resolveDecisionFile(path, overrides: string, deps: {env, capture?}): Promise<Outcome>
//   validateDecisionFile(path, deps?: {capture?}): Promise<Outcome>
//   decisionProviders(): Outcome
//
// serve:
//   evaluate(client: Client, requestJson: string, credential: string, deps: Deps): Promise<Returned>
//   evaluateFor(scope: Scope, client, requestJson, credential, cap: number, deps): Promise<Returned>
//       within the session scope's deadline (Serve's decide_checked).
//   encoded(returned): [Client, Result<string>]   (Serve's decision_evaluated)
//   encode(value: Json): Result<string>           (Decision.encode)
//   validateRequest(value: Json): Result<Json>    (DecisionWire.validate_request, ServeCore)
//   offline(text: string, env, capture?): Promise<Result<string>>  (DecisionTargets.offline)
//   providers(): Json                              (DecisionConfig.providers)
//
// Deps = Jev's Deps ({env, capture?, now?, signal?, transport?}) plus
// `decisionTransport?: Transport` (default: fetch under DecisionHttpCore's
// policy; `curlExchange(capture, curlPath)` runs curl as 0.8.1 did).

export type {Outcome} from '../jev/cli.ts'
export type {Arguments} from './cli-core.ts'
export {decideFile, decideFlagsFile, decisionProviders, parse, resolveDecisionFile, validateDecisionFile} from './cli.ts'
export {providers} from './config.ts'
export type {Deps} from './decision.ts'
export {encode, encoded, evaluate, evaluateFor} from './decision.ts'
export type {Transport} from './http.ts'
export {curlExchange, fetchExchange} from './http.ts'
export {offline} from './targets.ts'
export {validateRequest} from './wire.ts'
