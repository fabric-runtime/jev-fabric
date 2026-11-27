// Deadlines (native/tests/time-core.bend, timers.bend and the timer parts of
// timers.test.ts): central defaults, the one parser, configured settings, and
// shared budgets that subtract elapsed time and launch nothing once expired.

import {afterAll, expect, test} from 'bun:test'
import {existsSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {capture, gone, probe, tempRoot} from '../proc/helpers.test-util.ts'
import * as T from './core.ts'
import * as Time from './time.ts'

const root = tempRoot('time-test-')
afterAll(() => rmSync(root, {recursive: true, force: true}))

const ms = (r: ReturnType<typeof T.parse>) => (r.ok ? r.value : null)

test('native timer policy assertions', () => {
  expect([T.workDefault, T.jevDefault, T.waitDefault, T.watchDefault]).toEqual([3600000, 30000, 30000, 5000])
  expect(ms(T.parse('00060', 100))).toBe(60)
  expect(ms(T.parse('3600000', 3600000))).toBe(3600000)
  for (const [raw, max] of [
    ['0', 3600000],
    ['-1', 3600000],
    ['1.5', 3600000],
    ['3600001', 3600000],
    ['4294967297', 3600000],
    ['300001', 300000],
    ['86400001', T.jobMax],
    ['99999999', 3600000],
    ['', 3600000],
    ['000', 3600000],
    ['+5', 3600000],
    ['٣', 3600000],
  ] as const)
    expect(T.parse(raw, max)).toEqual({ok: false, error: {code: 2, message: T.TIMEOUT_ERROR}})
  expect(T.remaining({started: 100, duration: 300}, 200)).toBe(200)
  expect(T.remaining({started: 100, duration: 300}, 400)).toBe(0)
  expect(T.cap(4294967295 + 2, 100)).toBe(100)
  expect(T.jobMax).toBe(86400000)
  expect(ms(T.parse('86400000', T.jobMax))).toBe(86400000)
  expect(ms(T.parse('0000000000000086400000', T.jobMax))).toBe(86400000)
})

test("Bend's U32.read and Nat.read, exactly", () => {
  expect(T.readU32('4294967295')).toBe(4294967295)
  expect(T.readU32('4294967296')).toBe(null)
  expect(T.readU32('0000000000004294967295')).toBe(4294967295)
  for (const bad of ['', '-1', ' 1', '1 ', '1e3', '0x10', '+1']) expect(T.readU32(bad)).toBe(null)
  expect(T.readNat('0')).toBe(0)
  expect(T.readNat('281474976710655')).toBe(281474976710655)
  expect(T.readNat('281474976710656')).toBe(null)
  expect(T.readNat('000281474976710655')).toBe(281474976710655)
  expect(T.readNat('')).toBe(null)
})

test('settings: unset is the default, set must parse, explicit limits stay separate', () => {
  const saved = {...process.env}
  try {
    delete process.env.JEV_FABRIC_TIMEOUT_MS
    expect(Time.work()).toEqual({ok: true, value: 3600000})
    process.env.JEV_FABRIC_TIMEOUT_MS = '40'
    expect(Time.work()).toEqual({ok: true, value: 40})
    for (const raw of ['0', '-1', '1.5', '3600001', '4294967297', 'words']) {
      process.env.JEV_FABRIC_TIMEOUT_MS = raw
      expect(Time.work().ok).toBe(false)
    }
    process.env.JEV_FABRIC_WATCH_MS = '300001'
    expect(Time.watch().ok).toBe(false)
    process.env.JEV_FABRIC_WATCH_MS = '300000'
    expect(Time.watch()).toEqual({ok: true, value: 300000})
    process.env.JEV_FABRIC_WAIT_MS = 'invalid'
    expect(Time.wait()).toEqual({ok: false, error: {code: 2, message: T.TIMEOUT_ERROR}})
    process.env.JEV_FABRIC_JEV_TIMEOUT_MS = '700'
    expect(Time.jev()).toEqual({ok: true, value: 700})
  } finally {
    for (const k of ['JEV_FABRIC_TIMEOUT_MS', 'JEV_FABRIC_WATCH_MS', 'JEV_FABRIC_WAIT_MS', 'JEV_FABRIC_JEV_TIMEOUT_MS']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})

test('timer-free Process, Session and Scope APIs execute with configured defaults', async () => {
  const env = {...process.env, JEV_FABRIC_HOME: join(root, 'defaults'), JEV_FABRIC_TIMEOUT_MS: '1000'}
  const r = await capture(['bun', probe, 'timers', 'defaults'], {env})
  expect(r.code, r.err).toBe(0)
  const rows = r.out.trim().split('\n')
  expect(JSON.parse(rows[0]!).stdout).toBe('buffered\n')
  expect(JSON.parse(rows[1]!).stdout).toBe('session\n')
  expect(rows[2]).toBe('1000')
  expect(JSON.parse(rows[3]!).stdout).toBe('scoped-default\n')
  const timed = await capture(['bun', probe, 'timers', 'defaults'], {env: {...env, JEV_FABRIC_TIMEOUT_MS: 'invalid'}})
  expect(timed.code).toBe(2)
})

test('shared budgets expire, reap processes and sessions, and block new launches', async () => {
  const marker = join(root, 'expired-launch')
  const began = Date.now()
  const r = await capture(['bun', probe, 'timers', 'scope', marker], {env: {...process.env, JEV_FABRIC_HOME: join(root, 'scope')}})
  expect(r.code, r.err).toBe(0)
  expect(Date.now() - began).toBeLessThan(5000)
  const reports = r.out
    .trim()
    .split('\n')
    .filter((x) => x.startsWith('{'))
    .map((x) => JSON.parse(x))
  expect(reports.length).toBe(4)
  for (const row of reports) expect(row).toMatchObject({exitCode: 124, timedOut: true})
  // Reports 0, 1 and 3 printed their own pid before the budget expired; 2 never launched.
  for (const row of [reports[0], reports[1], reports[3]]) {
    const pid = Number(row.stdout.trim())
    expect(pid).toBeGreaterThan(1)
    expect(gone(pid)).toBe(true)
  }
  expect(reports[2].stdout).toBe('')
  expect(existsSync(marker)).toBe(false)
  expect(r.out).toContain('expired session: no launch')
})
