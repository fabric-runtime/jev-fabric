// Text as the native modules read it. A Bend String is a list of Unicode
// scalars: lengths, take and drop count code points, not UTF-16 units. A lone
// surrogate in a JS string reads as one code point outside the scalars, as a
// `Chr{55296}` did. Whitespace is ASCII's (space, tab, LF, VT, FF, CR).

export const isScalar = (code: number): boolean => code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)

// Code points of a string, lone surrogates as themselves.
export function codePoints(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!
    out.push(c)
    i += c > 0xffff ? 2 : 1
  }
  return out
}

export function cpLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; n++) i += s.codePointAt(i)! > 0xffff ? 2 : 1
  return n
}

export function cpTake(s: string, n: number): string {
  let i = 0
  for (let k = 0; k < n && i < s.length; k++) i += s.codePointAt(i)! > 0xffff ? 2 : 1
  return s.slice(0, i)
}

export function cpDrop(s: string, n: number): string {
  return s.slice(cpTake(s, n).length)
}

// Bend's String.from_list of code points (lone surrogates kept as units).
export function fromCodePoints(codes: readonly number[]): string {
  let out = ''
  const chunk: number[] = []
  for (const c of codes) {
    if (c >= 0xd800 && c <= 0xdfff) {
      if (chunk.length) out += String.fromCodePoint(...chunk.splice(0))
      out += String.fromCharCode(c)
    } else {
      chunk.push(c)
      if (chunk.length >= 4096) out += String.fromCodePoint(...chunk.splice(0))
    }
  }
  if (chunk.length) out += String.fromCodePoint(...chunk)
  return out
}

// UTF-8 width of a scalar: 1 byte, plus one per threshold it reaches.
export const utf8Width = (code: number): number => 1 + (code >= 128 ? 1 : 0) + (code >= 2048 ? 1 : 0) + (code >= 65536 ? 1 : 0)

const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13)

export function trim(s: string): string {
  let i = 0
  let j = s.length
  while (i < j && isSpace(s.charCodeAt(i))) i++
  while (j > i && isSpace(s.charCodeAt(j - 1))) j--
  return s.slice(i, j)
}

export function trimEnd(s: string): string {
  let j = s.length
  while (j > 0 && isSpace(s.charCodeAt(j - 1))) j--
  return s.slice(0, j)
}

// ASCII lower case only, as Bend's String.to_lower.
export const toLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase())

// Bend's U32.read: one or more ASCII digits whose value fits in 32 bits.
export function readU32(s: string): number | null {
  if (s.length === 0 || !/^[0-9]+$/.test(s)) return null
  const n = Number(s.length > 12 ? 2 ** 33 : s)
  return n <= 0xffffffff ? n : null
}

// Bend's Nat.read: one or more ASCII digits (a Nat has 48 bits natively; the
// callers bound their digit counts first).
export function readNat(s: string): bigint | null {
  if (s.length === 0 || !/^[0-9]+$/.test(s)) return null
  return BigInt(s)
}
