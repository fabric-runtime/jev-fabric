// The `jev` and `validate` verbs as 0.8.1's main.bend ran them, returning
// what it printed and exited with rather than printing: the CLI writes
// `stdout` and `stderr` and exits with `exit`.
//
// The arguments are what the CLI's parser canonicalizes them to:
// `jev <ms> <request.json> [max-tokens]` (the timeout already chosen, from
// --timeout-ms or JEV_FABRIC_JEV_TIMEOUT_MS), `validate <request.json>`.

import * as Codec from '../codec/codec.ts'
import type {Err, Result} from '../codec/result.ts'
import {died} from '../codec/result.ts'
import {readU32} from '../codec/text.ts'
import * as Wire from '../codec/wire.ts'
import * as Input from './input.ts'
import type {Deps} from './jev.ts'
import * as Jev from './jev.ts'

export type Outcome = {stdout: string; stderr: string; exit: number}

export const ok = (line: string): Outcome => ({stdout: `${line}\n`, stderr: '', exit: 0})
export const error = (e: Err): Outcome => ({stdout: '', ...died(e)})
export const die = (code: number, message: string): Outcome => error({code, message})

// IO.pass of an encoding: the text printed, or the error died with.
const printed = (text: Result<string>): Outcome => (text.ok ? ok(text.value) : error(text.error))

// `jev <timeout> <path> [tokens]`: one evaluation with a budget of one call
// and `tokens` reported tokens (100000 when not given).
export async function jevFile(timeout: string, path: string, tokens: string | undefined, deps: Deps): Promise<Outcome> {
  const ms = readU32(timeout)
  const limit = tokens === undefined ? 100000 : readU32(tokens)
  if (ms === null || limit === null) return die(2, 'Jev timeout and token limit must be integers')
  const request = await Input.read(path, deps.capture)
  if (!request.ok) return error(request.error)
  const client = Jev.fromEnv(ms, 1, limit, deps.env)
  if (!client.ok) return error(client.error)
  const [, result] = await Jev.evaluate(client.value, request.value, deps)
  if (!result.ok) return error(result.error)
  return printed(Codec.encode(result.value))
}

// `validate <path>`: the request as the codec reads and the wire checks it.
export async function validateFile(path: string, deps: Pick<Deps, 'capture'> = {}): Promise<Outcome> {
  const text = await Input.read(path, deps.capture)
  if (!text.ok) return error(text.error)
  const value = Wire.request(text.value)
  if (!value.ok) return error(value.error)
  return printed(Codec.encode(value.value))
}
