// native/tests/codec.bend, codec-limits.bend and the codec half of
// codec-wire.test.ts, against src/codec.

import {describe, expect, test} from 'bun:test'
import * as Codec from './codec.ts'
import type {Json} from './json.ts'
import {jarr, jnull, jnum, jobj, jstr, parse} from './json.ts'
import {quote} from './print.ts'

const ok = (r: {ok: boolean}) => r.ok
const roundtrip = (text: string) => {
  const v = Codec.read(text)
  return v.ok ? Codec.encode(v.value) : v
}
const encoded = (r: ReturnType<typeof Codec.encode>, want: string) => r.ok && r.value === want
const errorOf = (r: {ok: boolean; error?: {code: number; message: string}}) => (r.ok ? null : r.error)
const keyed = (n: number, prefix: string, value: (i: number) => unknown) => Object.fromEntries(Array.from({length: n}, (_, i) => [`${prefix}${i}`, value(i)]))

describe('codec.bend', () => {
  test('35 assertions', () => {
    const checks = [
      ok(Codec.read('null')),
      ok(Codec.read('[]')),
      ok(Codec.read('{}')),
      encoded(roundtrip('{"n":-1.2300E+003,"s":"\\uD83D\\uDE42"}'), '{"n":-1.2300E+003,"s":"🙂"}'),
      !ok(Codec.read('[1.]')),
      !ok(Codec.read('[1e]')),
      !ok(Codec.read('[1e+]')),
      !ok(Codec.read('[-]')),
      !ok(Codec.read('[01]')),
      !ok(Codec.read('[true false]')),
      !ok(Codec.read('{"a" 1}')),
      !ok(Codec.read('[1,]')),
      !ok(Codec.read('{"a":1,}')),
      !ok(Codec.read('NaN')),
      !ok(Codec.read('"\\x00"')),
      !ok(Codec.read('"\\uD800"')),
      !ok(Codec.read('"\\uDC00"')),
      !ok(Codec.read('"\\uD800\\u0041"')),
      !ok(Codec.read('{"a":1,"\\u0061":2}')),
      !ok(Codec.read('[null]x')),
      ok(Codec.readBytes([34, 240, 159, 153, 130, 34])),
      !ok(Codec.readBytes([34, 192, 128, 34])),
      !ok(Codec.readBytes([34, 237, 160, 128, 34])),
      !ok(Codec.readBytes([34, 244, 144, 128, 128, 34])),
      !ok(Codec.readBytes([34, 128, 34])),
      !ok(Codec.readBytes([34, 240, 159])),
      !ok(Codec.readBytes([256])),
      !ok(Codec.read(`"${String.fromCharCode(55296)}"`)),
      !encoded(Codec.encode(jstr(String.fromCharCode(0xdbff, 0xdbff))), ''),
      !encoded(Codec.encode(jnum('1.')), '1.'),
      !encoded(Codec.encode(jobj([['a', jnull()], ['a', jnull()]])), ''),
      encoded(roundtrip('[9007199254740993,1e-1000,1.000000000000000001]'), '[9007199254740993,1e-1000,1.000000000000000001]'),
      encoded(Codec.encode(jstr('\n\t\r"\\')), '"\\n\\t\\r\\"\\\\"'),
    ]
    expect(checks.map((c, i) => (c ? 'ok' : `failed at ${i}`)).filter((c) => c !== 'ok')).toEqual([])
  })

  test('errors keep their native codes: a parse error is its position', () => {
    expect(errorOf(Codec.read('{"state":"x"\n'))).toEqual({code: 13, message: 'unexpected end'})
    expect(errorOf(Codec.read('x'))).toEqual({code: 0, message: 'unexpected char'})
    expect(errorOf(Codec.read('{"x":1,"x":2}'))).toEqual({code: 22, message: 'duplicate JSON key'})
    expect(errorOf(Codec.read(']'))).toEqual({code: 22, message: 'JSON depth/work limit'})
    expect(errorOf(Codec.encode(jnum('1.')))).toEqual({code: 2, message: 'bad number'})
    expect(errorOf(Codec.encode(jnum(' 1')))).toEqual({code: 22, message: 'invalid number lexeme'})
    expect(errorOf(Codec.encode(jnum('[1]')))).toEqual({code: 22, message: 'invalid number lexeme'})
    // Positions count code points, not UTF-16 units.
    expect(errorOf(Codec.read('["🙂", x]'))).toEqual({code: 6, message: 'unexpected char'})
  })

  test('parse messages at every token boundary', () => {
    const cases: [string, number, string][] = [
      ['', 0, 'unexpected end'],
      ['+1', 0, 'unexpected char'],
      ['1.', 2, 'bad number'],
      ['[1.]', 3, 'incomplete number'],
      ['[1,]', 3, 'trailing comma'],
      ['{"a":1,}', 7, 'trailing comma'],
      ['{"a" 1}', 5, 'expected colon'],
      ['[1 2]', 3, 'expected comma'],
      ['{1:2}', 1, 'expected key'],
      ['tru', 3, 'unexpected end'],
      ['trux', 3, 'bad literal'],
      ['"abc', 4, 'unterminated string'],
      ['"\\q"', 2, 'bad escape'],
      ['"\\u12g4"', 5, 'bad unicode escape'],
      ['"\\uDC00"', 6, 'unpaired low surrogate'],
      ['"\\uD800x"', 7, 'unpaired high surrogate'],
      ['"\\uD800\\n"', 8, 'unpaired high surrogate'],
      ['"\u0001"', 1, 'unescaped control'],
      ['[null]x', 6, 'trailing junk'],
      ['[}', 1, 'unexpected char'],
      ['{]', 1, 'expected key'],
      ['[1}', 2, 'unexpected }'],
      ['{"a":1]', 6, 'unexpected ]'],
    ]
    for (const [text, code, message] of cases) expect([text, errorOf(parse(text))]).toEqual([text, {code, message}])
  })
})

describe('codec-limits.bend', () => {
  const depth = (n: number): Json => (n === 0 ? jnull() : jarr([depth(n - 1)]))
  const boundary = [0, 127, 194, 128, 223, 191, 224, 160, 128, 239, 191, 191, 240, 144, 128, 128, 244, 143, 191, 191]

  test('15 assertions', () => {
    const rejected = (r: {ok: boolean}) => !r.ok
    const size = (r: ReturnType<typeof Codec.decodeUtf8>, n: number) => r.ok && Array.from(r.value).length === n
    const checks = [
      true,
      rejected(Codec.read(`"${'a'.repeat(1048575)}"`)),
      rejected(Codec.read(' '.repeat(1048577))),
      rejected(Codec.read(`"${'🙂'.repeat(262144)}"`)),
      rejected(Codec.decodeUtf8(new Uint8Array(1048577).fill(65))),
      size(Codec.decodeUtf8(new Uint8Array(1048576).fill(65)), 1048576),
      rejected(Codec.encode(jstr('a'.repeat(1048576)))),
      rejected(Codec.encode(jstr('\u0001'.repeat(200000)))),
      rejected(Codec.encode(depth(200))),
      rejected(Codec.encode(jarr(Array.from({length: 20000}, jnull)))),
      size(Codec.decodeUtf8(boundary), 8),
      rejected(Codec.decodeUtf8([224, 159, 191])),
      rejected(Codec.decodeUtf8([240, 143, 191, 191])),
      rejected(Codec.decodeUtf8([245, 128, 128, 128])),
      rejected(Codec.decodeUtf8([239, 300, 128])),
    ]
    expect(checks.map((c, i) => (c ? 'ok' : `failed at ${i}`)).filter((c) => c !== 'ok')).toEqual([])
  })

  test('the messages of each limit', () => {
    expect(errorOf(Codec.read(' '.repeat(1048577)))?.message).toBe('JSON exceeds 1 MiB')
    expect(errorOf(Codec.decodeUtf8(new Uint8Array(1048577).fill(65)))?.message).toBe('UTF-8 exceeds 1 MiB')
    expect(errorOf(Codec.encode(depth(65)))?.message).toBe('JSON depth limit')
    expect(errorOf(Codec.encode(jarr(Array.from({length: 20000}, jnull))))?.message).toBe('JSON node limit')
    expect(errorOf(Codec.encode(jstr('\u0001'.repeat(200000))))?.message).toBe('JSON exceeds 1 MiB')
    expect(errorOf(Codec.decodeUtf8([224, 159, 191]))?.message).toBe('noncanonical UTF-8 scalar')
    expect(errorOf(Codec.decodeUtf8([245]))?.message).toBe('invalid UTF-8 lead')
    expect(errorOf(Codec.decodeUtf8([239, 300]))?.message).toBe('invalid UTF-8 continuation')
    expect(errorOf(Codec.decodeUtf8([240, 159]))?.message).toBe('truncated UTF-8')
    expect(errorOf(Codec.read(JSON.stringify({['k'.repeat(257)]: 0})))?.message).toBe('JSON key limit')
    expect(errorOf(Codec.read(JSON.stringify(keyed(257, 'k', () => 0))))?.message).toBe('JSON key limit')
    expect(errorOf(Codec.read(JSON.stringify(keyed(256, 'x'.repeat(250), () => 0))))?.message).toBe('JSON key comparison limit')
    expect(errorOf(Codec.read('1'.repeat(1025)))?.message).toBe('JSON numeric lexeme limit')
    expect(errorOf(Codec.read(`[${'0,'.repeat(16384)}0]`))?.message).toBe('JSON depth/work limit')
    expect(errorOf(Codec.encode(jstr(String.fromCharCode(0xd800))))?.message).toBe('JSON string/byte limit')
  })

  test('the opt-in byte limit and the high-work profile', () => {
    const big = `"${'a'.repeat(2 * 1048576)}"`
    expect(Codec.read(big).ok).toBe(false)
    expect(Codec.readWithLimit(big, 16777216).ok).toBe(true)
    expect(errorOf(Codec.readWithLimit(big, 16777217))?.message).toBe('JSON limit exceeds 16 MiB')
    expect(errorOf(Codec.readWithLimit(big, 1048576))?.message).toBe('JSON byte limit')
    expect(errorOf(Codec.decodeUtf8WithLimit(new Uint8Array(11).fill(65), 10))?.message).toBe('UTF-8 byte limit')
    const many = `[${'0.5,'.repeat(40000)}0.5]`
    expect(Codec.readWithLimit(many, 16777216).ok).toBe(false)
    expect(Codec.readProfile(many, 16777216, 524288).ok).toBe(true)
    expect(errorOf(Codec.readProfile(many, 16777216, 524289))?.message).toBe('JSON profile work exceeds 524288')
    const value = Codec.readProfile(many, 16777216, 524288)
    if (!value.ok) throw new Error('unreachable')
    expect(Codec.encodeProfile(value.value, 16777216, 524288)).toEqual({ok: true, value: many})
    expect(Codec.encodeWithLimit(value.value, 16777216).ok).toBe(false)
  })
})

describe('strict codec (codec-wire.test.ts)', () => {
  test('rejects malformed syntax and Unicode at every token boundary', () => {
    const bad = [
      '', '+1', '.1', '00', '-01', '1.', '1e', '1e+', '[1.]', '[1.e2]', '[1e,2]', '[1e+ ]', '[- ]', '[,]', '{,}',
      '{"x":}', '{"x" 1}', '{"x":1 "y":2}', '[true false]', 'true null', 'undefined', 'NaN', 'Infinity',
      '"\n"', '"\\q"', '"\\uD800"', '"\\uDC00"', '"\\uD800x"', '"\\uD800\\n"', '"\\uD800\\uD800"', '"\\uD800\\u0000"', '"\\uFFFFz', '﻿{}',
    ]
    for (const text of bad) expect([text, Codec.read(text).ok]).toEqual([text, false])
  })

  test('retains exact raw numbers and decodes escaped scalar pairs', () => {
    const raw = '[9007199254740993,-0,1E+004,0.00000000000000000000001,1e-1000]'
    expect(roundtrip(raw)).toEqual({ok: true, value: raw})
    const pairs = roundtrip('["\\u0000","\\ud83d\\ude42","é"]')
    expect(pairs.ok && JSON.parse(pairs.value)).toEqual(['\0', '🙂', 'é'])
    for (const value of [null, true, false, [], {}, {x: ['🙂', '\n\t"\\', 1.25]}]) {
      const r = roundtrip(JSON.stringify(value))
      expect(r.ok && JSON.parse(r.value)).toEqual(value)
    }
  })

  test('rejects duplicate decoded keys, nested and prototype-like ones too', () => {
    for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '[{"__proto__":1,"__proto__":2}]', '{"":1,"":2}', '{"a":{"b":0,"b":1}}'])
      expect(Codec.read(text).ok).toBe(false)
    const names = '{"__proto__":1,"constructor":2}'
    const r = roundtrip(names)
    expect(r.ok && r.value).toBe(names)
  })

  test('bounds nesting, numeric tokens, node work, keys and comparison work', () => {
    expect(Codec.read(`${'['.repeat(64)}0${']'.repeat(64)}`).ok).toBe(true)
    expect(Codec.read(`${'['.repeat(65)}0${']'.repeat(65)}`).ok).toBe(false)
    expect(Codec.read('1'.repeat(1025)).ok).toBe(false)
    expect(Codec.read(`[${'0,'.repeat(16384)}0]`).ok).toBe(false)
    expect(Codec.read(JSON.stringify({['k'.repeat(257)]: 0})).ok).toBe(false)
    expect(Codec.read(JSON.stringify(keyed(257, 'k', () => 0))).ok).toBe(false)
    expect(Codec.read(JSON.stringify(keyed(256, 'x'.repeat(250), () => 0))).ok).toBe(false)
  })
})

describe('Json.quote (core.bend)', () => {
  test('every control as \\u00xx, the rest as is', () => {
    expect(quote('a"b\\c\n')).toBe('"a\\"b\\\\c\\u000a"')
    expect(quote('🙂')).toBe('"🙂"')
    expect(quote('\u0000\u001f\u007f')).toBe('"\\u0000\\u001f\u007f"')
  })
})
