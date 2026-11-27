// The watch monitor (src/monitor/core.ts; native/tests/policy-proofs.bend's
// monitor laws, native/tests/monitor-pure.bend, and what MonitorCore.bend
// claims): a finished job, the output limit and the deadline each stop the
// watch and nothing else does; a stream never emits past 1024 lines nor holds
// a batch of 32; a disabled or unmatched filter emits nothing; a consecutive
// duplicate, a blank line or one without the literal is never emitted; a
// partial line never passes 4096 characters and a clipped one never grows;
// the cursor never goes back, replays change nothing, and every loss counted
// (eviction, omitted bytes, spool limit, an invalid event) is disclosed by
// exactly one monitor.loss record. Each held to the real code.

import {bool, fun, min, nat, oneOf, rule, when} from 'gdp-wired'
import {quote} from '../src/codec/print.ts'
import * as JevCore from '../src/jev/core.ts'
import * as M from '../src/monitor/core.ts'
import type {Agreement, Entry} from './kit.ts'
import {mapsHold, rand} from './kit.ts'

// ---------------------------------------------------------------------------
// The stop decision (M.decide): `finished` is job.finished seen, `receipt` a
// receipt read; `lines` the lines emitted on both streams.

const stopFun = (sloppy = false) =>
  fun('watch stop')
    .inputs({finished: bool, receipt: bool, lines: nat, elapsed: nat, duration: nat})
    .returns(({finished, receipt, lines, elapsed, duration}) => {
      const done = finished.or(receipt)
      const over = done.not().and(lines.atLeast(M.TOTAL_MAX))
      const expired = done.not().and(over.not()).and(sloppy ? elapsed.gt(duration) : elapsed.atLeast(duration))
      return {finish: done, limit: over, deadline: expired, terminal: done, poll: done.not().and(over.not()).and(expired.not())}
    })
const stopLaws = (f: ReturnType<typeof stopFun>) => [
  f.law('terminal_monitor_never_polls: a finished job stops the watch as terminal', ({finished, receipt}) => [finished.or(receipt)], ({finish, terminal, poll}) =>
    finish.and(terminal).and(poll.not()),
  ),
  f.law('limited_monitor_never_polls: 1024 lines stop a running watch, not terminal', ({finished, receipt, lines}) => [finished.or(receipt).not(), lines.atLeast(M.TOTAL_MAX)], ({limit, terminal, poll}) =>
    limit.and(terminal.not()).and(poll.not()),
  ),
  f.law('expired_monitor_never_polls: at its deadline a watch stops', ({elapsed, duration}) => [elapsed.atLeast(duration)], ({poll}) => poll.not()),
  f.law('a watch polls only while running, under its limit and before its deadline', () => [], ({poll}, {finished, receipt, lines, elapsed, duration}) =>
    poll.implies(finished.or(receipt).not().and(lines.lt(M.TOTAL_MAX)).and(elapsed.lt(duration))),
  ),
  f.law('one stop reason at a time', () => [], ({finish, limit, deadline, poll}) =>
    finish.and(limit).not().and(finish.and(deadline).not()).and(limit.and(deadline).not()).and(poll.implies(finish.or(limit).or(deadline).not())),
  ),
]
const stopHeld = () =>
  stopFun().compare(
    ({finished, receipt, lines, elapsed, duration}) => {
      const s: M.Summary = {model: M.initialModel(), finished, lines, batches: 0}
      const d = M.decide(s, receipt ? '{"state":"exited"}' : '', elapsed, duration)
      const reason = d.d === 'stop' ? d.reason : ''
      return {finish: reason === 'finished', limit: reason === 'output-limit', deadline: reason === 'deadline', terminal: d.d === 'stop' && d.terminal, poll: d.d === 'poll'}
    },
    {
      trials: 6000,
      draw: (r) => {
        const duration = [1, 25, 5000, 300000, r(400000)][r(5)]!
        return {
          finished: r(3) === 0,
          receipt: r(3) === 0,
          lines: [0, 1, 1023, 1024, 1025, 2048, r(3000)][r(7)]!,
          elapsed: [0, duration - 1, duration, duration + 1, r(400000)][r(5)]!,
          duration,
        }
      },
    },
  )

// ---------------------------------------------------------------------------
// One stream's channel (M.push and a non-terminal M.flush): a complete line
// that the filter matches (`hit`, possibly clipped), or a flush. Batches are
// BATCH_MAX lines, as the driver always asks.

const channelRule = (sloppy = false) =>
  rule('watch channel')
    .inputs({op: oneOf('line', 'flush'), hit: bool, clipped: bool})
    .state({emitted: 0, pending: 0, clips: 0, batches: 0})
    .flags(({op, hit, emitted, pending}) => {
      const take = op.is('line').and(hit).and(sloppy ? emitted.atLeast(0) : emitted.lt(M.TOTAL_MAX))
      return {take, full: take.and(pending.plus(1).atLeast(M.BATCH_MAX)), flushing: op.is('flush').and(pending.gt(0))}
    })
    .step(({emitted, pending, clips, batches, take, full, flushing, clipped}) => ({
      emitted: when(take, emitted.plus(1), emitted),
      pending: when(full.or(flushing), 0, when(take, pending.plus(1), pending)),
      clips: when(full.or(flushing), 0, when(take.and(clipped), clips.plus(1), clips)),
      batches: when(full.or(flushing), batches.plus(1), batches),
    }))
const channelLaws = (r: ReturnType<typeof channelRule>) => ({
  laws: [
    r.law('at most 1024 lines a stream are emitted', ({emitted}) => emitted.atMost(M.TOTAL_MAX)),
    r.law('a pending batch holds fewer than 32 lines', ({pending}) => pending.lt(M.BATCH_MAX)),
    r.law('pending lines were emitted; clipped ones are among them', ({pending, clips, emitted}) => clips.atMost(pending).and(pending.atMost(emitted))),
    r.law('every batch and pending line came from lines emitted', ({batches, pending, emitted}) => batches.plus(pending).atMost(emitted)),
  ],
  steps: [
    r.stepLaw(
      'full_channel_cannot_emit: a stream at 1024 lines emits nothing more',
      ({emitted, pending, batches}, after) => after.emitted.eq(emitted).and(after.pending.eq(pending)).and(after.batches.eq(batches)),
      ({op, emitted}) => op.is('line').and(emitted.atLeast(M.TOTAL_MAX)),
    ),
    r.stepLaw(
      'disabled_filter_emits_nothing: an unmatched line changes nothing',
      ({emitted, pending, clips, batches}, after) => after.emitted.eq(emitted).and(after.pending.eq(pending)).and(after.clips.eq(clips)).and(after.batches.eq(batches)),
      ({op, hit}) => op.is('line').and(hit.not()),
    ),
    r.stepLaw('a flush empties the pending batch', (_, after) => after.pending.eq(0).and(after.clips.eq(0)), ({op}) => op.is('flush')),
    r.stepLaw('a batch is emitted only full, or by a flush with lines pending', ({batches, pending}, after) => after.batches.gt(batches).implies(after.pending.eq(0)).and(after.batches.atMost(batches.plus(1)))),
  ],
})
const channel = channelRule()

// The real channel beside the rule: random lines (some clipped) through the
// real filter, with flushes, long enough to reach the 1024-line cap.
function channelHeld(): Agreement {
  const r = rand(71)
  const words = ['', ' ', 'm', 'mm', 'x', ' m ', 'm 1', 'm 2', 'abc', '\tm']
  return mapsHold(channel, 40, 0, (s) => {
    s.init({})
    let c = M.emptyChannel()
    for (let i = 0; i < 1400; i++) {
      const op = r(40) === 0 ? 'flush' : 'line'
      const text = r(3) === 0 ? words[r(words.length)]! : `m ${r(1 << 20)}`
      const clipped = r(5) === 0
      const hit = JevCore.monitor(text, 'm', c.previous) !== null
      const p = op === 'flush' ? M.flush('stdout', c) : M.push('stdout', c, {text, clipped}, i + 1, 'm', M.BATCH_MAX)
      const batches = p.outs.filter((o) => o.startsWith('{"type":"monitor.batch"')).length
      if (p.outs.length !== batches) return `push printed something other than batches: ${p.outs.join(' ')}`
      if (batches && JSON.parse(p.outs[0]!).lines.length > M.BATCH_MAX) return 'a batch of more than 32 lines'
      c = p.channel
      const failure = s.step({op, hit, clipped}, {emitted: c.emitted, pending: c.pending.lines.length, clips: c.pending.clipped, batches: c.batches}, {})
      if (failure) return failure
    }
    return undefined
  })
}

// ---------------------------------------------------------------------------
// The line filter (JevCore.monitor, through M.limitedMatch).

const filterFun = (sloppy = false) =>
  fun('watch filter')
    .inputs({allowed: bool, blank: bool, contains: bool, same: bool})
    .returns(({allowed, blank, contains, same}) => ({emit: allowed.and(blank.not()).and(contains).and(sloppy ? same.or(same.not()) : same.not())}))
const filterLaws = (f: ReturnType<typeof filterFun>) => [
  f.law('a consecutive duplicate is never emitted twice', ({same}) => [same], ({emit}) => emit.not()),
  f.law('a blank line, or one without the literal, is never emitted', ({blank, contains}) => [blank.or(contains.not())], ({emit}) => emit.not()),
  f.law('disabled_filter_emits_nothing', ({allowed}) => [allowed.not()], ({emit}) => emit.not()),
]
function filterHeld(): Agreement {
  const r = rand(73)
  const pieces = ['', ' ', '\t', 'ab', 'a', 'b', 'é', '🙂', 'x\n', '\u000b']
  let checked = 0
  for (let t = 0; t < 8000; t++) {
    const text = Array.from({length: r(4)}, () => pieces[r(pieces.length)]).join('')
    const literal = ['a', 'ab', 'é', '🙂', ' '][r(5)]!
    const trimmed = text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '')
    const previous = r(2) === 0 ? trimmed : pieces[r(pieces.length)]!
    const allowed = r(5) !== 0
    const want = filterFun().run({allowed, blank: trimmed === '', contains: trimmed.includes(literal), same: trimmed === previous})
    const got = M.limitedMatch(text, literal, previous, allowed)
    if ((got !== null) !== want.emit || (got !== null && got !== trimmed)) return {checked, failure: `limitedMatch(${JSON.stringify(text)}, ${JSON.stringify(literal)}, ${JSON.stringify(previous)})`}
    checked++
  }
  return {checked}
}

// ---------------------------------------------------------------------------
// Framing (M.bounded through M.frameChunk): a piece of `add` characters,
// which completes the line (`ends`) or stays partial.

const frameRule = (sloppy = false) =>
  rule('watch frame')
    .inputs({add: nat, ends: bool})
    .state({len: 0, clipped: bool.from(false), line: 0})
    .flags(({len, clipped, add}) => ({clips: clipped.or(len.plus(add).gt(M.LINE_MAX))}))
    .step(({len, clipped, add, ends, clips, line}) => {
      const grown = when(clipped, len, min(len.plus(add), sloppy ? M.LINE_MAX + 1 : M.LINE_MAX))
      return {len: when(ends, 0, grown), clipped: clips.and(ends.not()), line: when(ends, grown, line)}
    })
const frameLaws = (r: ReturnType<typeof frameRule>) => ({
  laws: [r.law('a partial line never passes 4096 characters', ({len}) => len.atMost(M.LINE_MAX)), r.law('nor does a completed one', ({line}) => line.atMost(M.LINE_MAX))],
  steps: [
    r.stepLaw('a clipped partial line ignores further input', ({len}, after) => after.len.eq(len).and(after.clipped), ({clipped, ends}) => clipped.and(ends.not())),
    r.stepLaw('a completed line starts the next one empty', (_, after) => after.len.eq(0).and(after.clipped.not()), ({ends}) => ends),
  ],
})
const frame = frameRule()

// The real framing: random chunks (some with newlines, some long), the
// frame's length and clip flag and every completed line's length.
function frameHeld(): Agreement {
  const r = rand(79)
  const chars = ['a', 'é', '🙂', ' ']
  return mapsHold(frame, 300, 0, (s) => {
    s.init({})
    let f = M.emptyFrame()
    let line = 0
    for (let i = 0; i < 30; i++) {
      const n = [0, 1, 7, 1000, 4095, 4096, 4097, r(9000)][r(8)]!
      const piece = chars[r(chars.length)]!.repeat(n)
      const ends = r(3) === 0
      const framed = M.frameChunk(f, ends ? `${piece}\n` : piece, false, M.LINE_MAX)
      if (framed.lines.length !== (ends ? 1 : 0)) return `frameChunk completed ${framed.lines.length} lines`
      const last = framed.lines[0]
      f = framed.frame
      const cp = (t: string) => [...t].length
      if (last) line = cp(last.text)
      const failure = s.step({add: n, ends}, {len: cp(f.partial), clipped: f.clipped ? 1 : 0, line}, {})
      if (failure) return failure
    }
    return undefined
  })
}

// ---------------------------------------------------------------------------
// The cursor and loss accounting (M.consumeLine): one event line, with its
// sequence and kind. `notices` counts monitor.loss records.

const KINDS = ['output', 'lossy-output', 'spool', 'finished', 'other', 'invalid'] as const
const cursorRule = (sloppy = false) =>
  rule('watch cursor')
    .inputs({seq: nat, kind: oneOf(...KINDS)})
    .state({last: 0, losses: 0, notices: 0, finished: bool.from(false)})
    .flags(({seq, last, kind}) => {
      const fresh = kind.is('invalid').not().and(seq.gt(last))
      const gap = fresh.and(seq.gt(last.plus(1)))
      const lossy = fresh.and(kind.is('lossy-output').or(kind.is('spool')))
      return {fresh, gap, lossy}
    })
    .step(({seq, last, losses, notices, finished, kind, fresh, gap, lossy}) => {
      const counted = when(kind.is('invalid'), 1, when(gap, 1, 0).plus(when(lossy, 1, 0)))
      return {
        last: when(fresh, seq, last),
        losses: losses.plus(counted),
        notices: notices.plus(sloppy ? when(gap, 0, counted) : counted),
        finished: finished.or(fresh.and(kind.is('finished'))),
      }
    })
const cursorLaws = (r: ReturnType<typeof cursorRule>) => ({
  laws: [r.law('every counted loss is disclosed by exactly one monitor.loss record', ({losses, notices}) => losses.eq(notices))],
  steps: [
    r.stepLaw('the cursor never goes back', ({last}, after) => after.last.atLeast(last)),
    r.stepLaw(
      'a replay at or before the cursor changes nothing',
      ({last, losses, finished}, after) => after.last.eq(last).and(after.losses.eq(losses)).and(after.finished.implies(finished)).and(finished.implies(after.finished)),
      ({seq, last, kind}) => kind.is('invalid').not().and(seq.atMost(last)),
    ),
    r.stepLaw('a sequence gap counts one loss before the event past it', ({losses}, after) => after.losses.atLeast(losses.plus(1)), ({seq, last, kind}) =>
      kind.is('invalid').not().and(seq.gt(last.plus(1))),
    ),
  ],
})
const cursor = cursorRule()

const eventLine = (seq: number, kind: (typeof KINDS)[number]): string => {
  const output = (text: string, omitted: number) =>
    `{"sequence":${seq},"type":"process.output","data":{"stream":"stdout","offset":0,"bytes":0,"omittedBytes":${omitted},"text":${quote(text)}}}`
  if (kind === 'output') return output('m line\nm ', 0)
  if (kind === 'lossy-output') return output('m\n', 1 + (seq % 9))
  if (kind === 'spool') return `{"sequence":${seq},"type":"process.spool_limit","data":{"stream":"stderr"}}`
  if (kind === 'finished') return `{"sequence":${seq},"type":"job.finished","data":{"receiptAvailable":true}}`
  if (kind === 'other') return `{"sequence":${seq},"type":"job.started","data":{}}`
  return `{"sequence":${seq},`
}

// Random event streams (replays, gaps, invalid lines) through the real
// consumer; notices are the monitor.loss records it printed.
function cursorHeld(): Agreement {
  const r = rand(83)
  return mapsHold(cursor, 300, 0, (s) => {
    s.init({})
    let m = M.initialModel()
    let notices = 0
    for (let i = 0; i < 40; i++) {
      const kind = KINDS[r(KINDS.length)]!
      const seq = Math.max(0, m.last + [-2, -1, 0, 1, 1, 1, 2, 5][r(8)]!)
      const step = M.consumeLine(eventLine(seq, kind), m, 'm', M.BATCH_MAX)
      m = step.model
      notices += step.outs.filter((o) => o.startsWith('{"type":"monitor.loss"')).length
      const failure = s.step({seq, kind}, {last: m.last, losses: m.losses, notices, finished: m.finished ? 1 : 0}, {})
      if (failure) return failure
    }
    return undefined
  })
}

export const entries: Entry[] = [
  {
    area: 'monitor',
    decisions: stopLaws(stopFun()),
    broken: [{what: 'a watch that polls at its deadline', decision: stopLaws(stopFun(true))[2]!}],
    held: [{against: 'MonitorCore.decide (fun.compare)', run: stopHeld}],
  },
  {
    area: 'monitor',
    rule: channel,
    ...channelLaws(channel),
    from: 'any',
    broken: [{what: 'a stream without its 1024-line cap', rule: channelRule(true), ...channelLaws(channelRule(true))}],
    held: [{against: 'MonitorCore.push and flush (1400-line runs through the real filter)', run: channelHeld}],
  },
  {
    area: 'monitor',
    decisions: filterLaws(filterFun()),
    broken: [{what: 'a filter that repeats a consecutive duplicate', decision: filterLaws(filterFun(true))[0]!}],
    held: [{against: 'MonitorCore.limited_match / Core.monitor on random text', run: filterHeld}],
  },
  {
    area: 'monitor',
    rule: frame,
    ...frameLaws(frame),
    from: 'any',
    broken: [{what: 'framing that clips one character late', rule: frameRule(true), ...frameLaws(frameRule(true))}],
    held: [{against: 'MonitorCore.frame_chunk on random chunks', run: frameHeld}],
  },
  {
    area: 'monitor',
    rule: cursor,
    ...cursorLaws(cursor),
    from: 'any',
    broken: [{what: 'an eviction counted without its monitor.loss record', rule: cursorRule(true), ...cursorLaws(cursorRule(true))}],
    held: [{against: 'MonitorCore.consume_line on random event streams', run: cursorHeld}],
  },
]
