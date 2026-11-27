// Ported from native/tests/codec-decision.bend: the codec's explicit large
// and high-work profiles that decisions opt into.
import {expect, test} from 'bun:test'
import * as C from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import {jarr, jnum, jobj, jstr, NULL} from '../codec/json.ts'

const nested = (n: number): Json => (n === 0 ? NULL : jarr([nested(n - 1)]))
const entry = (): Json =>
  jobj([
    ['token', jstr('x')],
    ['logprob', jnum('-0.123456')],
    ['bytes', jarr([jnum('120')])],
  ])
const entries = (n: number): Json[] => Array.from({length: n}, entry)
const exact = (r: {ok: boolean; value?: unknown}, s: string) => r.ok && r.value === s

test('decision codec assertions', () => {
  const checks = [
    C.readWithLimit('null', 4).ok,
    !C.readWithLimit('null', 3).ok,
    !C.readWithLimit('null', 16777217).ok,
    !C.validateWithLimit(NULL, 16777217).ok,
    !C.encodeWithLimit(NULL, 16777217).ok,
    exact(C.encodeWithLimit(jnum('1.234567890123456789e-99'), 100), '1.234567890123456789e-99'),
    exact(C.encodeWithLimit(jstr('🙂'), 6), '"🙂"'),
    !C.encodeWithLimit(jstr('🙂'), 5).ok,
    exact(C.decodeUtf8WithLimit([240, 159, 153, 130], 4), '🙂'),
    !C.decodeUtf8WithLimit([240, 159, 153, 130], 3).ok,
    !C.decodeUtf8WithLimit([], 16777217).ok,
    exact(C.decodeUtf8WithLimit([], 0), ''),
    C.readBytesWithLimit([110, 117, 108, 108], 4).ok,
    !C.readBytesWithLimit([110, 117, 108, 108], 3).ok,
    !C.readBytesWithLimit([34, 192, 128, 34], 100).ok,
    !C.readWithLimit('{"a":1,"a":2}', 16777216).ok,
    !C.validateWithLimit(nested(65), 16777216).ok,
    !C.validateProfile(nested(65), 16777216, 524288).ok,
    !C.readProfile('null', 10, 524289).ok,
    !C.encodeProfile(NULL, 16777217, 524288).ok,
    !C.validateProfile(NULL, 100, 0).ok,
    C.readBytesProfile([110, 117, 108, 108], 4, 524288).ok,
    !C.validateWithLimit(jarr(entries(32768)), 16777216).ok,
    C.validateProfile(jarr(entries(32768)), 16777216, 524288).ok,
    C.encodeProfile(jarr(entries(32768)), 16777216, 524288).ok,
    C.readProfile(`[${'{"token":"x","logprob":-0.123456,"bytes":[120]},'.repeat(32767)}{"token":"x","logprob":-0.123456,"bytes":[120]}]`, 16777216, 524288).ok,
    !C.read(`"${'a'.repeat(1048576)}"`).ok,
    C.readWithLimit(`"${'a'.repeat(1048576)}"`, 1048578).ok,
    C.encodeWithLimit(jstr('a'.repeat(1048576)), 1048578).ok,
    !C.encode(jstr('a'.repeat(1048576))).ok,
    C.readWithLimit(`"${'a'.repeat(16777214)}"`, 16777216).ok,
    !C.readWithLimit(`"${'a'.repeat(16777215)}"`, 16777216).ok,
    C.encodeWithLimit(jstr('a'.repeat(16777214)), 16777216).ok,
    !C.encodeWithLimit(jstr('a'.repeat(16777215)), 16777216).ok,
  ]
  checks.forEach((ok, i) => expect(ok, `assertion ${i}`).toBe(true))
}, 60000)
