// The CLI driver in process: what each verb writes and exits with, for the
// verbs that need no child or store (the binary itself is covered by
// test/conformance).

import {expect, test} from 'bun:test'
import {main} from './cli.ts'
import * as Cli from './core.ts'

async function cli(...args: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {stdout: (t) => (stdout += t), stderr: (t) => (stderr += t)})
  return {code, stdout, stderr}
}

const JOB_USAGE =
  'usage: start <timeout-ms> <command> [args...] | status <id> | events <id> [after-sequence] | wait <id> <wait-timeout-ms> | stop <id> | follow <timeout-ms> <id> [after-sequence] | list | write <id> (--stdin | -- text...) | close-input <id> | read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]\n'

test('help, version and capabilities', async () => {
  expect(await cli()).toEqual({code: 0, stdout: `${Cli.USAGE}\n`, stderr: ''})
  expect(await cli('--', '--help')).toEqual({code: 0, stdout: `${Cli.USAGE}\n`, stderr: ''})
  const v = await cli('--version')
  expect(v.stdout).toMatch(/^\d+\.\d+\.\d+-native \(Bun [^;]+; (darwin|linux)-(arm64|x64)\)\n$/)
  expect(JSON.parse((await cli('capabilities')).stdout).version).toBe(Cli.VERSION)
})

test('extra words and unknown verbs are the job usage (2)', async () => {
  for (const args of [['--version', 'x'], ['capabilities', 'x'], ['--help', 'x'], ['nope'], ['decision-providers', 'x'], ['validate-decision', 'a', 'b'], ['update', 'now'], ['jev', '100']])
    expect(await cli(...args)).toEqual({code: 2, stdout: '', stderr: JOB_USAGE})
})

test('parser refusals die with their code and message', async () => {
  expect(await cli('exec', '--bogus')).toEqual({code: 2, stdout: '', stderr: 'unknown option; use -- before a literal command\n'})
  expect(await cli('resolve-decision')).toEqual({code: 2, stdout: '', stderr: 'Decision command requires a request file\n'})
})

test('a malformed configured default stops the verb before it starts', async () => {
  const saved = process.env.JEV_FABRIC_WAIT_MS
  process.env.JEV_FABRIC_WAIT_MS = 'nope'
  try {
    expect(await cli('wait', '0123456789abcdef0123456789abcdef')).toEqual({code: 2, stdout: '', stderr: 'timeout must be an integer within the operation limit\n'})
  } finally {
    if (saved === undefined) delete process.env.JEV_FABRIC_WAIT_MS
    else process.env.JEV_FABRIC_WAIT_MS = saved
  }
})
