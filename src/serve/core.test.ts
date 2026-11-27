// ServeCore's policy (src/serve/core.ts): strict requests and their exact
// errors, id echo, framing and the 16 MiB line bound, CLI child plans under
// the session deadline, relayed CLI output, and session-child bounds.
// Ported from the request, framing and plan cases of native/tests/serve.test.ts
// and native/tests/sessions.test.ts, checked here without a binary.

import {describe, expect, test} from 'bun:test'
import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Core from './core.ts'

const json = (text: string): Json => {
  const r = Codec.readWithLimit(text, Core.LINE_MAX)
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const req = (value: unknown) => Core.request(json(JSON.stringify(value)))
const err = (value: unknown) => {
  const r = req(value)
  return r.ok ? null : r.error
}
const enc = new TextEncoder()
const dec = new TextDecoder()

describe('requests are strict', () => {
  const Z = 'a'.repeat(32)
  const cases: [unknown, number, string][] = [
    [{op: 'launch'}, 2, Core.UNKNOWN_OP],
    [{op: 'exec', argv: ['/bin/echo'], timeout: 5}, 2, 'unknown request field: timeout'],
    [{op: 'exec'}, 2, 'missing field: argv'],
    [{op: 'exec', argv: []}, 2, 'argv must be an array of 1 to 57 strings'],
    [{op: 'exec', argv: ['']}, 2, 'argv[0] must name a command'],
    [{op: 'exec', argv: ['/bin/echo', 1]}, 2, 'argv entries must be a string'],
    [{op: 'exec', argv: Array(58).fill('/bin/echo')}, 2, 'argv must be an array of 1 to 57 strings'],
    [{op: 'exec', argv: 'x'}, 2, 'argv must be an array of 1 to 57 strings'],
    [{op: 'exec', argv: ['/bin/echo'], timeoutMs: 0}, 2, 'timeoutMs must be an integer from 1 to 3600000'],
    [{op: 'exec', argv: ['/bin/echo'], timeoutMs: 1.5}, 2, 'timeoutMs must be an integer from 1 to 3600000'],
    [{op: 'exec', argv: ['/bin/echo'], timeoutMs: '5'}, 2, 'timeoutMs must be an integer from 1 to 3600000'],
    [{op: 'exec', argv: ['/bin/echo'], stdin: 5}, 2, 'stdin must be a string'],
    [{op: 'exec', argv: ['/bin/pwd'], cwd: 'relative'}, 2, 'cwd must be an absolute path'],
    [{op: 'watch', job: 'x', literal: 'y', timeoutMs: 300001}, 2, 'timeoutMs must be an integer from 1 to 300000'],
    [{op: 'watch', job: Z}, 2, 'missing field: literal'],
    [{op: 'status', job: '--help'}, 2, 'job must be an id returned by start'],
    [{op: 'status', job: ''}, 2, 'job must be an id returned by start'],
    [{op: 'status'}, 2, 'missing field: job'],
    [{op: 'status', job: 7}, 2, 'job must be a string'],
    [{op: 'events', job: 'x', after: -1}, 2, 'after must be an event sequence number'],
    [{op: 'events', job: 'x', after: 1.5}, 2, 'after must be an event sequence number'],
    [{op: 'events', job: 'x', after: 4294967296}, 2, 'after must be an event sequence number'],
    [{op: 'events', job: 'x', waitMs: 0}, 2, 'waitMs must be an integer from 1 to 300000'],
    [{op: 'events', job: 'x', waitMs: 300001}, 2, 'waitMs must be an integer from 1 to 300000'],
    [{op: 'start', argv: ['/bin/echo'], timeoutMs: 86400001}, 2, 'timeoutMs must be an integer from 1 to 86400000'],
    [{op: 'start', argv: ['/bin/echo'], input: 'file'}, 2, 'input must be "pipe" or "null"'],
    [{op: 'start', argv: ['/bin/echo'], stdin: 'x'}, 2, 'unknown request field: stdin'],
    [{op: 'wait', job: 'x', timeoutMs: 3600001}, 2, 'timeoutMs must be an integer from 1 to 3600000'],
    [{op: 'start', argv: ['/bin/echo'], label: ''}, 2, 'label must be 1..120 printable characters on one line'],
    [{op: 'start', argv: ['/bin/echo'], label: 'a\nb'}, 2, 'label must be 1..120 printable characters on one line'],
    [{op: 'start', argv: ['/bin/echo'], label: 7}, 2, 'label must be a string'],
    [{op: 'list', job: 'x'}, 2, 'unknown request field: job'],
    [{op: 'list', scope: 'all'}, 2, 'scope must be "store" or "session"'],
    [{id: {nested: true}, op: 'status', job: 'x'}, 2, 'id must be a string or number'],
    [[1, 2], 2, 'request must be a JSON object'],
    ['str', 2, 'request must be a JSON object'],
    [{id: 'x'.repeat(129), op: 'capabilities'}, 22, 'id must be at most 128 characters'],
    [{op: 'capabilities', extra: 1}, 2, 'unknown request field: extra'],
    [{id: 'u'}, 2, 'missing field: op'],
    [{op: 7}, 2, 'op must be a string'],
    [{op: 'validate'}, 2, 'missing field: request'],
    [{op: 'write', job: Z}, 2, 'missing field: text'],
    [{op: 'write', job: Z, text: 'x'.repeat(65537)}, 2, 'text must be at most 65536 characters'],
    [{op: 'write', job: Z, text: 7}, 2, 'text must be a string'],
    [{op: 'read', job: Z, stream: 'stdin'}, 2, 'stream must be "stdout" or "stderr"'],
    [{op: 'read', job: Z}, 2, 'missing field: stream'],
    [{op: 'read', job: Z, stream: 'stdout', max: 65537}, 2, 'max must be an integer from 1 to 65536'],
    [{op: 'read', job: Z, stream: 'stdout', max: 0}, 2, 'max must be an integer from 1 to 65536'],
    [{op: 'read', job: Z, stream: 'stdout', offset: -1}, 2, 'offset must be a byte offset (a non-negative integer)'],
    [{op: 'read', job: Z, stream: 'stdout', encoding: 'hex'}, 2, 'encoding must be "text" or "base64"'],
    [{op: 'spawn', argv: ['/bin/cat'], stdin: 'file'}, 2, 'stdin must be "pipe" or "null"'],
    [{op: 'spawn', argv: ['/bin/cat'], input: 'pipe'}, 2, 'unknown request field: input'],
    [{op: 'spawn', argv: ['/bin/cat'], timeoutMs: 86400001}, 2, 'timeoutMs must be an integer from 1 to 86400000'],
    [{op: 'decisionProviders', x: 1}, 2, 'unknown request field: x'],
    [{op: 'jev', request: {}, provider: 'other'}, 2, 'provider must be typesafe, openrouter, vercel or subq'],
    [{op: 'jev', request: {}, credential: ''}, 2, 'credential must be a non-empty string'],
    [{op: 'decide', request: {}, credential: 5}, 2, 'credential must be a non-empty string'],
  ]
  test('every malformed request gets its exact error', () => {
    expect(cases.map(([r]) => err(r))).toEqual(cases.map(([, code, message]) => ({code, message})))
  })

  test('well-formed requests parse to their op with defaults', () => {
    expect(req({op: 'exec', argv: ['/bin/echo', '--', 'x']})).toEqual(done({op: 'exec', argv: ['/bin/echo', '--', 'x'], input: '', timeout: null, cwd: ''}))
    expect(req({op: 'start', argv: ['/bin/cat'], input: 'pipe', label: 'svc', timeoutMs: 86400000, cwd: '/'})).toEqual(
      done({op: 'start', argv: ['/bin/cat'], timeout: 86400000, label: 'svc', cwd: '/', pipe: true}),
    )
    expect(req({op: 'spawn', argv: ['/bin/cat']})).toEqual(done({op: 'spawn', argv: ['/bin/cat'], pipe: true, timeout: null, label: '', cwd: ''}))
    expect(req({op: 'read', job: 's-x', stream: 'stderr'})).toEqual(done({op: 'read', job: 's-x', stream: 'stderr', offset: 0, max: 65536, wait: null, base64: false}))
    expect(req({op: 'events', job: 'x', after: 4294967295, waitMs: 300000})).toEqual(done({op: 'events', job: 'x', after: 4294967295, wait: 300000}))
    expect(req({op: 'list'})).toEqual(done({op: 'list', sessions: false}))
    expect(req({op: 'list', scope: 'session'})).toEqual(done({op: 'list', sessions: true}))
    expect(req({op: 'resolveDecision', request: {}})).toMatchObject(done({op: 'resolveDecision'}))
  })

  test('argv takes 1..57 entries; the 57th is the last', () => {
    expect(req({op: 'exec', argv: Array(57).fill('x')}).ok).toBe(true)
    expect(req({op: 'exec', argv: Array(58).fill('x')}).ok).toBe(false)
  })

  test('an ordinary request is capped at 1 MiB encoded; decisions at 16 MiB', () => {
    const big = 'x'.repeat(1048576)
    expect(err({op: 'exec', argv: ['/bin/cat'], stdin: big})?.code).toBe(22)
    expect(err({op: 'launch', stdin: big})?.code).toBe(22)
    expect(err({op: 'validateDecision', request: {state: big}})).toBe(null)
  })
})

describe('ids', () => {
  test('a string or number is echoed verbatim, anything else as null', () => {
    const echo = (text: string) => Core.respond(Core.id(json(text)), done('0'))
    expect(echo('{"id":"é\\u0001"}')).toBe('{"id":"é\\u0001","ok":true,"result":0}')
    expect(echo('{"id":1.50}')).toBe('{"id":1.50,"ok":true,"result":0}')
    expect(echo('{"id":1e3}')).toBe('{"id":1e3,"ok":true,"result":0}')
    expect(echo('{"id":-3}')).toBe('{"id":-3,"ok":true,"result":0}')
    expect(echo('{"id":{"a":1}}')).toBe('{"id":null,"ok":true,"result":0}')
    expect(echo('{"id":[1]}')).toBe('{"id":null,"ok":true,"result":0}')
    expect(echo('{"op":"x"}')).toBe('{"id":null,"ok":true,"result":0}')
    expect(echo('[1]')).toBe('{"id":null,"ok":true,"result":0}')
  })

  test('an error response quotes its message as the CLI does', () => {
    expect(Core.respond(json('"a"'), fail(1, 'a "b"\n'))).toBe('{"id":"a","ok":false,"error":{"code":1,"message":"a \\"b\\"\\u000a"}}')
  })

  test('a line that is not strict JSON keeps the parser code', () => {
    const line = (s: string) => Core.readLine(enc.encode(s))
    expect(line('nope')).toEqual(fail(1, 'request line is not strict JSON: bad literal'))
    expect(line('   ')).toEqual(fail(3, 'request line is not strict JSON: unexpected end'))
    expect(line('{"id":1,"id":2}')).toEqual(fail(22, 'request line is not strict JSON: duplicate JSON key'))
  })
})

describe('framing', () => {
  const lines = (chunks: string[]) => {
    let f = Core.framer()
    const out: string[] = []
    for (const c of chunks) {
      const r = Core.frame(f, enc.encode(c))
      out.push(...r.lines.map((l) => dec.decode(l)))
      f = r.framer
    }
    return {out, last: Core.last(f).map((l) => dec.decode(l)), size: f.size}
  }

  test('lines split on \\n across chunks; a CRLF loses its \\r; the rest is the partial line', () => {
    expect(lines(['a\r\nb', 'c\n\nd'])).toEqual({out: ['a', 'bc', ''], last: ['d'], size: 1})
    expect(lines(['\r\n'])).toEqual({out: [''], last: [], size: 0})
    expect(lines(['x\r'])).toEqual({out: [], last: ['x'], size: 2})
  })

  test('a partial line past 16 MiB overflows; one at the bound does not', () => {
    const at = Core.frame(Core.framer(), new Uint8Array(Core.LINE_MAX).fill(120)).framer
    expect(Core.overflowed(at)).toBe(false)
    expect(Core.overflowed(Core.frame(at, new Uint8Array([120])).framer)).toBe(true)
    expect(Core.overflowed(Core.frame(at, new Uint8Array([10])).framer)).toBe(false)
  })
})

describe('serve options', () => {
  test('budgets default to one evaluation and 100000 tokens', () => {
    expect(Core.budget([])).toEqual(done([1, 100000]))
    expect(Core.budget(['3'])).toEqual(done([3, 100000]))
    expect(Core.budget(['0', '0'])).toEqual(done([0, 0]))
    expect(Core.budget(['x'])).toEqual(fail(2, 'serve budgets must be integers: [max-evaluations [max-tokens]]'))
    expect(Core.budget(['4294967296'])).toEqual(fail(2, 'serve budgets must be integers: [max-evaluations [max-tokens]]'))
    expect(Core.budget(['1', '2', '3'])).toEqual(fail(2, 'usage: serve [--timeout-ms N] [max-evaluations [max-tokens]]'))
    expect(Core.deadline(undefined)).toEqual(fail(2, 'serve timeout must be 1..86400000 milliseconds'))
    expect(Core.deadline('60000')).toEqual(done(60000))
  })

  test('the banner carries the deadline and budgets beside the capabilities', () => {
    const b = JSON.parse(Core.banner('9.9.9-native', 'darwin-arm64', 5000, 2, 7))
    const caps = JSON.parse(Core.capabilities('9.9.9-native', 'darwin-arm64'))
    expect(b.ready).toEqual({protocol: 2, version: '9.9.9-native', timeoutMs: 5000, maxEvaluations: 2, maxTokens: 7, store: 1, platform: 'darwin-arm64', features: caps.features})
    expect(Object.keys(b.ready)).toEqual(['protocol', 'version', 'timeoutMs', 'maxEvaluations', 'maxTokens', 'store', 'platform', 'features'])
  })
})

describe('CLI child plans', () => {
  const self = ['/bin/jf']
  const defaults: Core.Defaults = {work: 3600000, wait: 30000, watch: 5000}
  const plan = (op: Core.Op, remaining = 3600000) => Core.plan(self, op, defaults, remaining)

  test('exec re-enters the executable with literal argv, cut to the session less the grace', () => {
    expect(plan({op: 'exec', argv: ['/bin/echo', '--', '+RTS'], input: 'in', timeout: null, cwd: '/tmp'}, 10000)).toEqual(
      done({argv: ['/bin/jf', '--RTS', 'exec', '--timeout-ms', '8000', '--stdin', '--cwd', '/tmp', '--', '/bin/echo', '--', '+RTS'], input: 'in', timeout: 10000, many: false}),
    )
    expect(plan({op: 'exec', argv: ['x'], input: '', timeout: 200, cwd: ''}, 10000)).toMatchObject(done({timeout: 2200}))
  })

  test('with no time left past the grace, the plan is the deadline error', () => {
    for (const op of [
      {op: 'exec', argv: ['x'], input: '', timeout: null, cwd: ''},
      {op: 'status', job: 'j'},
      {op: 'wait', job: 'j', timeout: null},
      {op: 'watch', job: 'j', literal: 'l', timeout: null},
      {op: 'events', job: 'j', after: 0, wait: 10},
    ] as Core.Op[])
      expect(plan(op, 2000)).toEqual(fail(124, 'serve deadline expired'))
  })

  test('control steps get at most 15 s; start passes its own lifetime, label, cwd and input', () => {
    expect(plan({op: 'status', job: 'j'})).toEqual(done({argv: ['/bin/jf', '--RTS', 'status', 'j'], input: '', timeout: 15000, many: false}))
    expect(plan({op: 'stop', job: 'j'}, 9000)).toMatchObject(done({timeout: 9000}))
    expect(plan({op: 'start', argv: ['/bin/cat'], timeout: 86400000, label: 'svc', cwd: '/', pipe: true})).toEqual(
      done({argv: ['/bin/jf', '--RTS', 'start', '--timeout-ms', '86400000', '--label', 'svc', '--cwd', '/', '--input', 'pipe', '--', '/bin/cat'], input: '', timeout: 15000, many: false}),
    )
    expect(plan({op: 'start', argv: ['x'], timeout: null, label: '', cwd: '', pipe: false})).toMatchObject(done({argv: ['/bin/jf', '--RTS', 'start', '--timeout-ms', '3600000', '--', 'x']}))
    expect(plan({op: 'list', sessions: false})).toEqual(done({argv: ['/bin/jf', '--RTS', 'list'], input: '', timeout: 15000, many: false}))
  })

  test('events, wait and watch use their own timers and defaults', () => {
    expect(plan({op: 'events', job: 'j', after: 3, wait: null})).toEqual(done({argv: ['/bin/jf', '--RTS', 'events', 'j', '3'], input: '', timeout: 15000, many: true}))
    expect(plan({op: 'events', job: 'j', after: 3, wait: 100})).toEqual(done({argv: ['/bin/jf', '--RTS', 'events', '--timeout-ms', '100', 'j', '3'], input: '', timeout: 2100, many: true}))
    expect(plan({op: 'wait', job: 'j', timeout: null})).toMatchObject(done({argv: ['/bin/jf', '--RTS', 'wait', '--timeout-ms', '30000', 'j'], timeout: 32000}))
    expect(plan({op: 'watch', job: 'j', literal: '', timeout: null})).toMatchObject(done({argv: ['/bin/jf', '--RTS', 'watch', '--timeout-ms', '5000', 'j', ''], many: true}))
  })

  test('in-process requests have no plan', () => {
    expect(plan({op: 'capabilities'})).toEqual(fail(2, 'this request runs in process'))
  })
})

describe('relayed CLI output', () => {
  const cap = (code: number, flags: number, stdout: string, stderr = ''): Result<Core.Captured> => done({code, flags, stdout: enc.encode(stdout), stderr: enc.encode(stderr)})

  test('one record, re-encoded; with many, every line as an array', () => {
    expect(Core.outcome(cap(0, 0, '{"a":"\\u000a"}\n'), false)).toEqual(done('{"a":"\\n"}'))
    expect(Core.outcome(cap(0, 0, '{"a":1}\n\n{"b":2}'), true)).toEqual(done('[{"a":1},{"b":2}]'))
    expect(Core.outcome(cap(2, 0, '', 'usage\n'), true)).toEqual(done('[]'))
  })

  test('a failed step is its exit code and trimmed stderr; a zero exit without output is 1', () => {
    expect(Core.outcome(cap(22, 0, '', '  native private job operation failed\n'), false)).toEqual(fail(22, 'native private job operation failed'))
    expect(Core.outcome(cap(0, 0, ''), false)).toEqual(fail(1, 'jev-fabric command failed'))
    expect(Core.outcome(cap(3, 0, '', 'x'.repeat(2000)), false)).toEqual(fail(3, 'x'.repeat(1024)))
  })

  test('a timed-out step is the deadline; a cut one is refused; a launch failure is prefixed', () => {
    expect(Core.outcome(cap(124, 1, '{}'), false)).toEqual(fail(124, 'serve deadline expired'))
    expect(Core.outcome(cap(0, 2, '{}'), false)).toEqual(fail(1, 'jev-fabric command output exceeded 1 MiB'))
    expect(Core.outcome(fail(22, 'native subprocess request failed'), false)).toEqual(fail(22, 'jev-fabric could not run the request: native subprocess request failed'))
  })
})

describe('session children', () => {
  test('lifetimes stay within the connection; workers get the grace within a day', () => {
    expect(Core.childLifetime(null, 50000)).toBe(50000)
    expect(Core.childLifetime(300, 50000)).toBe(300)
    expect(Core.childLifetime(86400000, 50000)).toBe(50000)
    expect(Core.workerTimeout(300)).toBe(5300)
    expect(Core.workerTimeout(86400000)).toBe(86400000)
    expect(Core.mode(true)).toBe('session')
    expect(Core.mode(false)).toBe('session-null')
  })

  test('only s- ids address a session child; observations are retargeted to its directory', () => {
    const status: Core.Op = {op: 'status', job: 's-abc'}
    expect(Core.sessionTarget(status)).toBe('s-abc')
    expect(Core.sessionTarget({op: 'status', job: 'abc'})).toBe(null)
    expect(Core.sessionTarget({op: 'list', sessions: true})).toBe(null)
    expect(Core.retarget(status, 'abc')).toEqual({op: 'status', job: 'abc'})
    expect(Core.retarget({op: 'stop', job: 's-abc'}, 'abc')).toEqual({op: 'stop', job: 's-abc'})
  })

  test('the deadline helpers never hand a child more than the session has left', () => {
    for (const remaining of [0, 1999, 2000, 2001, 5000, 3600000])
      for (const requested of [null, 1, 1000, 3600000]) {
        const ms = Core.inner(requested, 30000, remaining)
        expect(ms + Core.GRACE <= Math.max(remaining, Core.GRACE)).toBe(true)
        expect(ms === 0).toBe(remaining <= Core.GRACE)
      }
  })
})
