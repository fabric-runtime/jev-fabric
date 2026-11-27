// Sessions (native/tests/session.test.ts and session.bend): a persistent
// child with an affine stdin, offset reads of its spools and a join.

import {afterAll, expect, test} from 'bun:test'
import {rmSync} from 'node:fs'
import {join} from 'node:path'
import {capture, probe, tempRoot} from './helpers.test-util.ts'

const root = tempRoot('session-test-')
let serial = 0
afterAll(() => rmSync(root, {recursive: true, force: true}))

/** Runs one session fixture mode in its own process; returns its stdout. */
async function session(mode: string) {
  // The launch-failure probe runs under a small descriptor limit to expose leaks.
  const argv = mode === 'failures' ? ['/bin/sh', '-c', 'ulimit -n 64; exec "$@"', 'sh', 'bun', probe, 'session', mode] : ['bun', probe, 'session', mode]
  const {out, err, code} = await capture(argv, {env: {...process.env, JEV_FABRIC_HOME: join(root, String(serial++))}})
  expect(code, out + err).toBe(0)
  return out
}
const reports = (out: string) =>
  out
    .trim()
    .split('\n')
    .filter((x) => x.startsWith('{'))
    .map((x) => JSON.parse(x))

test('a persistent JSONL handshake observes replies before EOF and keeps the child state', async () => {
  const out = await session('handshake')
  expect(out).toContain('live:ready')
  expect(out).toContain('live:"count":1')
  expect(out).toContain('live:"count":2')
  const row = JSON.parse(out.trim().split('\n').at(-1)!)
  expect(row.exitCode).toBe(0)
  expect(row.stdout).toContain('{"count":2,"value":20}')
  expect(row.stdout).not.toContain('30')
})

test('96 invalid launches fail writes with EPIPE without leaking stdin descriptors', async () => {
  expect(await session('failures')).toContain('failure-cleanup:96')
})

test('binary stderr is preserved; invalid read bounds keep the session', async () => {
  expect(await session('bytes')).toContain('"state"')
})

test('a blocked stdin write ends when the child deadline closes its reader', async () => {
  const started = Date.now()
  const out = await session('blocked')
  expect(JSON.parse(out).timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('the first-byte spool cap and the write bound stay explicit', async () => {
  const out = await session('limits')
  expect(out).toContain('live:spool-cap')
  expect(out).toContain('bounded-tail:32768')
})

test('two live sessions compose without consuming one another', async () => {
  const rows = reports(await session('two'))
  expect(rows.length).toBe(2)
  expect(rows.every((x) => x.exitCode === 0)).toBe(true)
})

test('scope cancellation is explicit and stops both owned sessions', async () => {
  const rows = reports(await session('cancel'))
  expect(rows.length).toBe(2)
  expect(rows.every((x) => x.cancelled)).toBe(true)
})
