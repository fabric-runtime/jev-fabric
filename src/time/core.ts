// Pure deadline policy (native/TimeCore.bend): the default limits, the
// parser every timeout goes through, and one absolute budget observed
// against a clock. Defaults are policy, never sleeps; an operator may
// override each once (src/time/time.ts reads the environment).

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'

export const workDefault = 3600000
export const jevDefault = 30000
export const waitDefault = 30000
export const watchDefault = 5000
/** Detached `start` jobs alone may run for a day; every other limit stays one hour. */
export const jobMax = 86400000

export const TIMEOUT_ERROR = 'timeout must be an integer within the operation limit'

/** TimeCore.checked: a limit the caller found valid, or the one refusal. */
export const checked = (ms: number, valid: boolean): Result<number> => (valid ? done(ms) : fail(2, TIMEOUT_ERROR))

/** TimeCore.parsed: 1..max, or the refusal (none parsed is refused too). */
export const parsed = (value: number | null, max: number): Result<number> =>
  value === null ? fail(2, TIMEOUT_ERROR) : checked(value, value >= 1 && value <= max)

/** Bend's U32.read: one or more ASCII digits whose value fits in 32 bits. */
export function readU32(s: string): number | null {
  if (!/^[0-9]+$/.test(s)) return null
  const trimmed = s.replace(/^0+/, '')
  if (trimmed.length > 10) return null
  const n = Number(trimmed || '0')
  return n <= 0xffffffff ? n : null
}

/** Bend's Nat.read: ASCII digits whose value (leading zeros dropped) fits in 48 bits. */
export function readNat(s: string): number | null {
  if (!/^[0-9]+$/.test(s)) return null
  const t = s.replace(/^0+/, '')
  if (!(t.length < 15 || (t.length === 15 && t <= '281474976710655'))) return null
  return Number(t || '0')
}

const trimZeros = (text: string) => text.replace(/^0+/, '')

/**
 * TimeCore.parse: leading zeros are dropped, then at most eight digits (every
 * limit fits, job_max included, and none can overflow) within 1..max.
 */
export function parse(raw: string, max: number): Result<number> {
  const t = trimZeros(raw)
  // Bend counts characters (code points); eight of them bound the digits.
  if ([...t].length > 8) return fail(2, TIMEOUT_ERROR)
  return parsed(readU32(t), max)
}

/** TimeCore.config: an unset (empty) setting is the default; any other must parse. */
export const config = (raw: string, fallback: number, max: number): Result<number> => (raw === '' ? done(fallback) : parse(raw, max))

/** One absolute budget, observed; it owns no OS handles. */
export type Budget = {started: number; duration: number}

/** Natural subtraction, as Bend's Nat.sub: never below zero. */
export const sub = (a: number, b: number): number => (a > b ? a - b : 0)

/** TimeCore.remaining: the elapsed time is subtracted, never renewed. */
export const remaining = (budget: Budget, now: number): number => sub(budget.duration, sub(now, budget.started))

/** TimeCore.cap: the local cap applies before the value narrows to a U32. */
export const cap = (left: number, local: number): number => Math.min(left, local) >>> 0
