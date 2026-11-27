// The `decide` and `resolve-decision` arguments (native/DecisionCli.bend):
// target flags before the request file, each at most once, and the legacy
// positional `<ms> <path> [tokens]`. Pure.

import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {field, findField, jobj, jstr} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {Failure, attempt, guard, unwrap} from '../codec/result.ts'
import * as Config from './config.ts'
import * as Profiles from './profiles.ts'
import * as W from './w.ts'

export type Arguments = {path: string; tokens: string; timeout: number | null; overrides: string}

const TIMEOUT_ERROR = 'timeout must be an integer within the operation limit'

// TimeCore.parse: leading zeros dropped, at most 8 digits, 1..max.
export function parseTimeout(raw: string, max: number): number {
  const trimmed = raw.replace(/^0+/, '')
  if (trimmed.length > 8 || !/^[0-9]+$/.test(trimmed)) throw new Failure(2, TIMEOUT_ERROR)
  const ms = Number(trimmed)
  if (!(ms >= 1 && ms <= max)) throw new Failure(2, TIMEOUT_ERROR)
  return ms
}

const FLAGS: Record<string, string> = {'--provider': 'provider', '--model': 'model', '--profile': 'profile', '--api': 'api', '--endpoint': 'endpoint', '--timeout-ms': 'timeout'}

function unique(previous: number | null, value: number): number {
  if (previous !== null) throw new Failure(2, 'specify the timeout only once')
  return value
}

type Flags = {fields: Member[]; timeout: number | null; pending: string; positional: string[]; literal: boolean}

function step(text: string, s: Flags): Flags {
  if (s.pending !== '') {
    if (s.pending === 'timeout') return {fields: s.fields, timeout: unique(s.timeout, parseTimeout(text, 3600000)), pending: '', positional: [], literal: false}
    guard(text !== '', 'Decision flag requires a nonempty value')
    // Prepended, as 0.8.1 did: the overrides list the last flag first.
    return {fields: [[s.pending, jstr(text)], ...s.fields], timeout: s.timeout, pending: '', positional: [], literal: false}
  }
  if (s.literal || !text.startsWith('-')) return {...s, pending: '', positional: [...s.positional, text]}
  guard(s.positional.length === 0, 'Decision flags must precede the request file')
  const key = FLAGS[text] ?? ''
  guard(key !== '' || text === '--', 'Unknown decision flag')
  guard(findField(s.fields, key) === undefined, 'Duplicate decision flag')
  return {fields: s.fields, timeout: s.timeout, pending: key, positional: [], literal: text === '--'}
}

const digits = (text: string) => /^[0-9]*$/.test(text)

function legacy(raw: string, path: string, tokens: string, timeout: number | null, overrides: string): Arguments {
  const ms = unique(timeout, parseTimeout(raw, 3600000))
  return {path, tokens, timeout: ms, overrides}
}

function positionals(args: string[], timeout: number | null, overrides: string, literal: boolean, offline: boolean): Arguments {
  if (args.length === 1) return {path: args[0]!, tokens: '100000', timeout, overrides}
  if (args.length === 2) {
    const [first, second] = args as [string, string]
    guard(!offline, 'resolve-decision requires one request file')
    if (!literal && digits(first) && first !== '') return legacy(first, second, '100000', timeout, overrides)
    return {path: first, tokens: second, timeout, overrides}
  }
  if (args.length === 3) {
    guard(!offline && !literal, 'Unexpected decision arguments')
    return legacy(args[0]!, args[1]!, args[2]!, timeout, overrides)
  }
  throw new Failure(2, 'Decision command requires a request file')
}

// DecisionCli.parse: `offline` is resolve-decision (one request file only).
export const parse = (args: readonly string[], offline: boolean): Result<Arguments> =>
  attempt(() => {
    let s: Flags = {fields: [], timeout: null, pending: '', positional: [], literal: false}
    for (const text of args) s = step(text, s)
    guard(s.pending === '', 'Decision flag requires a value')
    const overrides = unwrap(Codec.encode(jobj(s.fields)))
    return positionals(s.positional, s.timeout, overrides, s.literal, offline)
  })

function differentProvider(old: Json | undefined, next: Json | undefined): boolean {
  if (old !== undefined && old.t === 'str' && next !== undefined && next.t === 'str') return Config.canonical(old.v) !== Config.canonical(next.v)
  return false
}

// CLI values override file fields; switching provider drops the file's
// providerOptions. The merged request still passes every later check.
export const request = (text: string, overrides: string): Result<string> =>
  attempt(() => {
    const value = unwrap(Codec.readWithLimit(text, 16777216))
    const flags = unwrap(Codec.read(overrides))
    const base = differentProvider(field(value, 'provider'), field(flags, 'provider')) ? jobj(Profiles.remove(W.object(value), 'providerOptions')) : value
    const merged = unwrap(Profiles.merge(base, flags))
    return unwrap(Codec.encodeWithLimit(merged, 16777216))
  })
