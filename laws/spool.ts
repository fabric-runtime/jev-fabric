// Reads by byte offset (src/spool/core.ts, the spool parts of
// native/tests/policy-proofs.bend): loss below the retained window is
// disclosed exactly, a read with nothing lost omits nothing, a read never
// returns bytes the writer has not published or no longer holds, a rolling
// spool's two slices cover the span once, an ended stream holds nothing
// back, and a long poll answers at its ceiling. Held to SpoolCore.

import {bool, fun, min, nat, when} from 'gdp-wired'
import * as Core from '../src/spool/core.ts'
import type {Agreement, Entry} from './kit.ts'
import {rand} from './kit.ts'

const big = (r: (n: number) => number) => [0, 1, 2, 3, 15, 16, 2048, 65535, 65536, 1048575, 1048576, 1048577, 2097152, r(5000000)][r(14)]!

// SpoolCore.span: `retained` is the oldest byte still held, `count` the bytes
// written so far; a read asks for `max` bytes from `offset`.
const spanFun = (sloppy = false) =>
  fun('read span')
    .inputs({retained: nat, count: nat, offset: nat, max: nat})
    .returns(({retained, count, offset, max}) => {
      const start = sloppy ? offset : when(offset.lt(retained), retained, offset)
      return {start, length: min(max, count.minus(start)), omitted: start.minus(offset)}
    })
const spanLaws = (f: ReturnType<typeof spanFun>) => [
  f.law('a read never starts below the oldest retained byte', () => [], ({start}, {retained}) => start.atLeast(retained)),
  f.law('read_from_start_discloses_loss', ({offset}) => [offset.eq(0)], ({omitted}, {retained}) => omitted.eq(retained)),
  f.law('nothing_lost_nothing_omitted', ({retained}) => [retained.eq(0)], ({omitted}) => omitted.eq(0)),
  f.law('loss is disclosed exactly: the read starts at the offset plus what it omits', () => [], ({start, omitted}, {offset}) => start.eq(offset.plus(omitted))),
  f.law('a read returns at most max bytes', () => [], ({length}, {max}) => length.atMost(max)),
  f.law('a read never passes the bytes written', ({count}, {length}) => [length.gt(0)], ({start, length}, {count}) => start.plus(length).atMost(count)),
]
const spanHeld = () =>
  spanFun().compare(({retained, count, offset, max}) => Core.span(retained, count, offset, max), {
    trials: 6000,
    draw: (r) => ({retained: big(r), count: big(r), offset: big(r), max: [0, 1, 2048, 65536, r(70000)][r(5)]!}),
  })

// SpoolCore.slices: where a span of a rolling spool lies, byte N at 16 + N mod 1 MiB.
const RING = Core.ring
const slicesFun = (sloppy = false) =>
  fun('ring slices')
    .params({ring: nat})
    .pre(({ring}) => ring.eq(RING))
    .inputs({start: nat, length: nat})
    .assume(({length, ring}) => length.atMost(ring))
    .returns(({start, length, ring}) => {
      const at = start.modBy(RING)
      const first = min(length, ring.minus(at))
      return {at: at.plus(16), first, second: sloppy ? length : length.minus(first)}
    })
const slicesLaws = (f: ReturnType<typeof slicesFun>) => [
  f.law('the slices cover the span exactly once', () => [], ({first, second}, {length}) => first.plus(second).eq(length)),
  f.law('the first slice stays inside the ring', () => [], ({at, first}) => at.plus(first).atMost(RING + 16)),
  f.law('the wrapped slice never reaches back to where the first began', () => [], ({at, second}) => second.atMost(at.minus(16))),
]
function slicesHeld(): Agreement {
  const r = rand(41)
  let checked = 0
  for (let t = 0; t < 5000; t++) {
    const start = big(r) + r(3) * RING
    const length = [0, 1, 6, 16, 65536, RING - 1, RING][r(7)]!
    const want = slicesFun().run({start, length}, {ring: RING})
    const got = Core.slices(start, length)
    const second = got[1]?.length ?? 0
    if (got[0]!.at !== want.at || got[0]!.length !== want.first || second !== want.second || (got[1] && got[1].at !== 16))
      return {checked, failure: `slices(${start}, ${length}) = ${JSON.stringify(got)}, the rule says ${JSON.stringify(want)}`}
    checked++
  }
  return {checked}
}

// SpoolCore.overwritten: bytes read from `start` that the writer wrapped over
// while they were read, by the header published after (`after` bytes written).
const lostFun = (sloppy = false) =>
  fun('overwritten while read')
    .inputs({start: nat, length: nat, after: nat})
    .returns(({start, length, after}) => ({lost: sloppy ? min(length, after.minus(RING).minus(start)).minus(1) : min(length, after.minus(RING).minus(start))}))
const lostLaws = (f: ReturnType<typeof lostFun>) => [
  f.law('no more is lost than was read', () => [], ({lost}, {length}) => lost.atMost(length)),
  f.law('what is kept is still in the ring', ({length}, {lost}) => [lost.lt(length)], ({lost}, {start, after}) => start.plus(lost).atLeast(after.minus(RING))),
]
const lostHeld = () =>
  lostFun().compare(({start, length, after}) => ({lost: Core.overwritten(start, length, after)}), {
    trials: 5000,
    draw: (r) => ({start: big(r), length: [0, 1, 2048, 65536][r(4)]!, after: big(r) + r(2) * RING}),
  })

// SpoolCore.kept: a read holds back a trailing partial character (`held`
// bytes, 0 to 3) unless the stream has ended.
const keptFun = (sloppy = false) =>
  fun('kept bytes')
    .inputs({length: nat, held: nat, ended: bool})
    .assume(({held, length}) => held.atMost(3).and(held.atMost(length)))
    .returns(({length, held, ended}) => ({kept: sloppy ? length.minus(held) : when(ended, length, length.minus(held))}))
const keptLaws = (f: ReturnType<typeof keptFun>) => [
  f.law('ended_stream_holds_nothing_back', ({ended}) => [ended], ({kept}, {length}) => kept.eq(length)),
  f.law('a live read holds back at most three bytes', () => [], ({kept}, {length}) => kept.plus(3).atLeast(length).and(kept.atMost(length))),
]
function keptHeld(): Agreement {
  const r = rand(43)
  const pieces = [[0x41], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x99, 0x82], [0xff], [0x80], [0xc3], [0xf0, 0x9f], [0xe2]]
  let checked = 0
  for (let t = 0; t < 5000; t++) {
    const bytes = new Uint8Array(Array.from({length: r(6)}, () => pieces[r(pieces.length)]!).flat())
    const held = Core.held(bytes)
    if (held > 3 || held > bytes.length) return {checked, failure: `held(${[...bytes]}) = ${held}`}
    for (const ended of [false, true]) {
      const want = keptFun().run({length: bytes.length, held, ended}).kept
      const got = Core.kept(bytes, ended)
      if (got.length !== want) return {checked, failure: `kept(${[...bytes]}, ${ended}) has ${got.length} bytes, the rule ${want}`}
      // What a live read keeps never ends inside a character that could still complete.
      if (!ended && got.length < bytes.length && held === 0) return {checked, failure: `kept(${[...bytes]}) held back bytes it should not`}
      checked++
    }
  }
  return {checked}
}

// SpoolCore.answer_now: a long poll answers once bytes can be returned, the stream has ended, or its ceiling has passed.
const answerFun = (sloppy = false) =>
  fun('long poll answer')
    .inputs({expired: bool, returned: bool, eof: bool})
    .returns(({expired, returned, eof}) => ({answer: sloppy ? returned.or(eof) : expired.or(returned).or(eof)}))
const answerLaws = (f: ReturnType<typeof answerFun>) => [f.law('long_poll_answers_at_its_ceiling', ({expired}) => [expired], ({answer}) => answer)]
const answerHeld = () => answerFun().compare(({expired, returned, eof}) => ({answer: Core.answerNow(expired, returned, eof)}))

export const entries: Entry[] = [
  {
    area: 'spool',
    decisions: spanLaws(spanFun()),
    broken: [{what: 'a read from below the oldest retained byte', decision: spanLaws(spanFun(true))[0]!}],
    held: [{against: 'SpoolCore.span (fun.compare)', run: spanHeld}],
  },
  {
    area: 'spool',
    decisions: slicesLaws(slicesFun()),
    broken: [{what: 'a wrapped read that does not split at the ring end', decision: slicesLaws(slicesFun(true))[0]!}],
    held: [{against: 'SpoolCore.slices, every lap of the ring', run: slicesHeld}],
  },
  {
    area: 'spool',
    decisions: lostLaws(lostFun()),
    broken: [{what: 'one overwritten byte passed off as read', decision: lostLaws(lostFun(true))[1]!}],
    held: [{against: 'SpoolCore.overwritten (fun.compare)', run: lostHeld}],
  },
  {
    area: 'spool',
    decisions: keptLaws(keptFun()),
    broken: [{what: 'an ended stream that still holds back a partial character', decision: keptLaws(keptFun(true))[0]!}],
    held: [{against: 'SpoolCore.kept and held on UTF-8 and malformed bytes', run: keptHeld}],
  },
  {
    area: 'spool',
    decisions: answerLaws(answerFun()),
    broken: [{what: 'a long poll that outlives its ceiling', decision: answerLaws(answerFun(true))[0]!}],
    held: [{against: 'SpoolCore.answerNow on every combination', run: answerHeld, exhaustive: true}],
  },
]
