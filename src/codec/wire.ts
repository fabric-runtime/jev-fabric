// The Jev wire format (native/Wire.bend): strict request validation, the
// request body sent upstream, and the typed reply normalized from exactly
// what the request asked.
//
// Numbers stay raw lexemes. Probabilities, scores and token counts are read
// with exact decimal arithmetic, never binary floating point: the mass
// tolerance is exactly [0.98, 1.02], an exponent's magnitude is at most 4096,
// and a token count is an exact integer of at most 2^48 - 1 (the native Nat).
// Every error here is code 22.

import * as Codec from './codec.ts'
import type {Json, Member} from './json.ts'
import {field, jobj, jstr} from './json.ts'
import type {Result} from './result.ts'
import {Failure, attempt, guard, unwrap} from './result.ts'
import {cpLength, toLower} from './text.ts'

const need = (value: Json, key: string): Json => {
  const found = field(value, key)
  if (found === undefined) throw new Failure(22, 'missing wire field')
  return found
}

const object = (value: Json): Member[] => {
  if (value.t !== 'obj') throw new Failure(22, 'expected wire object')
  return value.fields
}

const string = (value: Json): string => {
  if (value.t !== 'str') throw new Failure(22, 'expected wire string')
  return value.v
}

const arrayOf = (value: Json): Json[] => {
  if (value.t !== 'arr') throw new Failure(22, 'expected wire array')
  return value.items
}

// Labels and IDs count UTF-16 units, as the TypeScript client did.
export const label = (s: string, limit: number): boolean => s.length > 0 && s.length <= limit

const description = (v: Json): boolean => v.t === 'str' || v.t === 'arr' || v.t === 'obj'
const describedOrNull = (v: Json): boolean => v.t === 'null' || description(v)
const only = (fields: Member[], keys: readonly string[]): boolean => fields.every(([k]) => keys.includes(k))

function noulCriteria(value: Json | undefined): void {
  if (value === undefined) return
  const fields = object(value)
  guard(
    fields.every(([k, v]) => (k === 'true' || k === 'false') && description(v)),
    'invalid Noul criteria',
  )
}

function questionKind(kind: string, q: Json): void {
  switch (kind) {
    case 'choice': {
      const fields = object(need(q, 'criteria'))
      const n = fields.length
      guard(n >= 1 && n <= 255 && fields.every(([k, v]) => label(k, 256) && describedOrNull(v)), 'invalid Choice criteria')
      return
    }
    case 'score': {
      const items = arrayOf(need(q, 'criteria'))
      const n = items.length
      guard(n >= 2 && n <= 10 && items.every(description), 'invalid Score criteria')
      return
    }
    case 'noul':
      return noulCriteria(field(q, 'criteria'))
    default:
      throw new Failure(22, 'unknown Jev question type')
  }
}

function question(q: Json): void {
  const fields = object(q)
  guard(only(fields, ['type', 'instructions', 'criteria']), 'unknown question field')
  guard(description(need(q, 'instructions')), 'invalid instructions')
  questionKind(string(need(q, 'type')), q)
}

function model(value: Json): void {
  guard(label(string(value), 128), 'invalid model label')
}

function checkRequest(value: Json): Json {
  unwrap(Codec.validate(value))
  const fields = object(value)
  guard(only(fields, ['state', 'questions', 'model']), 'unknown request field')
  guard(description(need(value, 'state')), 'invalid Jev state')
  const qfields = object(need(value, 'questions'))
  guard(qfields.length >= 1 && qfields.length <= 128, 'invalid question count')
  for (const [id, q] of qfields) {
    guard(label(id, 128), 'invalid question id')
    question(q)
  }
  const m = field(value, 'model')
  if (m !== undefined) model(m)
  return value
}

export const validateRequest = (value: Json): Result<Json> => attempt(() => checkRequest(value))

// Wire.request: the request text read by the codec and validated.
export const request = (text: string): Result<Json> =>
  attempt(() => {
    const value = unwrap(Codec.read(text))
    return checkRequest(value)
  })

// Wire.body: the request as sent, with the default model put first when the
// request names none.
export const body = (value: Json, defaultModel: string): Result<string> =>
  attempt(() => {
    const checked = checkRequest(value)
    const fields = object(checked)
    if (field(checked, 'model') !== undefined) return unwrap(Codec.encode(jobj(fields)))
    const m = jstr(defaultModel)
    model(m)
    return unwrap(Codec.encode(jobj([['model', m], ...fields])))
  })

// ---- Exact numeric scalars ---------------------------------------------------------

const stripZeros = (s: string): string => s.replace(/^0+/, '')

function exponentDigits(s: string): number {
  const digits = stripZeros(s)
  guard(digits.length <= 4, 'wire exponent limit')
  const text = `0${digits}`
  if (!/^[0-9]+$/.test(text)) throw new Failure(22, 'wire integer overflow')
  const n = Number(text)
  guard(n <= 4096, 'wire exponent limit')
  return n
}

type Exponent = {up: number; down: number}

function exponent(s: string): Exponent {
  if (s.startsWith('-')) return {up: 0, down: exponentDigits(s.slice(1))}
  if (s.startsWith('+')) return {up: exponentDigits(s.slice(1)), down: 0}
  return {up: exponentDigits(s), down: 0}
}

type Mantissa = {digits: string; fractional: number; negative: boolean}

function mantissa(s: string): Mantissa {
  let digits = ''
  let fractional = 0
  let after = false
  let negative = false
  for (const c of s) {
    if (c === '-') negative = true
    else if (c === '.') after = true
    else {
      digits += c
      if (after) fractional++
    }
  }
  return {digits, fractional, negative}
}

// Leading zeros stripped, trailing zeros counted so they move into the exponent.
function significant(digits: string): [string, number] {
  const lead = stripZeros(digits)
  const trimmed = lead.replace(/0+$/, '')
  return [trimmed, lead.length - trimmed.length]
}

function parts(lex: string): [Mantissa, Exponent] {
  const split = toLower(lex).split('e')
  if (split.length === 1) return [mantissa(split[0]!), {up: 0, down: 0}]
  if (split.length === 2) {
    const e = exponent(split[1]!)
    return [mantissa(split[0]!), e]
  }
  throw new Failure(22, 'invalid numeric scalar')
}

// Wire.scalar: a numeric lexeme as an exact natural scaled by 10^scale,
// refused if any digit would be lost or the value passes `maximum`.
export function scalarOf(value: Json, scale: number, maximum: bigint): bigint {
  if (value.t !== 'num') throw new Failure(22, 'expected numeric wire scalar')
  const [m, e] = parts(value.lex)
  const [trimmed, zeroes] = significant(m.digits)
  if (trimmed === '') return 0n
  const up = scale + e.up + zeroes
  const down = m.fractional + e.down
  guard(!m.negative, 'negative wire scalar')
  guard(up >= down, 'wire scalar exceeds twelve decimal places')
  const shift = up - down
  guard(cpLength(trimmed) + shift <= 15, 'wire scalar overflow')
  const n = BigInt(trimmed + '0'.repeat(shift))
  guard(n <= maximum, 'wire scalar out of range')
  return n
}

export const scalar = (value: Json, scale: number, maximum: bigint): Result<bigint> => attempt(() => scalarOf(value, scale, maximum))

// An exact non-negative decimal: whole part and fraction digits (no trailing zeros).
export type Decimal = {whole: bigint; fraction: string}

function decimalChecked(whole: bigint, fraction: string, maximum: bigint): Decimal {
  guard(whole < maximum || (whole === maximum && fraction === ''), 'wire scalar out of range')
  return {whole, fraction}
}

// Wire.decimal: a numeric lexeme as an exact decimal within [0, maximum].
export function decimalOf(value: Json, maximum: bigint): Decimal {
  if (value.t !== 'num') throw new Failure(22, 'expected numeric wire scalar')
  const [m, e] = parts(value.lex)
  const [digits, zeroes] = significant(m.digits)
  if (digits === '') return {whole: 0n, fraction: ''}
  const up = e.up + zeroes
  const down = m.fractional + e.down
  guard(!m.negative, 'negative wire scalar')
  if (digits.length + up >= down) {
    const count = digits.length + up - down
    guard(count <= 1, 'wire scalar out of range')
    const padding = '0'.repeat(Math.max(0, count - digits.length))
    const whole = BigInt(`0${digits.slice(0, count)}${padding}`)
    return decimalChecked(whole, digits.slice(count), maximum)
  }
  const leading = '0'.repeat(down - (up + digits.length))
  return decimalChecked(0n, leading + digits, maximum)
}

export const decimal = (value: Json, maximum: bigint): Result<Decimal> => attempt(() => decimalOf(value, maximum))

const probabilityOf = (value: Json): Decimal => decimalOf(value, 1n)

// Wire.decimal_add: exact, trailing fraction zeros dropped.
export function decimalAdd(a: Decimal, b: Decimal): Decimal {
  const width = Math.max(a.fraction.length, b.fraction.length)
  const scale = 10n ** BigInt(width)
  const frac = (f: string) => (width === 0 ? 0n : BigInt(f.padEnd(width, '0')))
  const sum = (a.whole + b.whole) * scale + frac(a.fraction) + frac(b.fraction)
  const whole = sum / scale
  const fraction = width === 0 ? '' : (sum % scale).toString().padStart(width, '0').replace(/0+$/, '')
  return {whole, fraction}
}

// Wire.decimal_le.
export function decimalLe(a: Decimal, b: Decimal): boolean {
  if (a.whole !== b.whole) return a.whole < b.whole
  const width = Math.max(a.fraction.length, b.fraction.length)
  return a.fraction.padEnd(width, '0') <= b.fraction.padEnd(width, '0')
}

// 2^48 - 1: the native Nat's range, narrower than JavaScript's safe integers.
export const NAT_MAX = 281474976710655n
export const UNIT = 1000000000000n

// ---- Responses ------------------------------------------------------------------------

function usageCounts(value: Json): [bigint, bigint] {
  const fields = object(need(value, 'usage'))
  const u = jobj(fields)
  const i = need(u, 'input_tokens')
  const o = need(u, 'output_tokens')
  return [scalarOf(i, 0, NAT_MAX), scalarOf(o, 0, NAT_MAX)]
}

// Wire.usage: the token counts of a response, after Codec.validate.
export const usage = (value: Json): Result<[bigint, bigint]> =>
  attempt(() => {
    unwrap(Codec.validate(value))
    return usageCounts(value)
  })

const MASS_LOW: Decimal = {whole: 0n, fraction: '98'}
const MASS_HIGH: Decimal = {whole: 1n, fraction: '02'}

function common(answer: Json, expected: Member[]): {confidence: Json; probabilities: Json} {
  const confidence = need(answer, 'confidence')
  probabilityOf(confidence)
  const p = need(answer, 'probabilities')
  const fields = object(p)
  guard(fields.length === expected.length, 'probability key count mismatch')
  let sum: Decimal = {whole: 0n, fraction: ''}
  for (const [key] of expected) sum = decimalAdd(sum, probabilityOf(need(p, key)))
  guard(decimalLe(MASS_LOW, sum) && decimalLe(sum, MASS_HIGH), 'probability mass outside tolerance')
  const rows: Member[] = expected.map(([key]) => [key, need(p, key)])
  return {confidence, probabilities: jobj(rows)}
}

function answerKind(kind: string, q: Json, a: Json): Json {
  switch (kind) {
    case 'noul': {
      const n = need(a, 'noul')
      probabilityOf(n)
      return jobj([
        ['type', jstr('noul')],
        ['noul', n],
      ])
    }
    case 'choice': {
      const expected = object(need(q, 'criteria'))
      const selected = need(a, 'choice')
      const key = string(selected)
      guard(
        expected.some(([k]) => k === key),
        'unknown selected choice',
      )
      const c = common(a, expected)
      return jobj([
        ['type', jstr('choice')],
        ['choice', selected],
        ['confidence', c.confidence],
        ['probabilities', c.probabilities],
      ])
    }
    case 'score': {
      const levels = arrayOf(need(q, 'criteria'))
      const expected: Member[] = levels.map((level, i) => [String(i), level])
      const score = need(a, 'score')
      decimalOf(score, BigInt(Math.max(0, levels.length - 1)))
      const c = common(a, expected)
      return jobj([
        ['type', jstr('score')],
        ['score', score],
        ['confidence', c.confidence],
        ['probabilities', c.probabilities],
        ['legend', jobj(expected)],
      ])
    }
    default:
      throw new Failure(22, 'unknown answer type')
  }
}

function answer(q: Json, a: Json): Json {
  object(a)
  const kind = string(need(q, 'type'))
  const actual = string(need(a, 'type'))
  guard(kind === actual, 'answer type mismatch')
  return answerKind(kind, q, a)
}

// A normalized reply with the token counts read from its usage.
export type Reply = {value: Json; input: bigint; output: bigint}

// Wire.normalize: `value` already passed Codec.validate (Codec.read does).
function normalize(value: Json, req: Json): Reply {
  object(value)
  const m = need(value, 'model')
  model(m)
  const [input, output] = usageCounts(value)
  const u = need(value, 'usage')
  const inputLex = need(u, 'input_tokens')
  const outputLex = need(u, 'output_tokens')
  const qfields = object(need(req, 'questions'))
  const rawAnswers = need(value, 'answers')
  const afields = object(rawAnswers)
  guard(qfields.length === afields.length, 'answer key count mismatch')
  const safe: Member[] = qfields.map(([id, q]) => [id, answer(q, need(rawAnswers, id))])
  const normalized = jobj([
    ['model', m],
    ['answers', jobj(safe)],
    [
      'usage',
      jobj([
        ['input_tokens', inputLex],
        ['output_tokens', outputLex],
      ]),
    ],
  ])
  return {value: normalized, input, output}
}

export const reply = (text: string, req: Json): Result<Reply> =>
  attempt(() => {
    const checked = checkRequest(req)
    const value = unwrap(Codec.read(text))
    return normalize(value, checked)
  })

export function response(text: string, req: Json): Result<Json> {
  const r = reply(text, req)
  return r.ok ? {ok: true, value: r.value.value} : r
}

// The counts normalize parsed, once the normalized reply itself passes
// Codec.validate: a score legend copies request criteria, so a valid response
// can still normalize past the JSON size limits.
export const replyUsage = (r: Reply): Result<[bigint, bigint]> =>
  attempt(() => {
    unwrap(Codec.validate(r.value))
    return [r.input, r.output]
  })
