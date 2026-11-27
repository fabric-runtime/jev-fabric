// The strict JSON parser and writer (native/vendor/strict-json/json.bend).
//
// The AST keeps every number as its raw lexeme and every object as its
// members in order (duplicates and all: Codec rejects those). The parser is
// the same character-at-a-time machine, so a failure names the same message
// at the same position: the position (in code points) is the error code, as
// it was in 0.8.1, and the CLI exits with it. Callers outside src/codec go
// through Codec, which bounds input before parsing.

import {isScalar} from './text.ts'
import type {Result} from './result.ts'
import {done, fail} from './result.ts'

export type Json =
  | {t: 'null'}
  | {t: 'bool'; v: boolean}
  | {t: 'num'; lex: string}
  | {t: 'str'; v: string}
  | {t: 'arr'; items: Json[]}
  | {t: 'obj'; fields: Member[]}
export type Member = [key: string, value: Json]

export const NULL: Json = {t: 'null'}
export const jnull = (): Json => NULL
export const jbool = (v: boolean): Json => ({t: 'bool', v})
export const jnum = (lex: string): Json => ({t: 'num', lex})
export const jstr = (v: string): Json => ({t: 'str', v})
export const jarr = (items: Json[]): Json => ({t: 'arr', items})
export const jobj = (fields: Member[]): Json => ({t: 'obj', fields})

// ---- Parse ------------------------------------------------------------------

// Number states, what the walk needs next, and the walk's mode.
const N = {Minus: 0, Zero: 1, Int: 2, Dot: 3, Frac: 4, E: 5, ESign: 6, Exp: 7} as const
type N = (typeof N)[keyof typeof N]
const Need = {Val: 0, Key: 1, Colon: 2, After: 3, End: 4} as const
type Need = (typeof Need)[keyof typeof Need]
const Mode = {Need: 0, Str: 1, Num: 2, Lit: 3} as const
type Mode = (typeof Mode)[keyof typeof Mode]

type Frame = {k: 'arr'; rev: Json[]} | {k: 'obj'; rev: Member[]} | {k: 'key'; rev: Member[]; key: string}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13
const isDigit = (c: number) => c >= 48 && c <= 57
const isE = (c: number) => c === 101 || c === 69
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

function hexVal(c: number): number | null {
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  if (c >= 48 && c <= 57) return c - 48
  return null
}

function escRead(c: number): number | null {
  switch (c) {
    case 34:
      return 34
    case 92:
      return 92
    case 47:
      return 47
    case 110:
      return 10
    case 114:
      return 13
    case 116:
      return 9
    case 98:
      return 8
    case 102:
      return 12
    default:
      return null
  }
}

const canEnd = (st: N) => st === N.Zero || st === N.Int || st === N.Frac || st === N.Exp

function numCont(st: N, c: number): boolean {
  switch (st) {
    case N.Minus:
      return isDigit(c)
    case N.Zero:
      return c === 46 || isE(c)
    case N.Int:
      return isDigit(c) || c === 46 || isE(c)
    case N.Dot:
      return isDigit(c)
    case N.Frac:
      return isDigit(c) || isE(c)
    case N.E:
      return isDigit(c) || c === 45 || c === 43
    case N.ESign:
      return isDigit(c)
    case N.Exp:
      return isDigit(c)
  }
}

function numNext(st: N, c: number): N {
  switch (st) {
    case N.Minus:
      return c === 48 ? N.Zero : N.Int
    case N.Zero:
      return c === 46 ? N.Dot : N.E
    case N.Int:
      return isDigit(c) ? N.Int : c === 46 ? N.Dot : N.E
    case N.Dot:
      return N.Frac
    case N.Frac:
      return isDigit(c) ? N.Frac : N.E
    case N.E:
      return isDigit(c) ? N.Exp : N.ESign
    case N.ESign:
      return N.Exp
    case N.Exp:
      return N.Exp
  }
}

class ParseError {
  readonly pos: number
  readonly msg: string
  constructor(pos: number, msg: string) {
    this.pos = pos
    this.msg = msg
  }
}

// JSON.read: the whole text as one value, or the first failure's position
// and message.
export function parse(text: string): Result<Json> {
  const stk: Frame[] = []
  let mode = Mode.Need as Mode
  let need = Need.Val as Need
  let end: Json = NULL
  // String mode.
  let esc = false
  let hex = 0
  let hexv = 0
  let high = 0
  let asKey = false
  let buf = ''
  // Number mode.
  let lex = ''
  let st = N.Int as N
  // Literal mode.
  let want = ''
  let wi = 0
  let lit: Json = NULL

  const put = (pos: number, v: Json) => {
    const h = stk[stk.length - 1]
    if (!h) {
      mode = Mode.Need
      need = Need.End
      end = v
      return
    }
    if (h.k === 'arr') h.rev.push(v)
    else if (h.k === 'key') stk[stk.length - 1] = {k: 'obj', rev: (h.rev.push([h.key, v]), h.rev)}
    else throw new ParseError(pos, 'unexpected value')
    mode = Mode.Need
    need = Need.After
  }

  const stepNeed = (pos: number, c: number) => {
    switch (need) {
      case Need.Val: {
        if (isWs(c)) return
        if (c === 93) {
          const h = stk[stk.length - 1]
          if (!h || h.k !== 'arr') throw new ParseError(pos, 'unexpected ]')
          if (h.rev.length > 0) throw new ParseError(pos, 'trailing comma')
          stk.pop()
          return put(pos, {t: 'arr', items: []})
        }
        if (c === 91) {
          stk.push({k: 'arr', rev: []})
          need = Need.Val
          return
        }
        if (c === 123) {
          stk.push({k: 'obj', rev: []})
          need = Need.Key
          return
        }
        if (c === 34) {
          mode = Mode.Str
          esc = false
          hex = 0
          hexv = 0
          high = 0
          asKey = false
          buf = ''
          return
        }
        if (c === 45 || isDigit(c)) {
          mode = Mode.Num
          lex = String.fromCodePoint(c)
          st = c === 45 ? N.Minus : c === 48 ? N.Zero : N.Int
          return
        }
        if (c === 116) [want, lit] = ['rue', {t: 'bool', v: true}]
        else if (c === 102) [want, lit] = ['alse', {t: 'bool', v: false}]
        else if (c === 110) [want, lit] = ['ull', NULL]
        else throw new ParseError(pos, 'unexpected char')
        mode = Mode.Lit
        wi = 0
        return
      }
      case Need.Key: {
        if (isWs(c)) return
        if (c === 125) {
          const h = stk[stk.length - 1]
          if (!h || h.k !== 'obj') throw new ParseError(pos, 'unexpected }')
          if (h.rev.length > 0) throw new ParseError(pos, 'trailing comma')
          stk.pop()
          return put(pos, {t: 'obj', fields: []})
        }
        if (c === 34) {
          mode = Mode.Str
          esc = false
          hex = 0
          hexv = 0
          high = 0
          asKey = true
          buf = ''
          return
        }
        throw new ParseError(pos, 'expected key')
      }
      case Need.Colon: {
        if (isWs(c)) return
        if (c === 58) {
          need = Need.Val
          return
        }
        throw new ParseError(pos, 'expected colon')
      }
      case Need.After: {
        if (isWs(c)) return
        const h = stk[stk.length - 1]
        if (c === 44) {
          if (!h || h.k === 'key') throw new ParseError(pos, 'unexpected comma')
          need = h.k === 'arr' ? Need.Val : Need.Key
          return
        }
        if (c === 93) {
          if (!h || h.k !== 'arr') throw new ParseError(pos, 'unexpected ]')
          stk.pop()
          return put(pos, {t: 'arr', items: h.rev})
        }
        if (c === 125) {
          if (!h || h.k !== 'obj') throw new ParseError(pos, 'unexpected }')
          stk.pop()
          return put(pos, {t: 'obj', fields: h.rev})
        }
        throw new ParseError(pos, 'expected comma')
      }
      case Need.End: {
        if (isWs(c)) return
        throw new ParseError(pos, 'trailing junk')
      }
    }
  }

  const endString = (pos: number) => {
    if (asKey) {
      const h = stk[stk.length - 1]
      if (!h || h.k !== 'obj') throw new ParseError(pos, 'bad key')
      stk[stk.length - 1] = {k: 'key', rev: h.rev, key: buf}
      mode = Mode.Need
      need = Need.Colon
      return
    }
    put(pos, {t: 'str', v: buf})
  }

  const append = (code: number) => {
    buf += code >= 0xd800 && code <= 0xdfff ? String.fromCharCode(code) : String.fromCodePoint(code)
  }

  const stepStr = (pos: number, c: number) => {
    if (esc) {
      if (c === 117) {
        esc = false
        hex = 4
        hexv = 0
        return
      }
      if (high !== 0) throw new ParseError(pos, 'unpaired high surrogate')
      const ch = escRead(c)
      if (ch === null) throw new ParseError(pos, 'bad escape')
      esc = false
      append(ch)
      return
    }
    if (hex !== 0) {
      const d = hexVal(c)
      if (d === null) throw new ParseError(pos, 'bad unicode escape')
      if (hex !== 1) {
        hex--
        hexv = hexv * 16 + d
        return
      }
      const code = hexv * 16 + d
      hex = 0
      hexv = 0
      if (high === 0) {
        if (isLow(code)) throw new ParseError(pos, 'unpaired low surrogate')
        if (isHigh(code)) high = code
        else append(code)
        return
      }
      if (!isLow(code)) throw new ParseError(pos, 'unpaired high surrogate')
      append(65536 + (high - 55296) * 1024 + (code - 56320))
      high = 0
      return
    }
    if (high !== 0) {
      if (c === 92) {
        esc = true
        return
      }
      throw new ParseError(pos, 'unpaired high surrogate')
    }
    if (c === 34) return endString(pos)
    if (c === 92) {
      esc = true
      return
    }
    if (c < 32) throw new ParseError(pos, 'unescaped control')
    if (!isScalar(c)) throw new ParseError(pos, 'invalid unicode scalar')
    append(c)
  }

  let pos = 0
  try {
    for (let i = 0; i < text.length; pos++) {
      const c = text.codePointAt(i)!
      i += c > 0xffff ? 2 : 1
      switch (mode) {
        case Mode.Need:
          stepNeed(pos, c)
          break
        case Mode.Str:
          stepStr(pos, c)
          break
        case Mode.Num:
          if (numCont(st, c)) {
            lex += String.fromCodePoint(c)
            st = numNext(st, c)
          } else {
            if (!canEnd(st)) throw new ParseError(pos, 'incomplete number')
            put(pos, {t: 'num', lex})
            stepNeed(pos, c)
          }
          break
        case Mode.Lit: {
          if (wi >= want.length || want.charCodeAt(wi) !== c) throw new ParseError(pos, 'bad literal')
          wi++
          if (wi === want.length) put(pos, lit)
          break
        }
      }
    }
    // End of input.
    switch (mode) {
      case Mode.Num:
        if (!canEnd(st)) return fail(pos, 'bad number')
        put(pos, {t: 'num', lex})
        return need === Need.End ? done(end) : fail(pos, 'unexpected end')
      case Mode.Need:
        return need === Need.End ? done(end) : fail(pos, 'unexpected end')
      case Mode.Str:
        return fail(pos, 'unterminated string')
      case Mode.Lit:
        return fail(pos, 'unexpected end')
    }
  } catch (e) {
    if (e instanceof ParseError) return fail(e.pos, e.msg)
    throw e
  }
}

// ---- Write ------------------------------------------------------------------

// JSON.esc: a string literal, the short escapes where JSON has them and
// \u00xx (lower-case hex) for the other controls; everything else as is.
export function escape(s: string): string {
  let out = '"'
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c !== 34 && c !== 92 && c >= 32) continue
    out += s.slice(from, i)
    from = i + 1
    if (c === 34) out += '\\"'
    else if (c === 92) out += '\\\\'
    else if (c === 10) out += '\\n'
    else if (c === 13) out += '\\r'
    else if (c === 9) out += '\\t'
    else if (c === 8) out += '\\b'
    else if (c === 12) out += '\\f'
    else out += `\\u00${c.toString(16).padStart(2, '0')}`
  }
  return `${out + s.slice(from)}"`
}

// The encoder's jobs: one value, an array or object's first or later item,
// or literal text. Each job is one unit of fuel, as in JSON.encode.go.
type Job =
  | {k: 'lit'; s: string}
  | {k: 'val'; v: Json}
  | {k: 'arr'; xs: Json[]; i: number; first: boolean}
  | {k: 'obj'; fs: Member[]; i: number; first: boolean}

// JSON.write_with_fuel: a nonrecursive worklist; running out of fuel with
// jobs left is "JSON encoding work limit". A number is written only if it
// parses back as a number.
export function writeWithFuel(fuel: number, v: Json): Result<string> {
  const jobs: Job[] = [{k: 'val', v}]
  const acc: string[] = []
  while (jobs.length > 0) {
    if (fuel <= 0) return fail(22, 'JSON encoding work limit')
    fuel--
    const h = jobs.pop()!
    switch (h.k) {
      case 'lit':
        acc.push(h.s)
        break
      case 'val': {
        const x = h.v
        switch (x.t) {
          case 'null':
            acc.push('null')
            break
          case 'bool':
            acc.push(x.v ? 'true' : 'false')
            break
          case 'num': {
            const p = parse(x.lex)
            if (!p.ok || p.value.t !== 'num') return fail(22, 'invalid number lexeme')
            acc.push(x.lex)
            break
          }
          case 'str':
            acc.push(escape(x.v))
            break
          case 'arr':
            jobs.push({k: 'lit', s: ']'}, {k: 'arr', xs: x.items, i: 0, first: true})
            acc.push('[')
            break
          case 'obj':
            jobs.push({k: 'lit', s: '}'}, {k: 'obj', fs: x.fields, i: 0, first: true})
            acc.push('{')
            break
        }
        break
      }
      case 'arr': {
        if (h.i >= h.xs.length) break
        jobs.push({k: 'arr', xs: h.xs, i: h.i + 1, first: false}, {k: 'val', v: h.xs[h.i]!})
        if (!h.first) acc.push(',')
        break
      }
      case 'obj': {
        if (h.i >= h.fs.length) break
        const [name, val] = h.fs[h.i]!
        jobs.push({k: 'obj', fs: h.fs, i: h.i + 1, first: false}, {k: 'val', v: val}, {k: 'lit', s: `${escape(name)}:`})
        if (!h.first) acc.push(',')
        break
      }
    }
  }
  return done(acc.join(''))
}

export const write = (v: Json): Result<string> => writeWithFuel(131072, v)

// ---- Reading the AST ----------------------------------------------------------

// Codec.field: the first member named `key` of an object.
export function field(v: Json, key: string): Json | undefined {
  if (v.t !== 'obj') return undefined
  return findField(v.fields, key)
}

export function findField(fields: readonly Member[], key: string): Json | undefined {
  for (const [k, val] of fields) if (k === key) return val
  return undefined
}

export const text = (v: Json): string | undefined => (v.t === 'str' ? v.v : undefined)
export const array = (v: Json): Json[] | undefined => (v.t === 'arr' ? v.items : undefined)

// The AST from a plain JS value (for tests and callers building JSON): every
// number written as JSON.stringify writes it.
export function fromJs(x: unknown): Json {
  if (x === null) return NULL
  if (typeof x === 'boolean') return jbool(x)
  if (typeof x === 'number') return jnum(JSON.stringify(x))
  if (typeof x === 'string') return jstr(x)
  if (Array.isArray(x)) return jarr(x.map(fromJs))
  if (typeof x === 'object') return jobj(Object.entries(x as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, fromJs(v)]))
  throw new TypeError(`no JSON for ${typeof x}`)
}
