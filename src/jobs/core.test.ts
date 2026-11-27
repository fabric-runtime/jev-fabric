// The pure job, spool, stream and store policy (native/tests/jobs-streams.bend,
// policy-checks.bend's job/spool/store parts, and JobsCore/SpoolCore/StoreCore).

import {describe, expect, test} from 'bun:test'
import * as Spool from '../spool/core.ts'
import * as Store from '../store/core.ts'
import * as Core from './core.ts'
import * as S from './streams.ts'

const decode = (bytes: number[]) => S.text(bytes)

test('jobs incremental UTF-8 assertions: 8', () => {
  expect(decode([65, 0, 66])).toBe('A\u0000B')
  expect(decode([240, 159, 153, 130])).toBe('🙂')
  // U+1F642 split across two reads: the first holds back its incomplete prefix.
  const [d, text] = S.take(S.feed([65, 240, 159], S.empty()))
  expect(text + S.finish(S.feed([153, 130, 66], d))).toBe('A🙂B')
  expect(decode([240, 159])).toBe('�')
  expect(decode([255, 65])).toBe('�A')
  expect(decode([237, 160, 128])).toBe('�')
  expect(decode([244, 144, 128, 128])).toBe('�')
  expect(decode([226, 65])).toBe('�A')
  // An overlong 3-byte form is one replacement; C0 leads nothing, nor does a lone continuation.
  expect(decode([224, 128, 128, 0xc0, 0x80])).toBe('���')
})

test('metadata, public ids and receipts', () => {
  const m = Core.meta('dev "server"', '1700000000000', 'session', true)
  expect(m).toBe('{"schemaVersion":1,"startedAt":1700000000000,"label":"dev \\"server\\"","lifetime":"session","input":"pipe"}')
  expect([Core.metaLabel(m), Core.metaLifetime(m), Core.metaInteractive(m), Core.publicId('ab', m)]).toEqual(['dev "server"', 'session', true, 's-ab'])
  expect(Core.metaLifetime('')).toBe('durable')
  expect(Core.withId('ab', '', '{"x":1}')).toBe('{"id":"ab","lifetime":"durable","spoolLimitBytes":1048576,"x":1}')
  expect(Core.withId('ab', '', '')).toBe('{}')
  expect(Core.running('ab', '')).toBe('{"schemaVersion":1,"id":"ab","lifetime":"durable","state":"running","spoolLimitBytes":1048576}')
  expect(Core.failed('ab', '', 'x')).toBe('{"id":"ab","lifetime":"durable","spoolLimitBytes":1048576,"schemaVersion":1,"state":"failed","exitCode":null,"error":"x"}')
})

test('list classification, order and shape', () => {
  const ok = (v: string) => ({ok: true as const, value: v})
  const bad = {ok: false as const, error: {code: 1, message: 'x'}}
  const m = Core.meta('', '5', 'durable', false)
  expect(Core.classify('a', ok(''), ok(''), ok(''), false)).toEqual({p: 'skip'})
  expect(Core.classify('a', bad, ok(''), ok(''), false)).toEqual({p: 'skip'})
  expect(Core.classify('a', ok(m), ok(''), ok(''), false)).toEqual({p: 'known', entry: {id: 'a', state: 'starting', label: '', started: '5', exit: '', session: false}})
  expect(Core.classify('a', ok(m), ok(''), ok('ready'), false)).toEqual({p: 'lease', meta: m})
  expect(Core.classify('a', ok(m), ok(''), ok('ready'), true)).toEqual({p: 'skip'})
  expect(Core.listing('a\n\nb\nc\n', 2)).toEqual({ids: ['a', 'b'], truncated: true})
  const e = (id: string, started: string) => ({id, state: 'exited', label: '', started, exit: '0', session: false})
  expect(Core.listJson([e('old', '1'), e('none', ''), e('new', '9'), e('tie', '9')], false)).toBe(
    '{"jobs":[{"id":"new","state":"exited","startedAt":9,"exitCode":0},{"id":"tie","state":"exited","startedAt":9,"exitCode":0},{"id":"old","state":"exited","startedAt":1,"exitCode":0},{"id":"none","state":"exited","exitCode":0}],"truncated":false}',
  )
})

test('follow never repeats an event and discloses gaps', () => {
  const line = (n: number) => `{"sequence":${n},"type":"x","data":{}}`
  expect(Core.follow([line(1), line(2), line(5), '', line(5), line(3)], 1)).toEqual({cursor: 5, outs: [line(2), Core.lossJson(2, 5), line(5)]})
  expect(Core.sequence('{"sequence":4294967295,')).toBe(4294967295)
  expect(Core.sequence('garbage')).toBe(null)
  expect(Core.followDecision(true, true)).toBe('finished')
  expect(Core.followDecision(false, true)).toBe('expired')
  expect(Core.followFuel(30000)).toBe(1264)
})

test('read plans', () => {
  expect(Core.readPlan(['--wait-ms', '5', '--base64', 'id', 'stderr', '7', '9'])).toEqual({ok: true, value: {id: 'id', stream: 'stderr', offset: 7, max: 9, wait: 5, base64: true}})
  expect(Core.readPlan(['--', '--wait-ms', 'stdout'])).toEqual({ok: true, value: {id: '--wait-ms', stream: 'stdout', offset: 0, max: 65536, wait: 0, base64: false}})
  expect(Core.readPlan(['--wait-ms'])).toEqual({ok: false, error: {code: 2, message: 'usage: read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]'}})
  expect(Core.readPlan(['id', 'stdout', '0', '0']).ok).toBe(false)
})

test('labels', () => {
  expect(Core.labelChecked('é'.repeat(120)).ok).toBe(true)
  for (const bad of ['', 'x'.repeat(121), '\ttab', '\u0085next', ' sep', 'del\u007f']) expect(Core.labelChecked(bad).ok).toBe(false)
  expect(Core.labelChecked('🙂'.repeat(120)).ok).toBe(true)
})

test('spool spans, wrapping, overwrite loss, UTF-8 hold-back and records', () => {
  const h = new Uint8Array(16)
  h.set([1, 2, 0, 0, 0, 0, 0, 0, 1])
  expect(Spool.head(h)).toEqual({count: 513, closed: true})
  expect(Spool.head(new Uint8Array(15))).toEqual({count: 0, closed: false})
  expect(Spool.span(100, 1000, 0, 50)).toEqual({start: 100, length: 50, omitted: 100})
  expect(Spool.span(0, 10, 20, 50)).toEqual({start: 20, length: 0, omitted: 0})
  expect(Spool.slices(1048570, 10)).toEqual([{at: 1048586, length: 6}, {at: 16, length: 4}])
  expect(Spool.overwritten(0, 10, 1048576 + 4)).toBe(4)
  expect([...Spool.kept(new Uint8Array([65, 240, 159]), false)]).toEqual([65])
  expect([...Spool.kept(new Uint8Array([65, 240, 159]), true)]).toEqual([65, 240, 159])
  expect([...Spool.kept(new Uint8Array([65, 0xc3, 0xa9]), false)]).toEqual([65, 0xc3, 0xa9])
  expect(Spool.record({id: 'a', stream: 'stdout', start: 1, omitted: 0, bytes: new Uint8Array([0xc3, 0xa9]), eof: false, state: 'running'}, true)).toBe(
    '{"id":"a","stream":"stdout","offset":1,"bytes":2,"omittedBytes":0,"data":"w6k=","next":3,"eof":false,"state":"running"}',
  )
  expect([Spool.interval(0), Spool.interval(500), Spool.interval(5000)]).toEqual([1, 5, 20])
})

test('store format decisions', () => {
  expect(Store.decide('=' + Store.marker, false)).toEqual(Store.accept)
  expect(Store.decide('+', false)).toEqual(Store.adopt)
  expect(Store.decide('=', true)).toEqual(Store.adopt)
  expect(Store.decide('=', false)).toEqual(Store.accept)
  expect(Store.decide('={"store":2}', false)).toEqual(Store.newer('2'))
  expect(Store.decide('={"store":0}', true)).toEqual(Store.unreadable)
  expect(Store.decide('={"store":1.0}', true)).toEqual(Store.unreadable)
  expect(Store.decide('={"store":1,"store":1}', true)).toEqual(Store.unreadable)
  expect(Store.decide('=not json', true)).toEqual(Store.unreadable)
})

describe('restFor', () => {
  test('an announced job rests until rung once quiet with nothing unsaved; a polling worker never does', () => {
    const quiet = {unsaved: false, age: 1, quiet: Core.quietMax}
    expect(Core.restFor(quiet, true)).toBeNull()
    expect(Core.restFor(quiet, false)).toBe(Core.restMaxMs)
    expect(Core.restFor({...quiet, unsaved: true}, true)).toBe(Core.tickMs)
    expect(Core.restFor({...quiet, quiet: 1}, true)).toBe(2 * Core.tickMs)
  })
})

describe('reachesWorker', () => {
  test('entries of at most 4096 bytes without NUL reach the worker', () => {
    expect(Core.reachesWorker(['/bin/echo', 'x'.repeat(4096)])).toBe(true)
    expect(Core.reachesWorker(['/bin/echo', 'x'.repeat(4097)])).toBe(false)
    expect(Core.reachesWorker(['/bin/echo', 'é'.repeat(2049)])).toBe(false)
    expect(Core.reachesWorker(['/bin/echo', 'a\0b'])).toBe(false)
  })
})
