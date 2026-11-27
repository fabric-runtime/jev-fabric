// Pure policy for reading raw output by byte offset (native/SpoolCore.bend).
// src/spool/spool.ts performs the file reads and sleeps.
//
// A batch spool keeps the first 1 MiB of a stream as plain bytes. A rolling
// spool (session children and interactive jobs) is a 16-byte header, the
// bytes written so far as a little-endian u64 and a u64 of flags (bit 0: the
// stream has ended), followed by a ring holding the latest 1 MiB: byte N lives
// at 16 + N mod 1 MiB. The writer stores bytes before it publishes the count
// that covers them.

import {quote} from '../codec/print.ts'
import * as Streams from '../jobs/streams.ts'

/** Bytes a rolling spool retains, and a batch spool's first-byte cap. */
export const ring = 1048576
export const headSize = 16
/** The most bytes one read returns. */
export const readMax = 65536

/** Natural subtraction: never below zero. */
export const minus = (a: number, b: number) => (a > b ? a - b : 0)

// ---------------------------------------------------------------------------
// Header.

export type Head = {count: number; closed: boolean}

/** A header not yet written (a spool shorter than 16 bytes) reads as nothing written. */
export function head(bytes: Uint8Array): Head {
  if (bytes.length < 16) return {count: 0, closed: false}
  let count = 0
  for (let i = 7; i >= 0; i--) count = count * 256 + bytes[i]!
  return {count, closed: (bytes[8]! & 1) !== 0}
}

// ---------------------------------------------------------------------------
// Which bytes a read returns.

/** The larger of the requested offset and the oldest retained byte. */
export const from = (offset: number, oldest: number) => Math.max(offset, oldest)

/** The oldest byte a rolling spool still holds once `count` bytes were written. */
export const oldest = (count: number) => minus(count, ring)

export type Span = {start: number; length: number; omitted: number}

/**
 * A read starts at the requested offset, or at the oldest retained byte when
 * the offset lies below it, and discloses the difference as omitted. It
 * returns at most `max` bytes and none past `count`, the bytes written so far.
 */
export function span(retained: number, count: number, offset: number, max: number): Span {
  const start = from(offset, retained)
  return {start, length: Math.min(max, minus(count, start)), omitted: minus(start, offset)}
}

export type Slice = {at: number; length: number}

/** Where a span's bytes lie in a rolling spool: one read, or two when they wrap. */
export function slices(start: number, length: number): Slice[] {
  const at = start % ring
  const first = Math.min(length, minus(ring, at))
  const second = minus(length, first)
  return second === 0 ? [{at: at + 16, length: first}] : [{at: at + 16, length: first}, {at: headSize, length: second}]
}

/** Bytes the writer may have overwritten while they were read: those below the oldest the header published after. */
export const overwritten = (start: number, length: number, after: number) => Math.min(length, minus(oldest(after), start))

// ---------------------------------------------------------------------------
// UTF-8: a partial character at the end of a read is held for the next one.

const continuation = (b: number) => b >= 128 && b < 192

/** The sequence length a lead byte announces, or 0 for a byte that leads nothing. */
const announced = (b: number) => (b < 192 ? 0 : b < 224 ? 2 : b < 240 ? 3 : b < 248 ? 4 : 0)

/** How many trailing bytes form an incomplete character: 0 to 3. */
export function held(bytes: Uint8Array): number {
  let continued = 0
  for (let i = bytes.length - 1, fuel = 4; fuel > 0 && i >= 0; i--, fuel--) {
    const b = bytes[i]!
    if (!continuation(b)) {
      const needed = announced(b)
      return needed > continued + 1 ? continued + 1 : 0
    }
    continued++
  }
  return 0
}

/** The bytes a read returns: all of them once the stream has ended, otherwise without a trailing partial character. */
export const kept = (bytes: Uint8Array, ended: boolean): Uint8Array => (ended ? bytes : bytes.subarray(0, minus(bytes.length, held(bytes))))

// ---------------------------------------------------------------------------
// Encodings.

/** `"text":…` decoded (malformed bytes become U+FFFD), or `"data":…` in base64. */
export const payload = (bytes: Uint8Array, encoded: boolean) =>
  encoded ? `"data":${quote(Buffer.from(bytes).toString('base64'))}` : `"text":${quote(Streams.text(bytes))}`

// ---------------------------------------------------------------------------
// The read record.

export type Read = {id: string; stream: string; start: number; omitted: number; bytes: Uint8Array; eof: boolean; state: string}

export const record = (r: Read, encoded: boolean) =>
  `{"id":${quote(r.id)},"stream":${quote(r.stream)},"offset":${r.start},"bytes":${r.bytes.length},"omittedBytes":${r.omitted},${payload(r.bytes, encoded)},"next":${r.start + r.bytes.length},"eof":${r.eof ? 'true' : 'false'},"state":${quote(r.state)}}`

/** A stream has ended when its writer has finished and nothing past `next` remains. */
export const ended = (finished: boolean, next: number, count: number) => finished && next >= count

/** A long poll answers once bytes past the offset can be returned, the stream has ended, or its ceiling has passed. */
export const answerNow = (expired: boolean, returned: boolean, eof: boolean) => expired || returned || eof

/** Poll quickly at first, when a reply is likely close, then back off. */
export const interval = (elapsed: number) => (elapsed < 100 ? 1 : elapsed < 1000 ? 5 : 20)
