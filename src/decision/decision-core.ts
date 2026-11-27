// The pure accounting and shaping of a decision (from native/Decision.bend):
// how reported usage spends the shared budget, and how an answer, or an
// invalid one, is decorated before it is printed. laws/decision.ts proves
// the accounting rule and holds it to `account`.

import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {field, findField, jbool, jnum, jobj, jstr, NULL} from '../codec/json.ts'
import type {Err, Result} from '../codec/result.ts'
import type {Budget} from '../jev/core.ts'
import * as Core from '../jev/core.ts'
import type {Settings} from './config.ts'
import type {Counts} from './wire.ts'

export const LIMIT = 16777216

// Decision.encode: a llama.cpp envelope takes the high-work profile.
export function encode(value: Json): Result<string> {
  const api = field(value, 'api')
  if (api !== undefined && api.t === 'str' && api.v === 'llama-cpp') return Codec.encodeProfile(value, LIMIT, 524288)
  return Codec.encodeWithLimit(value, LIMIT)
}

// No more calls; what was spent stays spent.
export const stopBudget = (b: Budget): Budget => ({...b, remaining: 0})

export type Usage = {kind: 'known'; input: bigint; output: bigint} | {kind: 'unknown'} | {kind: 'invalid'}

export function usageOf(value: Result<Counts>): Usage {
  if (!value.ok) return {kind: 'invalid'}
  if (value.value === null) return {kind: 'unknown'}
  return {kind: 'known', input: value.value[0], output: value.value[1]}
}

const unknownUsage = (): Json =>
  jobj([
    ['input_tokens', NULL],
    ['output_tokens', NULL],
  ])

export const usageValue = (u: Usage): Json =>
  u.kind === 'known'
    ? jobj([
        ['input_tokens', jnum(u.input.toString())],
        ['output_tokens', jnum(u.output.toString())],
      ])
    : unknownUsage()

// Past the limit: no more calls and the tokens saturated past it.
export const overshot = (b: Budget): Budget => ({remaining: 0, evaluations: b.evaluations, tokens: b.limit + 1, limit: b.limit})

// Known usage spends; a report past what is left overshoots (checked before
// adding). Unknown or invalid usage stops the budget: it cannot be bounded.
export function account(b: Budget, u: Usage): [Budget, string] {
  if (u.kind === 'unknown') return [stopBudget(b), 'unknown-usage']
  if (u.kind === 'invalid') return [stopBudget(b), 'invalid-usage']
  const input = Number(u.input)
  const output = Number(u.output)
  const over = input > b.limit || output > b.limit || input + output > Math.max(0, b.limit - b.tokens)
  return over ? [overshot(b), 'reported-token-limit'] : [Core.account(b, input + output), '']
}

export const exhausted = (b: Budget): boolean => b.remaining === 0 || b.tokens >= b.limit

// The budget's state first in the printed object.
export function decorate(value: Json, b: Budget, reason: string): Json {
  if (value.t !== 'obj') return value
  return jobj([
    [
      'budget',
      jobj([
        ['exhausted', jbool(exhausted(b))],
        ['reason', jstr(reason)],
      ]),
    ],
    ...value.fields,
  ])
}

// A reply without a status is "ok".
export function status(value: Json): Json {
  if (value.t !== 'obj') return value
  return findField(value.fields, 'status') !== undefined ? value : jobj([['status', jstr('ok')], ...value.fields])
}

// What a dispatched but invalid reply prints: the provider's text kept,
// parsed where it parses.
export function invalidResponse(config: Settings, text: string, usage: Usage, error: Err): Json {
  const parsed = Codec.readWithLimit(text, LIMIT)
  const raw: Member = parsed.ok ? ['raw', parsed.value] : ['rawText', jstr(text)]
  return jobj([
    ['status', jstr('error')],
    ['provider', jstr(config.provider)],
    ['api', jstr(config.api)],
    ['model', jstr(config.model)],
    ['answers', jobj([])],
    ['usage', usageValue(usage)],
    ['rawJson', jstr(text)],
    [
      'error',
      jobj([
        ['code', jnum(String(error.code))],
        ['message', jstr(error.message)],
      ]),
    ],
    raw,
  ])
}

export function withHttpStatus(result: Result<Json>, httpStatus: number): Result<Json> {
  if (!result.ok || result.value.t !== 'obj') return result
  return {ok: true, value: jobj([['httpStatus', jnum(String(httpStatus))], ...result.value.fields])}
}
