// The parser (native/Cli.bend): plans, canonical lists and refusals, as the
// 0.8.1 oracle gives them.

import {describe, expect, test} from 'bun:test'
import {parse as decisionParse} from '../decision/cli-core.ts'
import * as Cli from './core.ts'

const plan = (args: string[]) => {
  const r = Cli.parse(args, decisionParse)
  if (!r.ok) return `${r.error.code}: ${r.error.message}`
  const p = r.value
  return p.k === 'pass' ? ['pass', ...p.args] : Cli.canonical(p.command, p.args, p.timeout ?? 0, p.input, p.launch)
}

describe('cli parse', () => {
  test('one leading -- is dropped; a second is a command', () => {
    expect(plan(['--', 'status', 'x'])).toEqual(['pass', 'status', 'x'])
    expect(plan(['status', 'x'])).toEqual(['pass', 'status', 'x'])
    expect(plan(['--', '--', 'exec'])).toEqual(['pass', '--', 'exec'])
    expect(plan([])).toEqual(['pass'])
  })
  test('exec: flags, legacy milliseconds and literal commands', () => {
    expect(plan(['exec', '--timeout-ms', '5', '/bin/echo', '--timeout-ms'])).toEqual(['exec', '5', '/bin/echo', '--timeout-ms'])
    expect(plan(['exec', '2000', '/bin/echo', '--', 'a'])).toEqual(['exec', '2000', '/bin/echo', '--', 'a'])
    expect(plan(['exec', '2000', '--stdin', 'cat'])).toEqual(['exec', '2000', '--stdin', 'cat'])
    expect(plan(['exec', '--stdin', '2000', 'cat'])).toEqual(['exec', '2000', '--stdin', 'cat'])
    expect(plan(['exec', '--', '2000', 'x'])).toEqual(['exec', '0', '2000', 'x'])
    expect(plan(['exec'])).toBe('2: command or file is required')
    expect(plan(['exec', '--stdin', '2000', '--stdin', 'cat'])).toBe('2: --stdin is supported once, for exec only')
    expect(plan(['exec', '--timeout-ms', '3', '4', 'x'])).toBe('2: specify the timeout only once')
    expect(plan(['exec', '--timeout-ms'])).toBe('2: --timeout-ms requires milliseconds')
    expect(plan(['exec', '--timeout-ms', '3600001', 'x'])).toBe('2: timeout must be an integer within the operation limit')
    expect(plan(['exec', '-'])).toBe('2: unknown option; use -- before a literal command')
    expect(plan(['exec', '--label', 'a', 'x'])).toBe('2: --label is supported for start only')
    expect(plan(['exec', '--input', 'pipe', 'x'])).toBe('2: --input is supported for start only')
  })
  test('exec --cwd: absolute, once; a legacy exec drops it as 0.8.1 did', () => {
    const r = Cli.parse(['exec', '--cwd', '/tmp', '/bin/pwd'])
    expect(r.ok && r.value.k === 'timed' && r.value.launch.cwd).toBe('/tmp')
    const legacy = Cli.parse(['exec', '--cwd', '/tmp', '1000', '/bin/pwd'])
    expect(legacy.ok && legacy.value.k === 'timed' && legacy.value.launch.cwd).toBe('')
    expect(plan(['exec', '--cwd', 'rel', 'x'])).toBe('2: cwd must be an absolute path')
    expect(plan(['exec', '--cwd', `/${'x'.repeat(4096)}`, 'x'])).toBe('2: cwd must be an absolute path')
    expect(plan(['exec', '--cwd', '/', '--cwd', '/', 'x'])).toBe('2: specify the cwd only once')
    expect(plan(['exec', '--cwd'])).toBe('2: --cwd requires a directory')
  })
  test('start: always __start <ms> <label> <cwd> <mode> <command...>', () => {
    expect(plan(['start', '--timeout-ms', '86400000', '--label', 'L', '--cwd', '/', '--input', 'pipe', '--', '-x'])).toEqual(['__start', '86400000', 'L', '/', 'pipe', '-x'])
    expect(plan(['start', '1000', '--label', 'x'])).toEqual(['__start', '1000', '', '', 'batch', '--label', 'x'])
    expect(plan(['start', '--cwd', '/tmp', '1000', 'pwd'])).toEqual(['__start', '1000', '', '/tmp', 'batch', 'pwd'])
    expect(plan(['start', '86400001', 'x'])).toBe('2: timeout must be an integer within the operation limit')
    expect(plan(['start', '--input', 'file', 'x'])).toBe('2: --input takes pipe')
    expect(plan(['start', '--input'])).toBe('2: --input takes pipe')
    expect(plan(['start', '--input', 'pipe', '--input', 'pipe', 'x'])).toBe('2: specify the input only once')
    expect(plan(['start', '--label', '', 'x'])).toBe('2: label must be 1..120 printable characters on one line')
    expect(plan(['start', '--label', 'a ', 'x'])).toBe('2: label must be 1..120 printable characters on one line')
    expect(plan(['start', '--label', 'a', '--label', 'b', 'x'])).toBe('2: specify the label only once')
    expect(plan(['start', '--label'])).toBe('2: --label requires text')
  })
  test('wait, watch, follow and events', () => {
    expect(plan(['wait', 'id', '500'])).toEqual(['wait', 'id', '500'])
    expect(plan(['wait', 'a', 'b', 'c'])).toBe('2: usage: wait [--timeout-ms N] <id> [legacy-ms]')
    expect(plan(['watch', 'id', '200', 'ready'])).toEqual(['watch', 'id', '200', 'ready'])
    expect(plan(['watch', '--timeout-ms', '300000', 'id', 'x'])).toEqual(['watch', 'id', '300000', 'x'])
    expect(plan(['watch', 'a', '0', 'b'])).toBe('2: timeout must be an integer within the operation limit')
    expect(plan(['watch', 'id'])).toBe('2: usage: watch [--timeout-ms N] <id> <literal>')
    expect(plan(['follow', '--timeout-ms', '9', 'id', '3'])).toEqual(['follow', '9', 'id', '3'])
    expect(plan(['follow', 'a', 'b', 'c'])).toBe('2: usage: follow [--timeout-ms N] <id> [after-sequence]')
    expect(plan(['events', 'id'])).toEqual(['pass', 'events', 'id'])
    expect(plan(['events', 'id', '4'])).toEqual(['pass', 'events', 'id', '4'])
    expect(plan(['events', '--timeout-ms', '100', 'id'])).toEqual(['events', 'id', '0', '100'])
    expect(plan(['events', 'a', 'b', 'c'])).toBe('2: usage: events [--timeout-ms N] <id> [after-sequence]')
    expect(plan(['events', '--timeout-ms', '300001', 'id'])).toBe('2: timeout must be an integer within the operation limit')
  })
  test('serve, run and jev', () => {
    expect(plan(['serve', '--timeout-ms', '86400000', '3', '4'])).toEqual(['serve', '86400000', '3', '4'])
    expect(plan(['serve', '--stdin'])).toBe('2: --stdin is supported once, for exec only')
    expect(plan(['run', '--timeout-ms', '7', 'x.bend', 'a'])).toEqual(['run', '7', 'x.bend', 'a'])
    expect(plan(['run'])).toBe('2: command or file is required')
    expect(plan(['jev', '100'])).toEqual(['jev', '100'])
    expect(plan(['jev'])).toBe('2: command or file is required')
  })
  test('decide and resolve-decision go through the decision parser', () => {
    expect(plan(['decide', '--provider', 'p', 'r.json'])).toEqual(['decide', '0', 'r.json', '100000', '{"provider":"p"}'])
    expect(plan(['resolve-decision', 'r.json'])).toEqual(['resolve-decision', '0', 'r.json', '100000', '{}'])
    expect(plan(['decide'])).toBe('2: Decision command requires a request file')
    expect(() => Cli.parse(['decide', 'x'])).toThrow()
    expect(Cli.needsDecisions(['--', 'resolve-decision'])).toBe(true)
    expect(Cli.needsDecisions(['exec', 'decide'])).toBe(false)
  })
  test('every other verb passes through', () => {
    for (const args of [['status', 'x'], ['list'], ['capabilities', 'x'], ['--version'], ['validate-decision', 'a', 'b'], ['__start']]) expect(plan(args)).toEqual(['pass', ...args])
  })
  test('default timers', () => {
    expect(['jev', 'decide', 'wait', 'follow', 'watch', 'exec', 'start', 'serve', 'run', 'events', 'resolve-decision'].map(Cli.defaultTimeout)).toEqual([
      'jev', 'jev', 'wait', 'wait', 'watch', 'work', 'work', 'work', 'work', 'work', 'work',
    ])
  })
  test('version and capabilities', () => {
    expect(Cli.VERSION).toMatch(/^\d+\.\d+\.\d+-native$/)
    expect(Cli.versionLine('Bun 1.0.0', 'linux-x64')).toBe(`${Cli.VERSION} (Bun 1.0.0; linux-x64)`)
    expect(JSON.parse(Cli.capabilities(Cli.VERSION, 'linux-x64'))).toEqual({version: Cli.VERSION, protocol: 2, store: 1, platform: 'linux-x64', features: [...Cli.FEATURES]})
    expect(Cli.platformOf('darwin', 'arm64')).toBe('darwin-arm64')
    expect(Cli.platformOf('win32', 'ia32')).toBe('unknown-unknown')
  })
})
