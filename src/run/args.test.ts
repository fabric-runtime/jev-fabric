// `run`'s argument policy: 0.8.1's refusals in 0.8.1's order (the table
// test/conformance/cli.test.ts pins), and the new program check.

import {describe, expect, test} from 'bun:test'
import {done, fail} from '../codec/result.ts'
import {BEND_ERROR, JOB_USAGE, PROGRAM_ERROR, isProgram, parse} from './args.ts'

const work = () => done(1000)
const refused = (args: string[], message: string, configured = work) => expect(parse(args, configured)).toEqual(fail(2, message))

describe('run arguments', () => {
  test('0.8.1 refusals, before anything runs', () => {
    const cases: [string[], string][] = [
      [[], 'command or file is required'],
      [['--'], 'command or file is required'],
      [['0', 'x.ts'], 'timeout must be an integer within the operation limit'],
      [['--timeout-ms', '0', 'x.ts'], 'timeout must be an integer within the operation limit'],
      [['--timeout-ms', '3600001', 'x.ts'], 'timeout must be an integer within the operation limit'],
      [['--timeout-ms', 'oops', 'x.ts'], 'timeout must be an integer within the operation limit'],
      [['--timeout-ms'], '--timeout-ms requires milliseconds'],
      [['--stdin', 'x.ts'], '--stdin is supported once, for exec only'],
      [['--label', 'x', 'x.ts'], '--label is supported for start only'],
      [['--label'], '--label requires text'],
      [['--cwd', '/', 'x.ts'], '--cwd is supported for exec and start only'],
      [['--cwd'], '--cwd requires a directory'],
      [['--input', 'pipe', 'x.ts'], '--input is supported for start only'],
      [['--input'], '--input takes pipe'],
      [['--timeout-ms', '1000', '--timeout-ms', '1000', 'x.ts'], 'specify the timeout only once'],
      [['--timeout-ms', '1000', '2000', 'x.ts'], 'specify the timeout only once'],
      [['--bogus', 'x.ts'], 'unknown option; use -- before a literal command'],
      // Canonical `run <ms>` with no program fell through to the jobs usage.
      [['2000'], JOB_USAGE],
      [['2000', '--evil.ts'], PROGRAM_ERROR],
      [['2000', '--', 'x.ts'], PROGRAM_ERROR],
      [['--', '2000'], PROGRAM_ERROR],
      [['2000', 'program'], PROGRAM_ERROR],
    ]
    for (const [args, message] of cases) refused(args, message)
  })

  test('a malformed work default stops run unless a timeout is explicit', () => {
    const bad = () => fail(2, 'timeout must be an integer within the operation limit')
    refused(['x.ts'], 'timeout must be an integer within the operation limit', bad)
    expect(parse(['--timeout-ms', '5', 'x.ts'], bad)).toEqual(done({timeout: 5, program: 'x.ts', args: []}))
    expect(parse(['7', 'x.ts'], bad)).toEqual(done({timeout: 7, program: 'x.ts', args: []}))
  })

  test('a .bend source points at the migration', () => {
    refused(['x.bend'], BEND_ERROR)
    refused(['--timeout-ms', '500', 'examples/native/pipeline.bend', 'a'], BEND_ERROR)
    // Earlier checks still come first.
    refused(['0', 'x.bend'], 'timeout must be an integer within the operation limit')
    refused(['2000', '--evil.bend'], PROGRAM_ERROR)
  })

  test('TypeScript and JavaScript programs, with literal arguments after them', () => {
    expect(parse(['x.ts'], work)).toEqual(done({timeout: 1000, program: 'x.ts', args: []}))
    expect(parse(['--timeout-ms', '00500', '--', 'dir/x.mjs', '--timeout-ms', '9', '--', '-x'], work)).toEqual(
      done({timeout: 500, program: 'dir/x.mjs', args: ['--timeout-ms', '9', '--', '-x']}),
    )
    expect(parse(['2000', 'x.js', '3'], work)).toEqual(done({timeout: 2000, program: 'x.js', args: ['3']}))
    expect(parse(['--', '123.ts'], work)).toEqual(done({timeout: 1000, program: '123.ts', args: []}))
    for (const p of ['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx']) expect(isProgram(p)).toBe(true)
    for (const p of ['a.bend', 'a', 'a.ts.txt', 'a.json', '.ts.']) expect(isProgram(p)).toBe(false)
  })
})
