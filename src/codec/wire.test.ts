// native/tests/wire.bend, codec-wire-probe.bend and the wire half of
// codec-wire.test.ts, against src/codec/wire.ts.

import {describe, expect, test} from 'bun:test'
import * as Codec from './codec.ts'
import * as Wire from './wire.ts'

// The probe's modes: each prints the encoded result, or is rejected.
const probe = {
  request(text: string): string | null {
    const r = Wire.request(text)
    if (!r.ok) return null
    const e = Codec.encode(r.value)
    return e.ok ? e.value : null
  },
  response(request: string, text: string): string | null {
    const req = Wire.request(request)
    if (!req.ok) return null
    const r = Wire.response(text, req.value)
    if (!r.ok) return null
    const e = Codec.encode(r.value)
    return e.ok ? e.value : null
  },
  body(request: string, model: string): string | null {
    const req = Wire.request(request)
    if (!req.ok) return null
    const r = Wire.body(req.value, model)
    return r.ok ? r.value : null
  },
}
const accepted = (out: string | null): string => {
  expect(out).not.toBeNull()
  return out!
}

const keyed = <T>(n: number, prefix: string, value: (i: number) => T) => Object.fromEntries(Array.from({length: n}, (_, i) => [`${prefix}${i}`, value(i)]))
const q = (type: string, criteria?: unknown) => ({type, instructions: 'judge', ...(criteria === undefined ? {} : {criteria})})
const request = (question: unknown = q('noul')) => ({state: {}, questions: {q: question}})
const requestText = (question?: unknown) => JSON.stringify(request(question))
const req = requestText()
const rawResponse = (n: string, input = '1', output = '2') =>
  `{"model":"jev","answers":{"q":{"type":"noul","noul":${n}}},"usage":{"input_tokens":${input},"output_tokens":${output}}}`
const noUsage = '"usage":{"input_tokens":0,"output_tokens":0}'

describe('wire.bend', () => {
  const requestTextB = '{"state":{},"questions":{"q":{"type":"noul","instructions":"x"}}}'
  const responseText = (n: string) => `{"model":"jev","answers":{"q":{"type":"noul","noul":${n}}},"usage":{"input_tokens":1,"output_tokens":2}}`
  const questionRequest = (question: string) => `{"state":[],"questions":{"q":${question}}}`
  const numeric = (text: string, scale: number, maximum: bigint) => {
    const v = Codec.read(text)
    return v.ok ? Wire.scalar(v.value, scale, maximum) : v
  }
  const number = (r: ReturnType<typeof numeric>, n: bigint) => r.ok && r.value === n
  const response = (text: string, request = requestTextB) => {
    const r = Wire.request(request)
    return r.ok ? Wire.response(text, r.value) : r
  }
  const replyUsage = (text: string, request: string) => {
    const r = Wire.request(request)
    if (!r.ok) return r
    const reply = Wire.reply(text, r.value)
    return reply.ok ? Wire.replyUsage(reply.value) : reply
  }
  const responseUsage = (text: string, request: string) => {
    const r = response(text, request)
    return r.ok ? Wire.usage(r.value) : r
  }
  const counts = (r: ReturnType<typeof Wire.usage>, i: bigint, o: bigint) => r.ok && r.value[0] === i && r.value[1] === o
  const largeLegendRequest = `{"state":{},"questions":{"q":{"type":"score","instructions":"x","criteria":["a","${'b'.repeat(1048000)}"]}}}`
  const longHalf = `0.5${'0'.repeat(1000)}`
  const largeLegendResponse = `{"model":"jev","answers":{"q":{"type":"score","score":1,"confidence":${longHalf},"probabilities":{"0":${longHalf},"1":${longHalf}}}},"usage":{"input_tokens":1,"output_tokens":2}}`

  test('34 assertions', () => {
    const checks = [
      Wire.request(requestTextB).ok,
      !Wire.request('{}').ok,
      !Wire.request('{"state":null,"questions":{}}').ok,
      !Wire.request('{"state":{},"questions":{}}').ok,
      Wire.request(questionRequest('{"type":"choice","instructions":{},"criteria":{"a":null}}')).ok,
      Wire.request(questionRequest('{"type":"score","instructions":{},"criteria":["a",{}]}')).ok,
      !Wire.request(questionRequest('{"type":"score","instructions":{},"criteria":["a"]}')).ok,
      !Wire.request(questionRequest('{"type":"text","instructions":{}}')).ok,
      number(numeric('0.125', 12, Wire.UNIT), 125000n * 1000000n),
      number(numeric('1e0', 12, Wire.UNIT), Wire.UNIT),
      number(numeric('1000e-3', 12, Wire.UNIT), Wire.UNIT),
      number(numeric('-0.000e-1000', 12, Wire.UNIT), 0n),
      !number(numeric('-1e-1000', 12, Wire.UNIT), 0n),
      !number(numeric('1.000000000000000000001', 12, Wire.UNIT), Wire.UNIT),
      !number(numeric('1.000000000001', 12, Wire.UNIT), Wire.UNIT),
      number(numeric('16777217', 0, Wire.NAT_MAX), 16777217n),
      number(numeric('16777217.000', 0, Wire.NAT_MAX), 16777217n),
      !number(numeric('16777217.00000001', 0, Wire.NAT_MAX), 16777217n),
      !number(numeric('281474976710656', 0, Wire.NAT_MAX), 0n),
      number(numeric('281474976710655', 0, Wire.NAT_MAX), Wire.NAT_MAX),
      !number(numeric('9007199254740992', 0, Wire.NAT_MAX), 0n),
      !number(numeric('1e999999999999', 0, Wire.NAT_MAX), 0n),
      response(responseText('0.1')).ok,
      response(responseText('1')).ok,
      !response(responseText('-1e-1000')).ok,
      !response(responseText('1.0000000000000000000001')).ok,
      !response(responseText('true')).ok,
      !response('{"model":42,"answers":{},"usage":{"input_tokens":1,"output_tokens":2}}').ok,
      counts(replyUsage(responseText('0.1'), requestTextB), 1n, 2n),
      counts(responseUsage(responseText('0.1'), requestTextB), 1n, 2n),
      !replyUsage(responseText('true'), requestTextB).ok,
      response(largeLegendResponse, largeLegendRequest).ok,
      !responseUsage(largeLegendResponse, largeLegendRequest).ok,
      !replyUsage(largeLegendResponse, largeLegendRequest).ok,
    ]
    expect(checks.map((c, i) => (c ? 'ok' : `failed at ${i}`)).filter((c) => c !== 'ok')).toEqual([])
  })

  test('scalar messages', () => {
    const msg = (text: string, scale = 0, max = Wire.NAT_MAX) => {
      const r = numeric(text, scale, max)
      return r.ok ? r.value : r.error.message
    }
    expect(msg('-1')).toBe('negative wire scalar')
    expect(msg('1.5')).toBe('wire scalar exceeds twelve decimal places')
    expect(msg('1234567890123456')).toBe('wire scalar overflow')
    expect(msg('281474976710656')).toBe('wire scalar out of range')
    expect(msg('1e99999')).toBe('wire exponent limit')
    expect(msg('1e4097')).toBe('wire exponent limit')
    expect(msg('"1"')).toBe('expected numeric wire scalar')
    expect(msg('1e-0000000000004096')).toBe('wire scalar exceeds twelve decimal places')
  })

  test('exact decimals', () => {
    const d = (lex: string, max = 1n) => {
      const v = Codec.read(lex)
      if (!v.ok) throw new Error(lex)
      return Wire.decimal(v.value, max)
    }
    expect(d('0.5')).toEqual({ok: true, value: {whole: 0n, fraction: '5'}})
    expect(d('1.0')).toEqual({ok: true, value: {whole: 1n, fraction: ''}})
    expect(d('1e-3')).toEqual({ok: true, value: {whole: 0n, fraction: '001'}})
    expect(d('9', 9n)).toEqual({ok: true, value: {whole: 9n, fraction: ''}})
    expect(d('10', 9n).ok).toBe(false)
    expect(d('1.5').ok).toBe(false)
    expect(Wire.decimalAdd({whole: 0n, fraction: '48'}, {whole: 0n, fraction: '52'})).toEqual({whole: 1n, fraction: ''})
    expect(Wire.decimalAdd({whole: 0n, fraction: '999'}, {whole: 2n, fraction: '0011'})).toEqual({whole: 3n, fraction: '0001'})
    expect(Wire.decimalLe({whole: 0n, fraction: '98'}, {whole: 0n, fraction: '980'})).toBe(true)
    expect(Wire.decimalLe({whole: 0n, fraction: '981'}, {whole: 0n, fraction: '98'})).toBe(false)
  })
})

describe('Jev wire contract (codec-wire.test.ts)', () => {
  test('choice 1..255, score 2..10, Noul and descriptions', () => {
    const choices = (n: number) => requestText(q('choice', keyed(n, 'k', () => null)))
    const levels = (n: number) => requestText(q('score', Array(n).fill('level')))
    const withState = (state: unknown) => JSON.stringify({...request(), state})
    for (const n of [1, 255]) accepted(probe.request(choices(n)))
    for (const n of [0, 256]) expect(probe.request(choices(n))).toBeNull()
    for (const n of [2, 10]) accepted(probe.request(levels(n)))
    for (const n of [0, 1, 11]) expect(probe.request(levels(n))).toBeNull()
    for (const c of [undefined, {}, {true: [], false: {}}]) accepted(probe.request(requestText(q('noul', c))))
    for (const c of [null, [], {true: null}, {false: 1}, {unknown: 'x'}]) expect(probe.request(requestText(q('noul', c)))).toBeNull()
    for (const state of ['', {}, []]) accepted(probe.request(withState(state)))
    for (const state of [null, false, 3]) expect(probe.request(withState(state))).toBeNull()
    expect(probe.request(requestText(q('choice', {a: false})))).toBeNull()
    expect(probe.request(requestText(q('score', [null, 'yes'])))).toBeNull()
  })

  test('strict keys, IDs, UTF16 lengths, model labels and defaults', () => {
    const invalid = [
      {...request(), extra: true},
      {...request(), model: 4},
      {...request(), model: ''},
      {...request(), model: '🙂'.repeat(65)},
      {...request(), questions: {}},
      request({...q('noul'), extra: 1}),
      request(q('text')),
      request({type: 'noul'}),
      {...request(), questions: {'': q('noul')}},
      {...request(), questions: {['🙂'.repeat(65)]: q('noul')}},
    ]
    for (const value of invalid) expect(probe.request(JSON.stringify(value))).toBeNull()
    accepted(probe.request(JSON.stringify({...request(), model: '🙂'.repeat(64)})))
    expect(JSON.parse(accepted(probe.body(req, 'default'))).model).toBe('default')
    expect(accepted(probe.body(req, 'default')).startsWith('{"model":"default",')).toBe(true)
    const specified = JSON.stringify({...request(), model: 'specific'})
    expect(JSON.parse(accepted(probe.body(specified, ''))).model).toBe('specific')
    expect(probe.body(req, '')).toBeNull()
    expect(probe.body(req, 'm'.repeat(129))).toBeNull()
    const questions = (n: number) => JSON.stringify({state: '', questions: keyed(n, 'q', () => q('noul'))})
    for (const n of [1, 128]) accepted(probe.request(questions(n)))
    expect(probe.request(questions(129))).toBeNull()
  })

  test('the first failing check names the error', () => {
    const message = (value: unknown) => {
      const r = Wire.request(typeof value === 'string' ? value : JSON.stringify(value))
      return r.ok ? 'ok' : r.error.message
    }
    expect(message({...request(), extra: true})).toBe('unknown request field')
    expect(message({...request(), model: 4})).toBe('expected wire string')
    expect(message({...request(), model: ''})).toBe('invalid model label')
    expect(message({...request(), state: 1})).toBe('invalid Jev state')
    expect(message({questions: {}})).toBe('missing wire field')
    expect(message({...request(), questions: {}})).toBe('invalid question count')
    expect(message({...request(), questions: []})).toBe('expected wire object')
    expect(message({...request(), questions: {'': q('noul')}})).toBe('invalid question id')
    expect(message(request({...q('noul'), x: 1}))).toBe('unknown question field')
    expect(message(request({type: 'noul', instructions: 1}))).toBe('invalid instructions')
    expect(message(request(q('text')))).toBe('unknown Jev question type')
    expect(message(request(q('choice', {})))).toBe('invalid Choice criteria')
    expect(message(request(q('score', ['a'])))).toBe('invalid Score criteria')
    expect(message(request(q('noul', {x: 'y'})))).toBe('invalid Noul criteria')
    expect(message(request(q('noul', null)))).toBe('expected wire object')
    expect(message('[')).toBe('unexpected end')
  })

  test('no F32 rounding: tiny negatives, >1, and long valid decimals', () => {
    const invalid = ['-1e-1000', '1.0000000000000000000000000000001', '-0.00000000000000001', '1.00000001', '1e999', 'true', 'null', '"0.5"']
    const valid = ['0', '-0', '1', '1e0', '1000e-3', '-0e-1000', '1e-1000', '0.123456789012345678901234567890', '0.999999999999999999999999999999']
    for (const n of invalid) expect(probe.response(req, rawResponse(n))).toBeNull()
    for (const n of valid) expect(accepted(probe.response(req, rawResponse(n)))).toContain(`"noul":${n}`)
    expect(probe.response(req, rawResponse('1e-4097'))).toBeNull()
  })

  test('usage counts are exact integers with an explicit native range cap', () => {
    const valid = ['0', '-0', '16777217', '16777217.000', '167772170e-1', '281474976710655']
    const invalid = ['-1', '-1e-1000', '1.000000000000000001', '16777217.00000001', '281474976710656', '9007199254740991', '9007199254740992', '1e999999999', 'true', 'null', '"1"']
    for (const n of valid) expect(accepted(probe.response(req, rawResponse('0.5', n)))).toContain(`"input_tokens":${n}`)
    for (const n of invalid) expect(probe.response(req, rawResponse('0.5', n))).toBeNull()
  })

  test('normalizes typed answers, regenerates score legend, strips all unknown fields', () => {
    const r = {state: [], questions: {c: q('choice', {a: null, b: 'B'}), s: q('score', ['low', {high: true}]), n: q('noul')}}
    const response = {
      model: 'jev',
      secret: 'discard',
      answers: {
        c: {type: 'choice', choice: 'b', confidence: 0.9, probabilities: {b: 0.75, a: 0.25}, generated: 'discard'},
        s: {type: 'score', score: 0.8, confidence: 0.7, probabilities: {'1': 0.8, '0': 0.2}, legend: 'unsafe', extra: {}},
        n: {type: 'noul', noul: 1, generated: 'discard'},
      },
      usage: {input_tokens: 1, output_tokens: 2, secret: 'discard'},
    }
    const got = accepted(probe.response(JSON.stringify(r), JSON.stringify(response)))
    expect(got).toBe(
      '{"model":"jev","answers":{"c":{"type":"choice","choice":"b","confidence":0.9,"probabilities":{"a":0.25,"b":0.75}},' +
        '"s":{"type":"score","score":0.8,"confidence":0.7,"probabilities":{"0":0.2,"1":0.8},"legend":{"0":"low","1":{"high":true}}},' +
        '"n":{"type":"noul","noul":1}},"usage":{"input_tokens":1,"output_tokens":2}}',
    )
  })

  test('exact distribution coverage, sum tolerance and score bounds', () => {
    const r = requestText(q('choice', {a: null, b: null}))
    const response = (p: string, choice = 'a', confidence = '1') =>
      `{"model":"jev","answers":{"q":{"type":"choice","choice":"${choice}","confidence":${confidence},"probabilities":${p}}},${noUsage}}`
    for (const p of ['{"a":0.48,"b":0.5}', '{"a":0.52,"b":0.5}', '{"a":0.123456789012345678901,"b":0.876543210987654321099}'])
      accepted(probe.response(r, response(p)))
    const invalid = [
      '{"a":0.479999999999999999999,"b":0.5}',
      '{"a":0.520000000000000000001,"b":0.5}',
      '{"a":1}',
      '{"a":0.5,"c":0.5}',
      '{"a":0.5,"b":0.5,"c":0}',
      '{"a":0.5,"a":0.5}',
      '{"a":1.000000000000001,"b":0}',
      '{"a":-1e-1000,"b":1}',
      '{"a":"0.5","b":0.5}',
    ]
    for (const p of invalid) expect(probe.response(r, response(p))).toBeNull()
    expect(probe.response(r, response('{"a":0.5,"b":0.5}', 'missing'))).toBeNull()
    expect(probe.response(r, response('{"a":0.5,"b":0.5}', 'a', '1.00000000000001'))).toBeNull()
    const scoreReq = requestText(q('score', ['low', 'high']))
    const score = (n: string) => `{"model":"jev","answers":{"q":{"type":"score","score":${n},"confidence":1,"probabilities":{"0":0.5,"1":0.5}}},${noUsage}}`
    accepted(probe.response(scoreReq, score('0.1234567890123456789012345')))
    for (const n of ['-1e-1000', '1.00000000000000001', '2', '"0.5"']) expect(probe.response(scoreReq, score(n))).toBeNull()
  })

  test('full 255-option distributions and ten-level scores', () => {
    const probabilities: Record<string, number> = keyed(255, 'k', () => 1 / 255)
    const r = requestText(q('choice', keyed(255, 'k', () => null)))
    const value = {model: 'jev', answers: {q: {type: 'choice', choice: 'k254', confidence: 0.9, probabilities}}, usage: {input_tokens: 0, output_tokens: 0}}
    accepted(probe.response(r, JSON.stringify(value)))
    delete probabilities.k128
    expect(probe.response(r, JSON.stringify(value))).toBeNull()
    const scoreReq = requestText(q('score', Array(10).fill('level')))
    const score = {model: 'jev', answers: {q: {type: 'score', score: 9, confidence: 1, probabilities: keyed(10, '', () => 0.1)}}, usage: {input_tokens: 0, output_tokens: 0}}
    accepted(probe.response(scoreReq, JSON.stringify(score)))
    score.answers.q.score = 9.00000001
    expect(probe.response(scoreReq, JSON.stringify(score))).toBeNull()
  })

  test('response envelopes reject wrong keys, types, usage and model labels', () => {
    const base = JSON.parse(rawResponse('0.5'))
    const answer = base.answers.q
    for (const model of ['', 1, null, {}, '🙂'.repeat(65)]) expect(probe.response(req, JSON.stringify({...base, model}))).toBeNull()
    for (const answers of [{}, {wrong: answer}, {q: answer, extra: answer}, {q: {type: 'choice', noul: 1}}, {q: null}])
      expect(probe.response(req, JSON.stringify({...base, answers}))).toBeNull()
    for (const usage of [{}, {input_tokens: 1}, null, []]) expect(probe.response(req, JSON.stringify({...base, usage}))).toBeNull()
  })
})
