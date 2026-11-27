// What a credential may be and how a credential command's output becomes one
// (native/CredentialCore.bend). Pure: no IO. A key is trimmed and must pass
// HttpCore's key check; the command is a JSON argv array of strings.

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {trim} from '../codec/text.ts'
import {keyValid} from './http-core.ts'

export function check(raw: string): Result<string> {
  const key = trim(raw)
  return keyValid(key) ? done(key) : fail(1, 'Invalid private credential')
}

export function output(bytes: Uint8Array, ok: boolean): Result<string> {
  if (!ok) return fail(1, 'Private credential command failed')
  const text = Codec.decodeUtf8(bytes)
  if (!text.ok) return fail(1, 'Private credential command returned invalid text')
  return check(text.value)
}

// A capture of the command: exit code, flags, stdout.
export function captured(result: Result<{code: number; flags: number; stdout: Uint8Array}>): Result<string> {
  if (!result.ok) return fail(1, 'Private credential command failed')
  const {code, flags, stdout} = result.value
  return output(stdout, code === 0 && flags === 0)
}

const ARGV_ERROR = 'Credential command must be a JSON argv array'

// The command's argv from its JSON text (Codec.read, then every item a string).
export function parsed(value: Result<Json>): Result<string[]> {
  if (!value.ok || value.value.t !== 'arr') return fail(1, ARGV_ERROR)
  const out: string[] = []
  for (const v of value.value.items) {
    if (v.t !== 'str') return fail(1, ARGV_ERROR)
    out.push(v.v)
  }
  return done(out)
}

export const command = (text: string): Result<string[]> => parsed(Codec.read(text))
