// Incremental, replacement-decoding UTF-8 (native/Streams.bend). A decoder
// keeps at most one partial scalar across bounded spool reads; output chunks
// are observations, not protocol lines.
//
// Not WHATWG's decoder: an invalid or truncated sequence becomes ONE U+FFFD
// however many bytes it had (a UTF-16 surrogate encoded in three bytes is one
// replacement, an overlong form is one), and a byte that breaks a sequence
// is decoded again as a start. Job events and `read` records use this one;
// process receipts decode with io_str's (TextDecoder's) rules instead.

export const REPLACEMENT = 0xfffd

/** Any code point except UTF-16 surrogates. */
export const scalar = (code: number) => code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)

export type Decoder = {need: number; code: number; minimum: number; text: string}

export const empty = (): Decoder => ({need: 0, code: 0, minimum: 0, text: ''})

const char = (code: number) => String.fromCodePoint(code)

// A lead below 224 starts a 2-byte sequence, below 240 a 3-byte one, else 4 bytes;
// each keeps its payload bits and the smallest scalar its length may encode.
function begin(d: Decoder, b: number) {
  if (b < 128) {
    d.text += char(b)
  } else if (b >= 194 && b <= 244) {
    if (b < 224) [d.need, d.code, d.minimum] = [1, b % 32, 128]
    else if (b < 240) [d.need, d.code, d.minimum] = [2, b % 16, 2048]
    else [d.need, d.code, d.minimum] = [3, b % 8, 65536]
  } else {
    d.text += char(REPLACEMENT)
  }
}

/** Streams.step, in place. */
export function step(d: Decoder, b: number): Decoder {
  if (d.need === 0) {
    begin(d, b)
  } else if (b < 128 || b > 191) {
    d.need = 0
    d.code = 0
    d.minimum = 0
    d.text += char(REPLACEMENT)
    begin(d, b)
  } else {
    d.code = d.code * 64 + (b - 128)
    d.need -= 1
    if (d.need === 0) {
      d.text += char(d.code >= d.minimum && scalar(d.code) ? d.code : REPLACEMENT)
      d.code = 0
      d.minimum = 0
    }
  }
  return d
}

/** Streams.feed: every byte, in order. */
export function feed(bytes: ArrayLike<number>, d: Decoder): Decoder {
  for (let i = 0; i < bytes.length; i++) step(d, bytes[i]!)
  return d
}

/** Streams.take: the decoded text so far, and the decoder holding only its partial scalar. */
export function take(d: Decoder): [Decoder, string] {
  return [{need: d.need, code: d.code, minimum: d.minimum, text: ''}, d.text]
}

/** Streams.finish: the text, with one U+FFFD for a scalar left incomplete. */
export const finish = (d: Decoder): string => (d.need === 0 ? d.text : d.text + char(REPLACEMENT))

/** Decodes a whole byte string at once. */
export const text = (bytes: ArrayLike<number>): string => finish(feed(bytes, empty()))
