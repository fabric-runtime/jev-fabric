// Label softmax statistics (native/DecisionMath.bend and decision_math.c):
// finite double arithmetic over 2..62 label logprobs at a temperature, as
// JSON with round-tripping doubles (C's %.17g). Pure: in 0.8.1 this was a
// trusted C boundary; here it is ordinary code.
//
// One known difference is possible in principle: Math.exp and the C
// library's exp may differ in the last bit for some inputs.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {cpLength} from '../codec/text.ts'

const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/

// A strict JSON number of at most 1024 characters, finite as a double.
function number(s: string): number | null {
  if (s.length === 0 || s.length > 1024 || !NUMBER.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

// Positive logprobs are invalid even where the decimal underflows to zero.
function nonzeroMantissa(s: string): boolean {
  for (const c of s) {
    if (c === 'e' || c === 'E') return false
    if (c >= '1' && c <= '9') return true
  }
  return false
}

// C's printf("%.17g").
export function g17(value: number): string {
  if (value === 0) return '0'
  const [mant, expText] = value.toExponential(16).split('e') as [string, string]
  const exp = Number(expText)
  if (exp < -4 || exp >= 17) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant
    const sign = exp < 0 ? '-' : '+'
    return `${m}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  const fixed = value.toFixed(Math.max(0, 16 - exp))
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

function emit(value: number): string | null {
  if (!Number.isFinite(value)) return null
  const text = g17(value === 0 ? 0 : value)
  const back = number(text)
  return back !== null && back === value ? text : null
}

const INVALID = () => fail(22, 'invalid/nonfinite local probability statistics')

function compute(temp: string, input: string): string | null {
  if (temp.length > 1024 || input.length > 63550) return null
  const t = number(temp)
  if (t === null || !(t > 0)) return null
  if (input.length === 0) return '{}'
  const lines = input.split('\n')
  // A trailing newline (an empty last line) is refused, as in C.
  if (lines.length > 1 && lines[lines.length - 1] === '') return null
  if (lines.length > 62) return null
  const values: number[] = []
  let peak = -Infinity
  let best = 0
  for (const line of lines) {
    const v = number(line)
    if (v === null || v > 0 || (!line.startsWith('-') && nonzeroMantissa(line))) return null
    if (v > peak) {
      peak = v
      best = values.length
    }
    values.push(v)
  }
  if (values.length < 2 || peak <= -1e30) return null
  const weights: number[] = []
  let total = 0
  for (const v of values) {
    // Subtract before dividing: finite inputs over a tiny t must not overflow.
    const scaled = (v - peak) / t
    if (Number.isNaN(scaled) || scaled > 0) return null
    const w = scaled === -Infinity ? 0 : Math.exp(scaled)
    if (!Number.isFinite(w)) return null
    weights.push(w)
    total += w
  }
  if (!Number.isFinite(total) || total <= 0) return null
  const parts: string[] = []
  let score = 0
  for (let i = 0; i < weights.length; i++) {
    const p = weights[i]! / total
    score += i * p
    const text = emit(p)
    if (text === null) return null
    parts.push(text)
  }
  const n = weights.length
  const confidence = Math.min(1, Math.max(0, ((n * weights[best]!) / total - 1) / (n - 1)))
  const c = emit(confidence)
  const sc = emit(score)
  if (c === null || sc === null) return null
  const out = `{"probabilities":[${parts.join(',')}],"best":${best},"confidence":${c},"score":${sc}}`
  return out.length < 8192 ? out : null
}

// DecisionMath.statistics: the label probabilities, the best label, a
// confidence and an expected score. Empty values validate the temperature.
export function statistics(temperature: string, values: string): Result<string> {
  if (!(cpLength(temperature) <= 1024 && cpLength(values) <= 63550)) return fail(22, 'local math input limit')
  const out = compute(temperature, values)
  return out === null ? INVALID() : done(out)
}
