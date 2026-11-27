// The decision verbs as 0.8.1's main.bend ran them, returning what it
// printed and exited with: `decide`, `validate-decision`,
// `resolve-decision` and `decision-providers`.
//
// The CLI parses `decide` and `resolve-decision` with `parse` (DecisionCli)
// and hands over its canonical `[timeout, path, tokens, overrides]`, the
// timeout already chosen (--timeout-ms, the legacy positional, or the
// default: JEV_FABRIC_JEV_TIMEOUT_MS for decide).

import * as Codec from '../codec/codec.ts'
import type {Result} from '../codec/result.ts'
import {readU32} from '../codec/text.ts'
import type {Outcome} from '../jev/cli.ts'
import {die, error, ok} from '../jev/cli.ts'
import * as Input from '../jev/input.ts'
import * as Jev from '../jev/jev.ts'
import * as Cli from './cli-core.ts'
import * as Config from './config.ts'
import * as D from './decision-core.ts'
import type {Deps} from './decision.ts'
import * as Decision from './decision.ts'
import * as Targets from './targets.ts'
import * as Wire from './wire.ts'

export {parse} from './cli-core.ts'
export type {Arguments} from './cli-core.ts'

const printed = (text: Result<string>): Outcome => (text.ok ? ok(text.value) : error(text.error))

// main.target_file: the request file with the CLI's target flags laid over it.
async function targetFile(path: string, overrides: string, deps: Pick<Deps, 'capture'>): Promise<Result<string>> {
  const text = await Input.readLimit(path, D.LIMIT, deps.capture)
  return text.ok ? Cli.request(text.value, overrides) : text
}

async function decided(request: Result<string>, ms: number, limit: number, deps: Deps): Promise<Outcome> {
  if (!request.ok) return error(request.error)
  const client = Jev.fromEnv(ms, 1, limit, deps.env)
  if (!client.ok) return error(client.error)
  const [, result] = await Decision.evaluate(client.value, request.value, '', deps)
  if (!result.ok) return error(result.error)
  return printed(D.encode(result.value))
}

// `decide <timeout> <path> <tokens> <overrides>` (main.decide_flags_file).
export async function decideFlagsFile(timeout: string, path: string, tokens: string, overrides: string, deps: Deps): Promise<Outcome> {
  const ms = readU32(timeout)
  const limit = readU32(tokens)
  if (ms === null || limit === null) return die(2, 'decision timeout and token limit must be integers')
  return decided(await targetFile(path, overrides, deps), ms, limit, deps)
}

// `decide <timeout> <path> [tokens]` without flags (main.decide_file).
export async function decideFile(timeout: string, path: string, tokens: string | undefined, deps: Deps): Promise<Outcome> {
  const ms = readU32(timeout)
  const limit = tokens === undefined ? 100000 : readU32(tokens)
  if (ms === null || limit === null) return die(2, 'decision timeout and token limit must be integers')
  return decided(await Input.readLimit(path, D.LIMIT, deps.capture), ms, limit, deps)
}

// `resolve-decision <path> <overrides>`: offline preflight, no credential
// resolved and nothing dispatched.
export async function resolveDecisionFile(path: string, overrides: string, deps: Pick<Deps, 'env' | 'capture'>): Promise<Outcome> {
  const request = await targetFile(path, overrides, deps)
  if (!request.ok) return error(request.error)
  return printed(await Targets.offline(request.value, deps.env, deps.capture))
}

// `validate-decision <path>`: the request as the decision wire checks it.
export async function validateDecisionFile(path: string, deps: Pick<Deps, 'capture'> = {}): Promise<Outcome> {
  const text = await Input.readLimit(path, D.LIMIT, deps.capture)
  if (!text.ok) return error(text.error)
  const value = Wire.request(text.value)
  if (!value.ok) return error(value.error)
  return printed(D.encode(value.value))
}

// `decision-providers`: the registered presets, without credentials.
export const decisionProviders = (): Outcome => printed(Codec.encode(Config.providers()))
