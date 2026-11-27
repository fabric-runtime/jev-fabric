// native/tests/monitor-pure.bend, plus the record shapes and stop decisions.

import {describe, expect, test} from 'bun:test'
import {quote} from '../codec/print.ts'
import * as M from './core.ts'

const event = (seq: number, stream: string, text: string, omitted = 0) =>
  `{"sequence":${seq},"type":"process.output","data":{"stream":${quote(stream)},"offset":0,"bytes":0,"omittedBytes":${omitted},"text":${quote(text)}}}`

const watch = (raw: string[], literal: string, batch: number) => M.consume(raw, M.initialModel(), literal, batch)
const lines = (s: M.Step) => M.summarize(s.model).lines
const batches = (s: M.Step) => M.summarize(s.model).batches

describe('monitor pure (monitor-pure.bend)', () => {
  test('split: a line split across chunks is reassembled', () => {
    const a = M.frameChunk({partial: '', clipped: false}, 'hel', false, 100)
    const b = M.frameChunk(a.frame, 'lo\nworld\n', false, 100)
    expect(a.lines.length).toBe(0)
    expect(b.lines.length).toBe(2)
    expect(b.lines[0]!.text).toBe('hello')
  })
  test('clip: a line is clipped at the maximum and says so', () => {
    const c = M.frameChunk({partial: '', clipped: false}, 'abcdef\n', false, 4)
    expect(c.lines[0]).toEqual({text: 'abcd', clipped: true})
  })
  test('close: an unterminated partial line closes', () => {
    expect(M.closeFrame({partial: 'tail', clipped: false})).not.toBeNull()
    expect(M.closeFrame({partial: '', clipped: false})).toBeNull()
  })
  test('dedup: a consecutive duplicate is emitted once', () => expect(lines(watch([event(1, 'stdout', 'X\nX\n')], 'X', 32))).toBe(1))
  test('split events: one line across two events', () => expect(lines(watch([event(1, 'stdout', 'he'), event(2, 'stdout', 'llo\n')], 'he', 32))).toBe(1))
  test('filter: only lines containing the literal', () => expect(lines(watch([event(1, 'stdout', 'alpha\nbeta\n')], 'beta', 32))).toBe(1))
  test('gap: a sequence gap is a replay-eviction loss', () => {
    const g = watch([event(5, 'stdout', 'x\n')], 'x', 32)
    expect(g.outs[0]).toBe('{"type":"monitor.loss","stream":"*","reason":"replay-eviction","count":4}')
    expect(g.model.losses).toBe(1)
  })
  test('omitted: omitted bytes are a loss', () => {
    const h = watch([event(1, 'stdout', '', 7)], 'x', 32)
    expect(h.outs).toEqual(['{"type":"monitor.loss","stream":"stdout","reason":"omitted-bytes","count":7}'])
  })
  test('drain: a terminal drain flushes the batch, without the end record', () => {
    const i = watch([event(1, 'stdout', 'only\n')], 'only', 32)
    const j = M.drain(i.model, 'only', true)
    expect(j.outs.some((o) => o.includes('monitor.batch'))).toBe(true)
    expect(j.outs.some((o) => o.includes('monitor.end'))).toBe(false)
  })
  test('batch: a full batch flushes at its size', () => {
    const d = watch([event(1, 'stdout', 'a\nb\nc\n')], '', 2)
    expect([batches(d), lines(d)]).toEqual([1, 3])
  })
  test('hard cap: a channel that emitted 1024 lines emits nothing more', () => {
    const full: M.Channel = {...M.emptyChannel(), emitted: 1024, batches: 32}
    const r = M.push('stdout', full, {text: 'MATCH', clipped: false}, 1, 'MATCH', 32)
    expect(r.channel.emitted).toBe(1024)
    expect(r.outs).toEqual([])
  })
})

describe('monitor records and decisions', () => {
  test('a batch lists its lines oldest first with its sequence span', () => {
    const s = watch([event(1, 'stdout', 'a 1\n'), event(2, 'stdout', 'a 2\n')], 'a', 32)
    const d = M.drain(s.model, 'a', true)
    expect(d.outs).toEqual([
      '{"type":"monitor.batch","stream":"stdout","first":1,"last":2,"omitted":0,"clipped":0,"lines":[{"text":"a 1","clipped":false},{"text":"a 2","clipped":false}]}',
    ])
  })
  test('replays at or before the cursor change nothing', () => {
    const s = watch([event(1, 'stdout', 'a\n')], 'a', 32)
    const again = M.consume([event(1, 'stdout', 'b a\n')], s.model, 'a', 32)
    expect(again).toEqual({model: s.model, outs: []})
  })
  test('an invalid event line is a loss; blank lines are skipped', () => {
    const s = watch(['', 'not json', ''], 'a', 32)
    expect(s.outs).toEqual(['{"type":"monitor.loss","stream":"*","reason":"invalid-event","count":0}'])
    expect(s.model.losses).toBe(1)
  })
  test('a spool limit is a loss naming its stream; job.finished marks the model', () => {
    const s = watch(['{"sequence":1,"type":"process.spool_limit","data":{"stream":"stderr"}}', '{"sequence":2,"type":"job.finished","data":{}}'], 'a', 32)
    expect(s.outs).toEqual(['{"type":"monitor.loss","stream":"stderr","reason":"spool-limit","count":0}'])
    expect(s.model.finished).toBe(true)
  })
  test('a non-terminal drain drops the partial line', () => {
    const s = watch([event(1, 'stdout', 'a partial')], 'a', 32)
    expect(M.drain(s.model, 'a', false).outs).toEqual([])
    expect(M.drain(s.model, 'a', true).outs.length).toBe(1)
  })
  test('the end record', () => {
    expect(M.endJson('deadline', false, 1024, 32, 2, 7)).toBe(
      '{"type":"monitor.end","reason":"deadline","terminal":false,"lines":1024,"batches":32,"losses":2,"elapsedMs":7,"outputLimitReached":true,"note":"matched lines are observations, not semantic completion"}',
    )
  })
  test('validate: 1..300000 ms and a 1..256 character literal', () => {
    expect(M.validate('100', 'x')).toBe(100)
    expect(M.validate('0', 'x')).toBeNull()
    expect(M.validate('300001', 'x')).toBeNull()
    expect(M.validate('100', '')).toBeNull()
    expect(M.validate('100', '🙂'.repeat(256))).toBe(100)
    expect(M.validate('100', 'x'.repeat(257))).toBeNull()
  })
  test('stop decisions: finished, then output limit, then deadline', () => {
    const s = (finished: boolean, lines: number): M.Summary => ({model: M.initialModel(), finished, lines, batches: 0})
    expect(M.decide(s(true, 2000), '', 9, 1)).toEqual({d: 'stop', reason: 'finished', terminal: true})
    expect(M.decide(s(false, 0), '{"state":"exited"}', 0, 100)).toEqual({d: 'stop', reason: 'finished', terminal: true})
    expect(M.decide(s(false, 1024), '', 9, 1)).toEqual({d: 'stop', reason: 'output-limit', terminal: false})
    expect(M.decide(s(false, 0), '', 100, 100)).toEqual({d: 'stop', reason: 'deadline', terminal: false})
    expect(M.decide(s(false, 0), '', 99, 100)).toEqual(M.POLL)
  })
})
