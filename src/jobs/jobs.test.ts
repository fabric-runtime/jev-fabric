// Durable jobs end to end (native/tests/jobs.test.ts, jobs.bend and the job
// parts of interactive.test.ts and store.test.ts). Each verb runs in its own
// process through worker-entry.test-main.ts, which stands in for the CLI and
// is the executable the detached worker re-enters.

import {afterAll, describe, expect, test} from 'bun:test'
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {capture, entry, gone, jsonLines, tempRoot} from '../proc/helpers.test-util.ts'

const root = tempRoot('jobs-test-')
const env = {PATH: '/usr/bin:/bin', JEV_FABRIC_HOME: root}
const active = new Set<string>()
const privateMode = (path: string) => statSync(path).mode & 0o777

async function command(args: string[], overrides: Record<string, string> = {}, input?: string) {
  const {out, err, code} = await capture([process.execPath, entry, ...args], {env: {...env, ...overrides}, input})
  return {stdout: out, stderr: err, code}
}
async function json(args: string[], overrides: Record<string, string> = {}, input?: string) {
  const r = await command(args, overrides, input)
  expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0)
  return JSON.parse(r.stdout)
}
async function start(argv: string[], ms = 5000, overrides: Record<string, string> = {}) {
  const r = await json(['start', String(ms), ...argv], overrides)
  expect(r.id).toMatch(/^[a-f0-9]{32}$/)
  active.add(r.id)
  return r.id as string
}
async function startPipe(argv: string[], label = '') {
  const r = await json(['__start', '60000', label, '', 'pipe', ...argv])
  active.add(r.id)
  return r.id as string
}
async function wait(id: string, ms = 5000) {
  const r = await json(['wait', id, String(ms)])
  if (r.state !== 'running') active.delete(id)
  return r
}
async function events(id: string, after?: number) {
  const r = await command(['events', id, ...(after === undefined ? [] : [String(after)])])
  expect(r.code, r.stderr).toBe(0)
  return jsonLines(r.stdout)
}
async function eventually<T>(get: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await get()
    if (check(value)) return value
    await Bun.sleep(20)
  }
  throw new Error('condition not observed')
}
const streamText = (items: any[], stream = 'stdout') =>
  items
    .filter((e) => e.type === 'process.output' && e.data.stream === stream)
    .map((e) => e.data.text)
    .join('')

afterAll(async () => {
  await Promise.all([...active].map((id) => command(['stop', id])))
  rmSync(root, {recursive: true, force: true})
})

describe('durable native command jobs', () => {
  test('launcher exits; running state and real stdout/stderr are live before release; wait does not cancel', async () => {
    const release = join(root, 'release')
    const script = 'printf live; printf warning >&2; while [ ! -f "$1" ]; do /bin/sleep 0.02; done; printf done'
    const id = await start(['/bin/sh', '-c', script, 'sh', release])
    expect((await json(['status', id])).state).toBe('running')
    expect((await wait(id, 30)).state).toBe('running')
    const live = await eventually(
      () => events(id),
      (xs) => streamText(xs) === 'live' && streamText(xs, 'stderr') === 'warning',
    )
    expect(live.some((e) => e.type === 'job.finished')).toBe(false)
    const last = live.at(-1).sequence
    writeFileSync(release, 'release')
    const receipt = await wait(id)
    expect(receipt).toMatchObject({id, state: 'exited', stdout: 'livedone', stderr: 'warning', exitCode: 0})
    const all = await events(id)
    expect(all.at(-1).type).toBe('job.finished')
    expect(await events(id, last)).toEqual(all.filter((e) => e.sequence > last))
    expect(await events(id, all.at(-1).sequence)).toEqual([])
    expect(await json(['stop', id])).toEqual(receipt)
    expect(await events(id)).toEqual(all)
  })

  test('private directory and every persisted file use private permissions', async () => {
    const id = await start(['/bin/echo', 'private'])
    await wait(id)
    expect(privateMode(root)).toBe(0o700)
    const dir = join(root, id)
    expect(privateMode(dir)).toBe(0o700)
    for (const name of readdirSync(dir)) expect(privateMode(join(dir, name))).toBe(0o600)
  })

  test('literal argv, Unicode and JSON escaping never gain shell interpretation', async () => {
    const marker = join(root, 'not-executed')
    const value = `🙂\n\t"\\ $(touch ${marker}); $HOME`
    const id = await start(['/bin/sh', '-c', 'printf "%s" "$1"', 'sh', value])
    const receipt = await wait(id)
    expect(receipt.stdout).toBe(value)
    expect(streamText(await events(id))).toBe(value)
    expect(existsSync(marker)).toBe(false)
  })

  test('the executable self-spawns with nothing on PATH', async () => {
    const id = await start(['/bin/echo', 'native'], 5000, {PATH: join(root, 'no-tools')})
    expect((await wait(id)).stdout).toBe('native\n')
  })

  test('failed command launch and nonzero exit persist sanitized failed receipts', async () => {
    const id = await start(['/nonexistent/SYNTHETIC_NOT_A_REAL_SECRET'])
    const receipt = await wait(id)
    expect(receipt).toMatchObject({state: 'failed', exitCode: null, error: 'command launch failed'})
    expect(JSON.stringify(receipt)).not.toContain('SYNTHETIC')
    expect((await events(id)).at(-1).type).toBe('job.finished')
    const nonzero = await start(['/bin/sh', '-c', 'printf error >&2; exit 7'])
    expect(await wait(nonzero)).toMatchObject({state: 'failed', exitCode: 7, stderr: 'error'})
  })

  test('deadline kills and reaps its owned child', async () => {
    const id = await start(['/bin/sh', '-c', 'printf "%s" "$$"; exec /bin/sleep 60'], 300)
    const receipt = await wait(id)
    expect(receipt).toMatchObject({state: 'timed_out', timedOut: true, exitCode: 124})
    expect(gone(Number(receipt.stdout))).toBe(true)
  })

  test('stop is cooperative, cleans up the owned group, concurrent and idempotent; terminal states are stable', async () => {
    const marker = join(root, 'escaped-descendant')
    // A backgrounded descendant would write the marker after 1s unless its group is killed.
    const script = '(/bin/sleep 1; printf leaked > "$1") & printf "%s" "$$"; exec /bin/sleep 60'
    const id = await start(['/bin/sh', '-c', script, 'sh', marker], 10000)
    await eventually(
      () => events(id),
      (xs) => /^\d+$/.test(streamText(xs)),
    )
    const stopped = await Promise.all([json(['stop', id]), json(['stop', id])])
    expect(stopped[0].state).toBe('cancelled')
    expect(stopped[0].exitCode).toBe(143)
    expect(stopped[1]).toEqual(stopped[0])
    expect(gone(Number(stopped[0].stdout))).toBe(true)
    expect(await json(['status', id])).toEqual(stopped[0])
    expect(await json(['stop', id])).toEqual(stopped[0])
    active.delete(id)
    await Bun.sleep(1200)
    expect(existsSync(marker)).toBe(false)
  })

  test('spool and replay stay bounded under output flood', async () => {
    const flood = '/usr/bin/head -c 1400000 /dev/zero'
    const id = await start(['/bin/sh', '-c', `${flood}; ${flood} >&2`], 5000)
    const receipt = await wait(id, 10000)
    expect(receipt.state).toBe('exited')
    expect(receipt.stdout.length).toBe(32768)
    expect(receipt.stderr.length).toBe(32768)
    expect(receipt.truncated).toEqual({stdout: true, stderr: true})
    const dir = join(root, id)
    expect(statSync(join(dir, 'stdout.bin')).size).toBe(1048576)
    expect(statSync(join(dir, 'stderr.bin')).size).toBe(1048576)
    expect(statSync(join(dir, 'events.jsonl')).size).toBeLessThan(1048576)
    const xs = await events(id)
    expect(xs.length).toBeLessThanOrEqual(64)
    expect(xs.some((e) => e.type === 'process.output' && e.data.omittedBytes > 0)).toBe(true)
    expect(xs.filter((e) => e.type === 'process.spool_limit').length).toBe(2)
    for (let i = 1; i < xs.length; i++) expect(xs[i].sequence).toBe(xs[i - 1].sequence + 1)
    expect(xs.at(-1).type).toBe('job.finished')
    expect(await events(id, xs.at(-2).sequence)).toEqual([xs.at(-1)])
  }, 30000)

  test('replay retention evicts the oldest entries and keeps a strictly increasing cursor', async () => {
    const script = 'n=0; while [ "$n" -lt 90 ]; do printf x; /bin/sleep 0.05; n=$((n+1)); done'
    const id = await start(['/bin/sh', '-c', script], 20000)
    expect((await wait(id, 20000)).state).toBe('exited')
    const xs = await events(id)
    expect(xs.length).toBe(64)
    expect(xs[0].sequence).toBeGreaterThan(1)
    expect(xs.at(-1).type).toBe('job.finished')
    for (let i = 1; i < xs.length; i++) expect(xs[i].sequence).toBe(xs[i - 1].sequence + 1)
  }, 30000)

  test('continuous output keeps publishing live snapshots whose chunks match the spool', async () => {
    const script = 'i=0; while [ "$i" -lt 60 ]; do printf "line %s\\n" "$i"; /bin/sleep 0.02; i=$((i+1)); done'
    const id = await start(['/bin/sh', '-c', script], 20000)
    const live = new Set<number>()
    for (let i = 0; i < 300 && live.size < 3; i++) {
      const xs = await events(id)
      if (xs.some((e) => e.type === 'job.finished')) break
      live.add(xs.at(-1).sequence)
      await Bun.sleep(20)
    }
    expect(live.size).toBeGreaterThanOrEqual(3)
    expect((await wait(id, 20000)).state).toBe('exited')
    const dir = join(root, id)
    const replay = await command(['events', id])
    expect(replay.stdout).toBe(readFileSync(join(dir, 'events.jsonl'), 'utf8'))
    const xs = jsonLines(replay.stdout)
    expect(xs.length).toBeLessThanOrEqual(64)
    for (let i = 1; i < xs.length; i++) expect(xs[i].sequence).toBe(xs[i - 1].sequence + 1)
    expect(xs.at(-1).type).toBe('job.finished')
    const spool = readFileSync(join(dir, 'stdout.bin'), 'utf8')
    const chunks = xs.filter((e) => e.type === 'process.output' && e.data.stream === 'stdout')
    expect(chunks.length).toBeGreaterThan(1)
    for (const {data} of chunks) expect(data.text).toBe(spool.slice(data.offset, data.offset + data.bytes))
    for (let i = 1; i < chunks.length; i++) {
      const [before, after] = [chunks[i - 1].data, chunks[i].data]
      expect(after.offset).toBe(before.offset + before.bytes + after.omittedBytes)
    }
  }, 30000)

  test('split UTF-8 survives live reads; a partial end and malformed bytes are explicit replacements', async () => {
    const script = "printf '\\360\\237'; /bin/sleep 0.15; printf '\\231\\202'; /bin/sleep 0.1; printf '\\360\\237'"
    const id = await start(['/bin/sh', '-c', script])
    await wait(id)
    expect(streamText(await events(id))).toBe('🙂�')
    const invalid = await start(['/bin/sh', '-c', "printf '\\377A\\355\\240\\200B'"])
    await wait(invalid)
    expect(streamText(await events(invalid))).toBe('�A�B')
  })

  test('follow prints live events, then one follow.end; a timeout reports the running state', async () => {
    const id = await start(['/bin/sh', '-c', 'printf one; /bin/sleep 0.3; printf two'])
    const r = await command(['follow', '5000', id])
    expect(r.code, r.stderr).toBe(0)
    const xs = jsonLines(r.stdout)
    expect(streamText(xs)).toBe('onetwo')
    expect(xs.at(-1)).toMatchObject({type: 'follow.end', reason: 'finished', next: xs.at(-2).sequence, receipt: {id, state: 'exited'}})
    active.delete(id)
    const long = await start(['/bin/sleep', '30'], 60000)
    const timed = jsonLines((await command(['follow', '100', long, '1'])).stdout)
    expect(timed.at(-1)).toMatchObject({type: 'follow.end', reason: 'timeout', receipt: {id: long, state: 'running'}})
    const polled = jsonLines((await command(['events', long, '1', '200'])).stdout)
    expect(polled).toEqual([])
  })

  test('rejects traversal, malformed ids, invalid numbers and absent jobs', async () => {
    for (const id of ['../outside', '.', '/etc', 'A'.repeat(32), 'a'.repeat(31), 'b'.repeat(32)]) {
      expect((await command(['status', id])).code).not.toBe(0)
      expect((await command(['stop', id])).code).not.toBe(0)
    }
    expect(await command(['status', 'zz'])).toEqual({stdout: '', stderr: 'native private job operation failed\n', code: 22})
    expect((await command(['status', 'b'.repeat(32)])).code).toBe(2)
    // A detached job may live a day; nothing else may exceed an hour.
    for (const ms of ['0', '-1', 'oops', '86400001']) expect((await command(['start', ms, '/bin/echo'])).code).not.toBe(0)
    expect(await command(['wait', 'a'.repeat(32), '3600001'])).toEqual({stdout: '', stderr: 'timeout must be 1..3600000 milliseconds\n', code: 2})
    expect((await command(['follow', '3600001', 'a'.repeat(32)])).code).toBe(2)
    expect((await command(['start'])).code).toBe(2)
    expect((await command(['start'])).stderr).toStartWith('usage: start <timeout-ms> <command> [args...] | status <id>')
    expect(await command(['events', 'a'.repeat(32), 'oops'])).toEqual({stdout: '', stderr: 'after-sequence must be a U32\n', code: 2})
  })

  test('an orphan lease becomes a stable failed receipt without trusting stale pid metadata', async () => {
    const id = 'd'.repeat(32)
    const dir = join(root, id)
    mkdirSync(dir, {mode: 0o700})
    writeFileSync(join(dir, 'ready'), 'ready', {mode: 0o600})
    writeFileSync(join(dir, 'pid'), String(process.pid), {mode: 0o600})
    const receipt = await json(['status', id])
    expect(receipt).toMatchObject({state: 'failed', exitCode: null, error: 'worker exited without a terminal receipt'})
    expect(await json(['stop', id])).toEqual(receipt)
    expect(await json(['status', id])).toEqual(receipt)
    expect(JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'))).toEqual(receipt)
    expect((await command(['__job-worker', id, '1000', '/bin/echo'])).code).not.toBe(0)
    expect(await command(['__job-worker', id, '1000', 'batch', '', '/bin/echo'])).toEqual({stdout: '', stderr: 'job already started or terminal\n', code: 1})
  })

  test('root and job-directory symlinks are rejected without reading targets', async () => {
    const target = join(root, 'target')
    mkdirSync(target, {mode: 0o700})
    const alias = join(root, 'root-alias')
    symlinkSync(target, alias)
    expect((await command(['start', '1000', '/bin/echo'], {JEV_FABRIC_HOME: alias})).code).not.toBe(0)
    const id = 'c'.repeat(32)
    symlinkSync(target, join(root, id))
    expect((await command(['status', id])).code).not.toBe(0)
    expect(readdirSync(target)).toEqual([])
  })

  test('receipt symlinks, overlarge reads, world-readable files and duplicate workers fail closed', async () => {
    const id = await start(['/bin/echo', 'safe'])
    const receipt = await wait(id)
    const path = join(root, id, 'receipt.json')
    const text = readFileSync(path, 'utf8')
    const marker = join(root, 'untouched')
    writeFileSync(marker, 'unchanged', {mode: 0o600})
    unlinkSync(path)
    symlinkSync(marker, path)
    expect((await command(['status', id])).code).not.toBe(0)
    expect((await command(['stop', id])).code).not.toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('unchanged')
    unlinkSync(path)
    writeFileSync(path, 'x'.repeat(1048577), {mode: 0o600})
    expect((await command(['status', id])).code).not.toBe(0)
    writeFileSync(path, text)
    chmodSync(path, 0o644)
    expect((await command(['status', id])).code).not.toBe(0)
    chmodSync(path, 0o600)
    expect((await command(['__job-worker', id, '1000', 'batch', '', '/bin/echo', 'changed'])).code).not.toBe(0)
    expect(await json(['status', id])).toEqual(receipt)
  })

  test('a stop-marker symlink cannot change unrelated files or signal an arbitrary pid', async () => {
    const id = await start(['/bin/sh', '-c', '/bin/sleep 0.6'], 2000)
    const marker = join(root, 'outside-marker')
    writeFileSync(marker, 'unchanged', {mode: 0o600})
    symlinkSync(marker, join(root, id, 'stop'))
    const stopped = await command(['stop', id])
    if (stopped.code === 0) expect(JSON.parse(stopped.stdout).state).toBe('failed')
    expect(readFileSync(marker, 'utf8')).toBe('unchanged')
    unlinkSync(join(root, id, 'stop'))
    const receipt = await wait(id)
    expect(['exited', 'failed']).toContain(receipt.state)
  })
})

describe('exact exit codes of unsafe store entries (the errno of the failing check, as 0.8.1)', () => {
  const E = process.platform === 'darwin' ? {EPERM: 1, ENOTDIR: 20, EFBIG: 27, ELOOP: 62} : {EPERM: 1, ENOTDIR: 20, EFBIG: 27, ELOOP: 40}
  const NOT_FOUND = 'native private job operation failed\n'
  test('symlinked root, symlinked job directory, symlinked, oversized and world-readable receipts', async () => {
    const dir = join(root, 'codes')
    const id = (await json(['start', '5000', '/bin/echo', 'safe'], {JEV_FABRIC_HOME: dir})).id
    const receipt = await json(['wait', id, '5000'], {JEV_FABRIC_HOME: dir})
    const target = join(root, 'codes-target')
    mkdirSync(target, {mode: 0o700})
    symlinkSync(target, join(root, 'codes-alias'))
    for (const args of [['start', '1000', '/bin/echo'], ['list'], ['status', 'c'.repeat(32)]])
      expect(await command(args, {JEV_FABRIC_HOME: join(root, 'codes-alias')})).toEqual({stdout: '', stderr: NOT_FOUND, code: E.ENOTDIR})
    symlinkSync(target, join(dir, 'c'.repeat(32)))
    expect(await command(['status', 'c'.repeat(32)], {JEV_FABRIC_HOME: dir})).toEqual({stdout: '', stderr: NOT_FOUND, code: E.ENOTDIR})
    const path = join(dir, id, 'receipt.json')
    const text = readFileSync(path, 'utf8')
    unlinkSync(path)
    symlinkSync(join(root, 'codes-target'), path)
    for (const verb of ['status', 'stop']) expect(await command([verb, id], {JEV_FABRIC_HOME: dir})).toEqual({stdout: '', stderr: NOT_FOUND, code: E.ELOOP})
    unlinkSync(path)
    writeFileSync(path, 'x'.repeat(1048577), {mode: 0o600})
    expect(await command(['status', id], {JEV_FABRIC_HOME: dir})).toEqual({stdout: '', stderr: NOT_FOUND, code: E.EFBIG})
    writeFileSync(path, text, {mode: 0o600})
    chmodSync(path, 0o644)
    expect(await command(['status', id], {JEV_FABRIC_HOME: dir})).toEqual({stdout: '', stderr: NOT_FOUND, code: E.EPERM})
    chmodSync(path, 0o600)
    expect(await json(['status', id], {JEV_FABRIC_HOME: dir})).toEqual(receipt)
    expect(readdirSync(target)).toEqual([])
  })
})

describe('interactive jobs', () => {
  async function readUntil(id: string, want: string, offset = 0) {
    let text = ''
    for (let i = 0; i < 100 && !text.includes(want); i++) {
      const r = await json(['read', '--wait-ms', '2000', id, 'stdout', String(offset)])
      text += r.text
      offset = r.next
      if (r.eof) break
    }
    return {text, offset}
  }

  test('an interactive job keeps state across writes from separate processes', async () => {
    const script = 'i=0; while IFS= read -r value; do i=$((i+1)); printf \'{"count":%s,"value":"%s"}\\n\' "$i" "$value"; done; echo bye'
    const id = await startPipe(['/bin/sh', '-c', script], 'counter')
    expect(await json(['status', id])).toMatchObject({id, label: 'counter', lifetime: 'durable', state: 'running'})
    expect(await json(['write', id, '--', 'one', 'two\n'])).toEqual({id, written: 8, closed: false})
    let {text, offset} = await readUntil(id, '\n')
    expect(JSON.parse(text)).toEqual({count: 1, value: 'one two'})
    expect(await json(['write', id, '--stdin'], {}, 'héllo\n')).toEqual({id, written: 7, closed: false})
    ;({text, offset} = await readUntil(id, '\n', offset))
    expect(JSON.parse(text)).toEqual({count: 2, value: 'héllo'})
    for (let n = 0; n < 20; n++) await json(['write', id, '--', `${n}\n`])
    ;({text, offset} = await readUntil(id, '"value":"19"', offset))
    expect(
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).value),
    ).toEqual(Array.from({length: 20}, (_, n) => String(n)))
    expect(await json(['close-input', id])).toEqual({id, written: 0, closed: true})
    expect(await json(['close-input', id])).toEqual({id, written: 0, closed: true})
    const late = await command(['write', id, '--', 'late\n'])
    expect(late.code).toBe(1)
    expect(late.stderr).toMatch(/job input is closed|job has finished/)
    const receipt = await wait(id)
    expect(receipt).toMatchObject({id, lifetime: 'durable', state: 'exited', exitCode: 0})
    expect(receipt.stdout).toContain('bye\n')
    const end = await json(['read', id, 'stdout', String(offset)])
    expect(end).toMatchObject({id, stream: 'stdout', bytes: 4, text: 'bye\n', eof: true, state: 'exited'})
    expect(await command(['write', id, '--', 'x'])).toEqual({stdout: '', stderr: 'job has finished\n', code: 1})
  }, 60000)

  test('the input queue is bounded and a job that is not reading fills it', async () => {
    const id = await startPipe(['/bin/sleep', '60'])
    let refused: {code: number; stderr: string} | undefined
    for (let i = 0; i < 40 && !refused; i++) {
      const r = await command(['write', id, '--stdin'], {}, 'x'.repeat(65536))
      if (r.code !== 0) refused = r
    }
    expect(refused?.code).toBe(1)
    expect(refused?.stderr).toContain('job input queue is full')
    expect((await json(['stop', id])).state).toBe('cancelled')
    active.delete(id)
    expect((await command(['write', id, '--', 'x'])).stderr.trim()).toBe('job has finished')
  }, 60000)

  test('read returns raw bytes of a batch job from any offset, and refuses writes to it', async () => {
    const id = await start(['/bin/sh', '-c', 'printf "héllo wörld"; printf oops >&2'])
    await wait(id)
    expect(await json(['read', id, 'stdout'])).toEqual({id, stream: 'stdout', offset: 0, bytes: 13, omittedBytes: 0, text: 'héllo wörld', next: 13, eof: true, state: 'exited'})
    const middle = await json(['read', '--base64', id, 'stdout', '1', '2'])
    expect(middle).toMatchObject({offset: 1, bytes: 2, data: Buffer.from('é').toString('base64'), next: 3, eof: false})
    expect((await json(['read', id, 'stderr'])).text).toBe('oops')
    expect(await json(['read', '--wait-ms', '50', id, 'stdout', '13'])).toMatchObject({offset: 13, bytes: 0, next: 13, eof: true})
    expect(await command(['write', id, '--', 'x'])).toEqual({stdout: '', stderr: 'job was not started with --input pipe\n', code: 22})
    for (const [args, message] of [
      [['read', id], 'usage: read'],
      [['read', id, 'stdin'], 'stream must be stdout or stderr'],
      [['read', id, 'stdout', 'x'], 'offset must be a byte offset'],
      [['read', id, 'stdout', '0', '65537'], 'max must be an integer from 1 to 65536'],
      [['read', '--wait-ms', '0', id, 'stdout'], '--wait-ms must be an integer from 1 to 300000'],
      [['write', id, '--', 'x'.repeat(65537)], 'write takes at most 65536 characters'],
    ] as [string[], string][]) {
      const r = await command(args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(r.stderr).toContain(message)
    }
  })

  test('a crashed worker is reported, and its input is not replayed', async () => {
    const id = await startPipe(['/bin/cat'])
    const worker = Number(Bun.spawnSync(['/usr/bin/pgrep', '-f', `__job-worker ${id}`]).stdout.toString().trim().split('\n')[0])
    expect(worker).toBeGreaterThan(0)
    process.kill(worker, 'SIGKILL')
    for (let i = 0; i < 100 && !gone(worker); i++) await Bun.sleep(20)
    expect(await json(['status', id])).toMatchObject({state: 'failed', exitCode: null, error: 'worker exited without a terminal receipt'})
    expect(await command(['write', id, '--', 'x'])).toEqual({stdout: '', stderr: 'job has finished\n', code: 1})
    active.delete(id)
  })
})

describe('the storage format marker', () => {
  test('a new home records its format; list never shows the marker', async () => {
    const dir = join(root, 'home-new')
    const started = await json(['start', '5000', '/bin/echo', 'hi'], {JEV_FABRIC_HOME: dir})
    expect(readFileSync(join(dir, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n')
    expect(privateMode(join(dir, '.jev-fabric-store.json'))).toBe(0o600)
    const listed = await json(['list'], {JEV_FABRIC_HOME: dir})
    expect(listed.jobs.map((j: any) => j.id)).toEqual([started.id])
    await json(['wait', started.id, '5000'], {JEV_FABRIC_HOME: dir})
  })

  test('an existing home is adopted by its first writing verb, not by a read', async () => {
    const dir = join(root, 'home-old')
    mkdirSync(dir, {mode: 0o700})
    expect((await command(['list'], {JEV_FABRIC_HOME: dir})).code).toBe(0)
    expect(existsSync(join(dir, '.jev-fabric-store.json'))).toBe(false)
    const started = await json(['start', '5000', '/bin/echo', 'adopted'], {JEV_FABRIC_HOME: dir})
    expect(readFileSync(join(dir, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n')
    await json(['wait', started.id, '5000'], {JEV_FABRIC_HOME: dir})
  })

  test('a home with a newer store is refused by every store verb and never rewritten', async () => {
    const dir = join(root, 'home-newer')
    const first = await json(['start', '5000', '/bin/echo', 'old'], {JEV_FABRIC_HOME: dir})
    await json(['wait', first.id, '5000'], {JEV_FABRIC_HOME: dir})
    const newer = '{"store":2,"note":"written by a later release"}\n'
    writeFileSync(join(dir, '.jev-fabric-store.json'), newer, {mode: 0o600})
    const id = first.id
    for (const args of [
      ['start', '5000', '/bin/echo', 'x'],
      ['status', id],
      ['wait', id, '100'],
      ['stop', id],
      ['events', id],
      ['follow', '100', id],
      ['list'],
      ['write', id, '--', 'x'],
      ['close-input', id],
      ['read', id, 'stdout'],
    ]) {
      const r = await command(args, {JEV_FABRIC_HOME: dir})
      expect(r.code, args.join(' ')).toBe(22)
      expect(r.stderr).toBe('storage home uses store format 2; this jev-fabric supports store format 1 (upgrade jev-fabric to use it)\n')
    }
    expect(readFileSync(join(dir, '.jev-fabric-store.json'), 'utf8')).toBe(newer)
    writeFileSync(join(dir, '.jev-fabric-store.json'), 'not json', {mode: 0o600})
    const r = await command(['list'], {JEV_FABRIC_HOME: dir})
    expect(r.code).toBe(22)
    expect(r.stderr).toContain('not readable')
  })

  test('start takes a cwd and a label; the storage home stays where it was', async () => {
    const work = join(root, 'cwd')
    mkdirSync(work, {recursive: true})
    const real = require('node:fs').realpathSync(work)
    const started = await json(['__start', '5000', 'here', work, 'batch', '/bin/pwd'])
    const receipt = await wait(started.id)
    expect(receipt).toMatchObject({stdout: `${real}\n`, label: 'here', lifetime: 'durable'})
    expect(await command(['__start', '5000', '', join(root, 'missing'), 'batch', '/bin/pwd'])).toEqual({stdout: '', stderr: 'cwd must be an existing directory\n', code: 2})
    expect(await command(['__start', '5000', 'two\nlines', '', 'batch', '/bin/pwd'])).toEqual({stdout: '', stderr: 'label must be 1..120 printable characters on one line\n', code: 2})
  })
})

// Runs last: the store now holds orphans, symlinks and stray files from above.
test('list survives every hostile entry above and reports recovered orphans', async () => {
  const listing = await json(['list'])
  expect(listing.truncated).toBe(false)
  const ids = listing.jobs.map((job: any) => job.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  expect(ids).not.toContain('c'.repeat(32))
  expect(listing.jobs.find((job: any) => job.id === 'd'.repeat(32))).toMatchObject({state: 'failed', exitCode: null})
  for (const job of listing.jobs) expect(['running', 'starting', 'exited', 'failed', 'timed_out', 'cancelled']).toContain(job.state)
  const started = listing.jobs.map((j: any) => j.startedAt ?? 0)
  expect([...started].sort((a, b) => b - a)).toEqual(started)
  expect(listing.jobs.filter((job: any) => job.state === 'running').every((job: any) => active.has(job.id))).toBe(true)
})
