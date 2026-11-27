// The Jev wire helpers the decision modules share (the parts of
// native/Wire.bend that DecisionWire, DecisionGenerated, DecisionProfiles and
// DecisionLocal call directly). Throwing style: each failure is a Failure
// with Wire's code (22) and message; entry points catch it once. Pure.

import type {Json, Member} from '../codec/json.ts'
import {field, jobj} from '../codec/json.ts'
import {Failure, guard} from '../codec/result.ts'
import * as Wire from '../codec/wire.ts'

export const need = (value: Json, key: string): Json => {
  const found = field(value, key)
  if (found === undefined) throw new Failure(22, 'missing wire field')
  return found
}

export const object = (value: Json): Member[] => {
  if (value.t !== 'obj') throw new Failure(22, 'expected wire object')
  return value.fields
}

export const string = (value: Json): string => {
  if (value.t !== 'str') throw new Failure(22, 'expected wire string')
  return value.v
}

export const array = (value: Json): Json[] => {
  if (value.t !== 'arr') throw new Failure(22, 'expected wire array')
  return value.items
}

// Labels count UTF-16 units, as Wire.label.
export const label = Wire.label

export const description = (v: Json): boolean => v.t === 'str' || v.t === 'arr' || v.t === 'obj'
export const describedOrNull = (v: Json): boolean => v.t === 'null' || description(v)
export const only = (fields: readonly Member[], keys: readonly string[]): boolean => fields.every(([k]) => keys.includes(k))
export const named = (fields: readonly Member[], key: string): boolean => fields.some(([k]) => k === key)

// "0", "1", ... mapped to each level.
export const indexed = (items: readonly Json[]): Member[] => items.map((item, i) => [String(i), item])

export function noulCriteria(value: Json | undefined): void {
  if (value === undefined) return
  const fields = object(value)
  guard(
    fields.every(([k, v]) => (k === 'true' || k === 'false') && description(v)),
    'invalid Noul criteria',
  )
}

// Wire.question_kind: the Jev types and their criteria.
export function questionKind(kind: string, q: Json): void {
  switch (kind) {
    case 'choice': {
      const fields = object(need(q, 'criteria'))
      guard(fields.length >= 1 && fields.length <= 255 && fields.every(([k, v]) => label(k, 256) && describedOrNull(v)), 'invalid Choice criteria')
      return
    }
    case 'score': {
      const items = array(need(q, 'criteria'))
      guard(items.length >= 2 && items.length <= 10 && items.every(description), 'invalid Score criteria')
      return
    }
    case 'noul':
      return noulCriteria(field(q, 'criteria'))
    default:
      throw new Failure(22, 'unknown Jev question type')
  }
}

// Wire.model: a string label of at most 128 UTF-16 units.
export function model(value: Json): void {
  guard(label(string(value), 128), 'invalid model label')
}

export const scalar = Wire.scalarOf
export const decimal = Wire.decimalOf
export const probability = (v: Json): Wire.Decimal => Wire.decimalOf(v, 1n)
export const NAT_MAX = Wire.NAT_MAX

// Wire.probability_sum over the expected keys (each must be present).
export function probabilitySum(expected: readonly Member[], actual: Json): Wire.Decimal {
  let sum: Wire.Decimal = {whole: 0n, fraction: ''}
  for (const [key] of expected) sum = Wire.decimalAdd(sum, probability(need(actual, key)))
  return sum
}

// Wire.ordered: the actual values in the expected keys' order.
export const ordered = (expected: readonly Member[], actual: Json): Member[] => expected.map(([key]) => [key, need(actual, key)])

export const withinTolerance = (sum: Wire.Decimal): boolean =>
  Wire.decimalLe({whole: 0n, fraction: '98'}, sum) && Wire.decimalLe(sum, {whole: 1n, fraction: '02'})

export const decimalLe = Wire.decimalLe

// Wire's lexeme parts, for DecisionLocal's temperature check.
export const zeros = (s: string): string => s.replace(/^0+/, '')

export type Mantissa = {digits: string; fractional: number; negative: boolean}
export type Exponent = {up: number; down: number}

export function plainMantissa(s: string): Mantissa {
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

function exponentDigits(s: string): number {
  const digits = zeros(s)
  guard(digits.length <= 4, 'wire exponent limit')
  const text = `0${digits}`
  if (!/^[0-9]+$/.test(text)) throw new Failure(22, 'wire integer overflow')
  const n = Number(text)
  guard(n <= 4096, 'wire exponent limit')
  return n
}

export function exponent(s: string): Exponent {
  if (s.startsWith('-')) return {up: 0, down: exponentDigits(s.slice(1))}
  if (s.startsWith('+')) return {up: exponentDigits(s.slice(1)), down: 0}
  return {up: exponentDigits(s), down: 0}
}

export const empty = (): Json => jobj([])
