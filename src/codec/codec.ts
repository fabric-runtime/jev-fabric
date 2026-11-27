// The bounded codec every caller uses (native/Codec.bend): strict JSON read
// and written within fixed limits, and strict UTF-8.
//
// Limits: 1 MiB of UTF-8 text, nesting 64, 32768 non-whitespace characters
// outside strings and 32768 AST jobs, 256 members per object, keys of at most
// 256 scalars, a 1 MiB budget of key comparisons, numeric lexemes of at most
// 1024 characters. Encoding validates the AST first and scans its output
// again. Every error is code 22 with the native message, except a parse
// error, whose code is the position it failed at.

import type {Json, Member} from './json.ts'
import {parse, writeWithFuel} from './json.ts'
import type {Result} from './result.ts'
import {Failure, attempt, done, fail, guard, unwrap} from './result.ts'
import {cpLength, isScalar, utf8Width} from './text.ts'

export const BYTES_MAX = 1048576
export const DEPTH_MAX = 64
export const WORK_MAX = 32768
export const LARGE_BYTES_MAX = 16777216
export const PROFILE_WORK_MAX = 524288

// ---- The textual scan ---------------------------------------------------------

export type Scan = {quoted: boolean; escaped: boolean; depth: number; work: number}

export const newScan = (): Scan => ({quoted: false, escaped: false, depth: 0, work: 0})

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13
const opens = (c: number) => c === 91 || c === 123
const closes = (c: number) => c === 93 || c === 125
const structural = (c: number) => c === 34 || c === 44 || c === 58 || opens(c) || closes(c)

// One character of Codec.scan_profile_step. `wide` (a work limit above the
// standard 32768) counts only structural characters outside strings.
export function scanStep(s: Scan, c: number, wide: boolean): void {
  if (s.quoted) {
    if (s.escaped) s.escaped = false
    else {
      s.quoted = c !== 34
      s.escaped = c === 92
    }
    return
  }
  s.quoted = c === 34
  s.escaped = false
  // U32 arithmetic: a close at depth 0 wraps past every limit, as in 0.8.1.
  s.depth = (s.depth + (opens(c) ? 1 : 0) - (closes(c) ? 1 : 0)) >>> 0
  s.work = (s.work + ((wide ? structural(c) : !isWs(c)) ? 1 : 0)) >>> 0
}

// Codec.scan_profile: every character a scalar, within `bytes` of UTF-8, and
// depth and work within their limits after each one.
function scanProfile(text: string, bytes: number, work: number, error: string): void {
  const s: Scan = {quoted: false, escaped: false, depth: 0, work: 0}
  const wide = work > WORK_MAX
  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i)!
    i += c > 0xffff ? 2 : 1
    const size = utf8Width(c)
    guard(isScalar(c), 'invalid Unicode scalar')
    guard(bytes >= size, error)
    scanStep(s, c, wide)
    guard(s.depth <= DEPTH_MAX && s.work <= work, 'JSON depth/work limit')
    bytes -= size
  }
}

const scan = (text: string, bytes: number, error = 'JSON exceeds 1 MiB') => scanProfile(text, bytes, WORK_MAX, error)

// The textual scan alone (for the laws): every scalar, the bytes, depth and work.
export const scanText = (text: string, bytes: number, work: number, error: string): Result<null> =>
  attempt(() => {
    scanProfile(text, bytes, work, error)
    return null
  })

// ---- The AST validator ----------------------------------------------------------

// Codec.string_cost: the budget left after a string's UTF-8 bytes, every
// character a scalar.
function stringCost(s: string, budget: number): number {
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!
    i += c > 0xffff ? 2 : 1
    const w = utf8Width(c)
    guard(isScalar(c) && budget >= w, 'JSON string/byte limit')
    budget -= w
  }
  return budget
}

type Job =
  | {k: 'val'; v: Json; depth: number}
  | {k: 'items'; xs: Json[]; i: number; depth: number}
  | {k: 'fields'; fs: Member[]; i: number; depth: number; seen: Set<string>}

// Codec.valid: a worklist of at most `fuel` jobs, in the native order (each
// value before its later siblings), so the first limit broken is the same.
function valid(fuel: number, root: Json, bytes: number, cost: number): void {
  const jobs: Job[] = [{k: 'val', v: root, depth: 0}]
  while (jobs.length > 0) {
    if (fuel <= 0) throw new Failure(22, 'JSON node limit')
    fuel--
    const job = jobs.pop()!
    switch (job.k) {
      case 'val': {
        const v = job.v
        switch (v.t) {
          case 'null':
          case 'bool':
            break
          case 'str':
            bytes = stringCost(v.v, bytes)
            break
          case 'num': {
            const left = stringCost(v.lex, bytes)
            guard(cpLength(v.lex) <= 1024, 'JSON numeric lexeme limit')
            const parsed = unwrap(parse(v.lex))
            guard(parsed.t === 'num' && parsed.lex === v.lex, 'invalid number lexeme')
            bytes = left
            break
          }
          case 'arr':
            guard(job.depth < DEPTH_MAX, 'JSON depth limit')
            jobs.push({k: 'items', xs: v.items, i: 0, depth: job.depth + 1})
            break
          case 'obj':
            guard(job.depth < DEPTH_MAX, 'JSON depth limit')
            jobs.push({k: 'fields', fs: v.fields, i: 0, depth: job.depth + 1, seen: new Set()})
            break
          default:
            throw new Failure(22, 'member outside object')
        }
        break
      }
      case 'items': {
        if (job.i >= job.xs.length) break
        jobs.push({k: 'items', xs: job.xs, i: job.i + 1, depth: job.depth}, {k: 'val', v: job.xs[job.i]!, depth: job.depth})
        break
      }
      case 'fields': {
        if (job.i >= job.fs.length) break
        const m = job.fs[job.i]
        if (!Array.isArray(m) || m.length !== 2 || typeof m[0] !== 'string') throw new Failure(22, 'object field is not a member')
        const [key, value] = m
        const left = stringCost(key, bytes)
        const length = cpLength(key)
        const count = job.i
        guard(length <= 256 && count < 256, 'JSON key limit')
        // A duplicate check compares with every earlier key: (length+1)*(count+1).
        const charge = (length + 1) * (count + 1)
        guard(cost >= charge, 'JSON key comparison limit')
        guard(!job.seen.has(key), 'duplicate JSON key')
        job.seen.add(key)
        jobs.push({k: 'fields', fs: job.fs, i: job.i + 1, depth: job.depth, seen: job.seen}, {k: 'val', v: value, depth: job.depth})
        bytes = left
        cost -= charge
        break
      }
    }
  }
}

function limitValid(bytes: number): void {
  guard(bytes <= LARGE_BYTES_MAX, 'JSON limit exceeds 16 MiB')
}

function profileValid(bytes: number, work: number): void {
  limitValid(bytes)
  guard(work <= PROFILE_WORK_MAX, `JSON profile work exceeds ${PROFILE_WORK_MAX}`)
}

// ---- Entry points (Result-returning, as Codec's) --------------------------------

export const validate = (value: Json): Result<Json> =>
  attempt(() => {
    valid(32768, value, BYTES_MAX, BYTES_MAX)
    return value
  })

export const read = (text: string): Result<Json> =>
  attempt(() => {
    scan(text, BYTES_MAX)
    const value = unwrap(parse(text))
    valid(32768, value, BYTES_MAX, BYTES_MAX)
    return value
  })

export const encode = (value: Json): Result<string> =>
  attempt(() => {
    valid(32768, value, BYTES_MAX, BYTES_MAX)
    const text = unwrap(writeWithFuel(131072, value))
    scan(text, BYTES_MAX)
    return text
  })

// Large decision payloads opt in explicitly; node, depth and key work budgets
// do not grow.
export const validateWithLimit = (value: Json, bytes: number): Result<Json> =>
  attempt(() => {
    limitValid(bytes)
    valid(32768, value, bytes, BYTES_MAX)
    return value
  })

export const readWithLimit = (text: string, bytes: number): Result<Json> =>
  attempt(() => {
    limitValid(bytes)
    scan(text, bytes, 'JSON byte limit')
    const value = unwrap(parse(text))
    valid(32768, value, bytes, BYTES_MAX)
    return value
  })

export const encodeWithLimit = (value: Json, bytes: number): Result<string> =>
  attempt(() => {
    limitValid(bytes)
    valid(32768, value, bytes, BYTES_MAX)
    const text = unwrap(writeWithFuel(131072, value))
    scan(text, bytes, 'JSON byte limit')
    return text
  })

// The high-work profile, only for local top_logprobs replies and results;
// never selected by a request field.
export const validateProfile = (value: Json, bytes: number, work: number): Result<Json> =>
  attempt(() => {
    profileValid(bytes, work)
    valid(work, value, bytes, (work * 32) >>> 0)
    return value
  })

export const readProfile = (text: string, bytes: number, work: number): Result<Json> =>
  attempt(() => {
    profileValid(bytes, work)
    scanProfile(text, bytes, work, 'JSON byte limit')
    const value = unwrap(parse(text))
    valid(work, value, bytes, (work * 32) >>> 0)
    return value
  })

export const encodeProfile = (value: Json, bytes: number, work: number): Result<string> =>
  attempt(() => {
    profileValid(bytes, work)
    valid(work, value, bytes, (work * 32) >>> 0)
    // Writer jobs include punctuation: the standard 4x node-fuel ratio.
    const text = unwrap(writeWithFuel((work * 4) >>> 0, value))
    scanProfile(text, bytes, work, 'JSON byte limit')
    return text
  })

// Codec.contains, for the strict key lists.
export const contains = (keys: readonly string[], key: string): boolean => keys.includes(key)

// ---- UTF-8 ------------------------------------------------------------------------

// Strict UTF-8 (Codec.utf8_with_error): `fuel` bytes at most, else `error`;
// overlong forms, surrogates, values past U+10FFFF, stray continuations and
// truncation refused. Bytes are numbers so a non-byte value is refused too.
function utf8(fuel: number, bytes: ArrayLike<number>, error: string): string {
  let remaining = 0
  let code = 0
  let minimum = 0
  const out: string[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length) {
      out.push(String.fromCodePoint(...run))
      run = []
    }
  }
  for (let i = 0; i < bytes.length; i++) {
    if (fuel <= 0) throw new Failure(22, error)
    fuel--
    const b = bytes[i]!
    if (remaining === 0) {
      if (b < 128) {
        run.push(b)
      } else {
        guard(b >= 194 && b <= 244, 'invalid UTF-8 lead')
        if (b < 224) [remaining, code, minimum] = [1, b % 32, 128]
        else if (b < 240) [remaining, code, minimum] = [2, b % 16, 2048]
        else [remaining, code, minimum] = [3, b % 8, 65536]
      }
    } else {
      guard(b >= 128 && b <= 191, 'invalid UTF-8 continuation')
      code = code * 64 + (b - 128)
      remaining--
      if (remaining === 0) {
        guard(code >= minimum && isScalar(code), 'noncanonical UTF-8 scalar')
        run.push(code)
      }
    }
    if (run.length >= 4096) flush()
  }
  if (remaining !== 0) throw new Failure(22, 'truncated UTF-8')
  flush()
  return out.join('')
}

export const decodeUtf8 = (bytes: ArrayLike<number>): Result<string> => attempt(() => utf8(BYTES_MAX, bytes, 'UTF-8 exceeds 1 MiB'))

export const decodeUtf8WithLimit = (bytes: ArrayLike<number>, limit: number): Result<string> =>
  attempt(() => {
    limitValid(limit)
    return utf8(limit, bytes, 'UTF-8 byte limit')
  })

export function readBytes(bytes: ArrayLike<number>): Result<Json> {
  const text = decodeUtf8(bytes)
  return text.ok ? read(text.value) : text
}

export function readBytesWithLimit(bytes: ArrayLike<number>, limit: number): Result<Json> {
  const text = decodeUtf8WithLimit(bytes, limit)
  return text.ok ? readWithLimit(text.value, limit) : text
}

export function readBytesProfile(bytes: ArrayLike<number>, limit: number, work: number): Result<Json> {
  const text = decodeUtf8WithLimit(bytes, limit)
  return text.ok ? readProfile(text.value, limit, work) : text
}

// UTF-8 bytes of a string (lone surrogates have none: encode only scalars).
export const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

export {done, fail}
export type {Json, Member} from './json.ts'
export {field, findField, text, array, escape, fromJs, jarr, jbool, jnull, jnum, jobj, jstr, NULL} from './json.ts'
