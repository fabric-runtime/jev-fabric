// Store compatibility with the 0.8.1 binary (.tmp/oracle-0.8.1/jev-fabric):
// a job either one starts is listable, readable, writable and stoppable by
// the other, both accept each other's store roots and refuse a newer one,
// and both print the same bytes for the same store.

import {afterAll, describe, expect, test} from 'bun:test'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {capture, entry, oracle, tempRoot} from '../proc/helpers.test-util.ts'

const root = tempRoot('jobs-compat-')
const home = join(root, 'store')
const started = new Set<string>()
const available = existsSync(oracle) && process.platform === 'darwin' && process.arch === 'arm64'

type Side = 'ours' | 'oracle'
async function cli(side: Side, args: string[], options: {home?: string; input?: string; cwd?: string} = {}) {
  const env: Record<string, string> = {PATH: '/usr/bin:/bin'}
  env.JEV_FABRIC_HOME = options.home ?? home
  const argv = side === 'ours' ? [process.execPath, entry, ...args] : [oracle, '--', ...args]
  return capture(argv, {env, input: options.input, cwd: options.cwd})
}
async function json(side: Side, args: string[], input?: string) {
  const r = await cli(side, args, {input})
  expect(r.code, `${side} ${args.join(' ')}: ${r.err}`).toBe(0)
  return JSON.parse(r.out)
}
/**
 * Both sides print exactly the same bytes (and exit codes) for the same
 * request. Ours takes the canonical arguments the CLI layer will hand it;
 * where 0.8.1's own CLI spells a verb differently, `typed` is what it takes.
 */
async function same(args: string[], typed = args) {
  const [a, b] = await Promise.all([cli('ours', args), cli('oracle', typed)])
  expect(a, args.join(' ')).toEqual(b)
  return a
}
async function startOn(side: Side, argv: string[], pipe = false) {
  const r = await json(side, ['__start', '20000', '', '', pipe ? 'pipe' : 'batch', ...argv])
  started.add(r.id)
  return r.id as string
}
const other = (s: Side): Side => (s === 'ours' ? 'oracle' : 'ours')

afterAll(async () => {
  if (available) await Promise.all([...started].map((id) => cli('oracle', ['stop', id])))
  rmSync(root, {recursive: true, force: true})
})

describe.skipIf(!available)('store compatibility with jev-fabric 0.8.1', () => {
  for (const side of ['oracle', 'ours'] as Side[]) {
    test(`a batch job ${side} started is seen identically by both`, async () => {
      const id = await startOn(side, ['/bin/sh', '-c', 'printf "héllo"; printf err >&2; /bin/sleep 0.3; printf " wörld"'])
      const receipt = await json(other(side), ['wait', id, '5000'])
      expect(receipt).toMatchObject({id, state: 'exited', stdout: 'héllo wörld', stderr: 'err'})
      await same(['status', id])
      await same(['events', id])
      await same(['events', id, '2'])
      await same(['read', id, 'stdout'])
      await same(['read', '--base64', id, 'stdout', '1', '3'])
      await same(['read', id, 'stderr'])
      await same(['follow', '1000', id], ['follow', '--timeout-ms', '1000', id])
      await same(['follow', '1000', id, '3'], ['follow', '--timeout-ms', '1000', id, '3'])
      await same(['wait', id, '100'])
      await same(['list'])
      expect((await same(['write', id, '--', 'x'])).code).toBe(22)
    })

    test(`a running job ${side} started is stopped by the other`, async () => {
      const id = await startOn(side, ['/bin/sh', '-c', 'printf "%s" "$$"; exec /bin/sleep 60'])
      await same(['status', id])
      for (let i = 0; i < 100; i++) {
        if ((await json(other(side), ['read', id, 'stdout'])).bytes > 0) break
        await Bun.sleep(20)
      }
      const stopped = await json(other(side), ['stop', id])
      expect(stopped).toMatchObject({id, state: 'cancelled', exitCode: 143, cancelled: true})
      await same(['status', id])
      await same(['list'])
      started.delete(id)
    })

    test(`an interactive job ${side} started takes writes and close-input from the other`, async () => {
      const id = await startOn(side, ['/bin/cat'], true)
      expect(await json(other(side), ['write', id, '--', 'from', 'the other\n'])).toEqual({id, written: 15, closed: false})
      expect(await json(side, ['write', id, '--stdin'], 'and itself\n')).toEqual({id, written: 11, closed: false})
      let text = ''
      for (let i = 0; i < 50 && !text.includes('itself'); i++) text = (await json(other(side), ['read', '--wait-ms', '1000', id, 'stdout'])).text
      expect(text).toBe('from the other\nand itself\n')
      await same(['read', id, 'stdout', '5'])
      expect(await json(other(side), ['close-input', id])).toEqual({id, written: 0, closed: true})
      expect(await json(side, ['wait', id, '5000'])).toMatchObject({id, state: 'exited', stdout: 'from the other\nand itself\n'})
      await same(['events', id])
      await same(['status', id])
      await same(['read', id, 'stdout'])
      await same(['write', id, '--', 'late'])
      await same(['close-input', id])
      started.delete(id)
    })
  }

  test('a crashed worker of either kind is recovered the same way', async () => {
    for (const side of ['oracle', 'ours'] as Side[]) {
      const id = await startOn(side, ['/bin/cat'], true)
      const worker = Number(Bun.spawnSync(['/usr/bin/pgrep', '-f', `__job-worker ${id}`]).stdout.toString().trim().split('\n')[0])
      expect(worker).toBeGreaterThan(0)
      process.kill(worker, 'SIGKILL')
      await Bun.sleep(200)
      const r = await json(other(side), ['status', id])
      expect(r).toMatchObject({state: 'failed', exitCode: null, error: 'worker exited without a terminal receipt'})
      await same(['status', id])
      started.delete(id)
    }
  })

  test("each accepts the other's store roots, refuses a newer one alike, and adopts an unmarked one alike", async () => {
    for (const side of ['oracle', 'ours'] as Side[]) {
      const dir = join(root, `made-by-${side}`)
      const id = (await capture(side === 'ours' ? [process.execPath, entry, 'start', '5000', '/bin/echo', 'hi'] : [oracle, '--', 'start', '5000', '/bin/echo', 'hi'], {env: {PATH: '/usr/bin:/bin', JEV_FABRIC_HOME: dir}})).out
      expect(JSON.parse(id).id).toMatch(/^[0-9a-f]{32}$/)
      expect(readFileSync(join(dir, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n')
      expect(existsSync(join(dir, '.gitignore'))).toBe(false)
      const theirs = await cli(other(side), ['wait', JSON.parse(id).id, '5000'], {home: dir})
      expect(theirs.code, theirs.err).toBe(0)
      expect(JSON.parse(theirs.out).stdout).toBe('hi\n')
    }
    const newer = join(root, 'newer')
    mkdirSync(newer, {mode: 0o700})
    writeFileSync(join(newer, '.jev-fabric-store.json'), '{"store":2}\n', {mode: 0o600})
    for (const args of [['list'], ['start', '5000', '/bin/echo'], ['status', 'a'.repeat(32)], ['read', 'a'.repeat(32), 'stdout']]) {
      const [a, b] = await Promise.all([cli('ours', args, {home: newer}), cli('oracle', args, {home: newer})])
      expect(a).toEqual(b)
      expect(a.code).toBe(22)
    }
    for (const [text, args] of [
      ['not json', ['list']],
      ['{"store":0}', ['list']],
      ['{"store":1.0}', ['list']],
      ['{"store":"1"}', ['list']],
      ['{"store":1,"store":1}', ['list']],
      ['{"store":00001}', ['list']],
      ['{"other":1}', ['list']],
      ['{"store":1}', ['list']],
      ['', ['list']],
    ] as [string, string[]][]) {
      writeFileSync(join(newer, '.jev-fabric-store.json'), text, {mode: 0o600})
      const [a, b] = await Promise.all([cli('ours', args, {home: newer}), cli('oracle', args, {home: newer})])
      expect(a, text).toEqual(b)
    }
    for (const side of ['oracle', 'ours'] as Side[]) {
      const old = join(root, `unmarked-${side}`)
      mkdirSync(old, {mode: 0o700})
      expect((await cli(side, ['list'], {home: old})).code).toBe(0)
      expect(existsSync(join(old, '.jev-fabric-store.json'))).toBe(false)
      expect((await cli(side, ['status', 'a'.repeat(32)], {home: old})).code).toBe(2)
      expect(readFileSync(join(old, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n')
    }
  })

  test('the default root ignores itself in version control, made by either', async () => {
    for (const side of ['oracle', 'ours'] as Side[]) {
      const cwd = join(root, `cwd-${side}`)
      mkdirSync(cwd)
      const env = {PATH: '/usr/bin:/bin'}
      const r = await capture(side === 'ours' ? [process.execPath, entry, 'list'] : [oracle, '--', 'list'], {env, cwd})
      expect(r.code, r.err).toBe(0)
      expect(readFileSync(join(cwd, '.jev-fabric-native', '.gitignore'), 'utf8')).toBe('*\n')
      expect(existsSync(join(cwd, '.jev-fabric-native', '.jev-fabric-store.json'))).toBe(true)
    }
  })

  test('list orders and shapes entries alike over a store both wrote', async () => {
    const r = await same(['list'])
    const jobs = JSON.parse(r.out).jobs
    expect(jobs.length).toBeGreaterThan(4)
  })
})
