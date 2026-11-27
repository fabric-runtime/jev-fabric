// The supervisor (native/tests/process.test.ts, io.bend and fail-fast.bend):
// literal argv, own process groups, deadlines, bounded tails, spools,
// cancellation and reaping.

import {afterAll, describe, expect, test} from 'bun:test'
import {closeSync, existsSync, openSync, readFileSync, rmSync, statSync} from 'node:fs'
import {join} from 'node:path'
import * as Host from '../store/host.ts'
import * as SpoolCore from '../spool/core.ts'
import {capture as run, gone, probe, tempRoot} from './helpers.test-util.ts'
import * as P from './process.ts'
import * as R from './report.ts'

const root = tempRoot('proc-test-')
afterAll(() => rmSync(root, {recursive: true, force: true}))

const ok = <T>(r: {ok: true; value: T} | {ok: false; error: unknown}): T => {
  if (!r.ok) throw new Error(`failed: ${JSON.stringify(r.error)}`)
  return r.value
}

describe('native POSIX boundary', () => {
  test('literal argv, Unicode and JSON escaping', async () => {
    const marker = join(root, 'not-executed')
    const text = `🙂\n\t"\\ $(touch ${marker}); $HOME`
    const r = ok(await P.runInput(['/bin/sh', '-c', 'printf "%s" "$1"', 'sh', text], '', 2000))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(text)
    expect(R.state(r.code, r.timedOut, r.cancelled)).toBe('exited')
    expect(existsSync(marker)).toBe(false)
    expect(JSON.parse(R.show(r)).stdout).toBe(text)
    expect(R.show(r)).toContain('\\u000a\\u0009')
  })

  test('explicit shells support heredocs and pipelines', async () => {
    const r = ok(await P.runInput(['/bin/sh', '-c', "cat <<'TEXT' | tr a-z A-Z\nhello native\nTEXT"], '', 2000))
    expect(r.stdout).toBe('HELLO NATIVE\n')
  })

  test('stdin passes directly through, including data larger than the capture cap', async () => {
    const r = await run(['bun', probe, 'exec', '2000', 'stdin', '/bin/sh', '-c', 'wc -c'], {input: 'x'.repeat(200_000)})
    expect(r.code, r.err).toBe(0)
    expect(Number(JSON.parse(r.out).stdout.trim())).toBe(200_000)
  })

  test('separate stderr and a nonzero exit remain receipts', async () => {
    const r = ok(await P.runInput(['/bin/sh', '-c', 'printf out; printf err >&2; exit 7'], '', 2000))
    expect(JSON.parse(R.show(r))).toMatchObject({state: 'failed', exitCode: 7, stdout: 'out', stderr: 'err'})
  })

  test('output tails disclose truncation', async () => {
    const r = ok(await P.runInput(['/bin/sh', '-c', "head -c 100000 /dev/zero | tr '\\000' x; printf END"], '', 2000))
    expect(r.stdout.length).toBe(32768)
    expect(r.stdout.endsWith('END')).toBe(true)
    expect([r.stdoutCut, r.stderrCut]).toEqual([true, false])
  })

  test('text tails decode as 0.8.1 did: each malformed byte is one replacement, a cut character too', async () => {
    const r = ok(await P.exec(['/bin/sh', '-c', "printf '1\\340\\200\\2002\\364\\220\\200\\2003\\300\\2004\\377'"], '', 2000))
    expect(r.stdout).toBe('1���2����3��4�')
    const cut = ok(await P.exec(['/bin/sh', '-c', "printf '\\303\\251'; head -c 32767 /dev/zero | tr '\\000' x"], '', 2000))
    expect(cut.stdout.startsWith('�x')).toBe(true)
    const bom = ok(await P.exec(['/bin/sh', '-c', "printf '\\357\\273\\277A'"], '', 2000))
    expect(bom.stdout).toBe('﻿A')
  })

  test('a deadline kills and reaps the whole group', async () => {
    const r = ok(await P.runInput(['/bin/sh', '-c', 'printf "%s\\n" "$$"; exec sleep 60'], '', 100))
    expect(r.code).toBe(124)
    expect(R.state(r.code, r.timedOut, r.cancelled)).toBe('timed_out')
    expect(gone(Number(r.stdout.trim()))).toBe(true)
  })

  test('the child leads its own process group, and escaped descendants go with it', async () => {
    const marker = join(root, 'escaped')
    const r = ok(await P.runInput(['/bin/sh', '-c', 'ps -o pid=,pgid= -p $$; (sleep 0.3; touch "$1") & echo', 'sh', marker], '', 2000))
    const [pid, pgid] = r.stdout.trim().split('\n')[0]!.trim().split(/\s+/)
    expect(pid).toBe(pgid)
    expect(pgid).not.toBe(String(process.pid))
    await Bun.sleep(500)
    expect(existsSync(marker)).toBe(false)
  })

  test('an escaped daemon holding a pipe is cut after a 100 ms drain, not waited for', async () => {
    const started = performance.now()
    const r = ok(await P.runInput(['/bin/sh', '-c', "perl -e 'setpgrp(0,0); sleep 2' & sleep 0.3; printf done"], '', 5000))
    expect(r.stdout).toBe('done')
    expect(r.stdoutCut).toBe(true)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  test('SIGINT cancels owned work without exposing a live child', async () => {
    const marker = join(root, 'started')
    const script = 'printf "%s\\n" "$$"; : > "$1"; exec sleep 60'
    const p = Bun.spawn(['bun', probe, 'exec', '60000', 'none', '/bin/sh', '-c', script, 'sh', marker], {stdout: 'pipe', stderr: 'pipe'})
    for (let i = 0; i < 300 && !existsSync(marker); i++) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    p.kill('SIGINT')
    const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    const r = JSON.parse(stdout)
    expect(code).toBe(130)
    expect(r).toMatchObject({state: 'cancelled', cancelled: true, exitCode: 130})
    expect(gone(Number(r.stdout.trim()))).toBe(true)
  })

  test('cancel() is sticky: running children are cancelled and later ones never start', async () => {
    const r = await run(['bun', probe, 'cancelled'])
    expect(r.code, r.err).toBe(0)
    const [report, later] = r.out.trim().split('\n')
    expect(JSON.parse(report!)).toMatchObject({state: 'cancelled', exitCode: 143, cancelled: true})
    expect(gone(Number(JSON.parse(report!).stdout.trim()))).toBe(true)
    expect(later).toBe(`refused:${(await import('../sys/libc.ts')).E.EINTR}`)
  })

  test('failed launch is sanitized and argv is bounded', async () => {
    const secret = 'SYNTHETIC_NOT_A_REAL_SECRET'
    const missing = await P.runInput([`/nonexistent/${secret}`], '', 1000)
    expect(missing.ok).toBe(false)
    expect(JSON.stringify(missing)).not.toContain(secret)
    expect(missing).toEqual({ok: false, error: {code: 2, message: 'native subprocess request failed'}})
    expect((await P.runInput(['/bin/echo', 'x'.repeat(4097)], '', 1000)).ok).toBe(false)
    expect((await P.runInput(['/bin/echo', ...Array(64).fill('x')], '', 1000)).ok).toBe(false)
    expect((await P.runInput(['/bin/echo', ...Array(63).fill('x')], '', 1000)).ok).toBe(true)
    expect((await P.runInput([], '', 1000)).ok).toBe(false)
    expect((await P.runInput([''], '', 1000)).ok).toBe(false)
    expect((await P.runInput(['/bin/echo'], '', 0)).ok).toBe(false)
    expect((await P.runInput(['/bin/echo'], '', 3600001)).ok).toBe(false)
    expect((await P.runInput(['/bin/cat'], 'x'.repeat(131073), 1000)).ok).toBe(false)
    expect((await P.runIn(['/bin/pwd'], '', 1000, false, 'relative')).ok).toBe(false)
  })

  test('cwd starts the child elsewhere without moving this process', async () => {
    const r = ok(await P.runIn(['/bin/pwd'], '', 1000, false, root))
    expect(r.stdout.trim()).toBe(require('node:fs').realpathSync(root))
    expect(process.cwd()).not.toBe(root)
    expect((await P.runIn(['/bin/pwd'], '', 1000, false, join(root, 'missing'))).ok).toBe(false)
  })

  test('forks overlap on the event loop, and buffered stdin works', async () => {
    const r = await run(['bun', probe, 'io', join(root, 'overlap')])
    expect({code: r.code, err: r.err}).toEqual({code: 0, err: ''})
    expect(r.out).toContain('native IO assertions: 3')
  })

  test('SIGCHLD is listened for only while children run, and overlapping children share it', async () => {
    const before = process.listenerCount('SIGCHLD')
    const long = P.runInput(['/bin/sh', '-c', 'sleep 0.3; echo long'], '', 5000)
    expect(process.listenerCount('SIGCHLD')).toBe(before + 1)
    const short = ok(await P.runInput(['/bin/sh', '-c', 'echo short'], '', 5000))
    expect(short.stdout).toBe('short\n')
    // The long child still runs: the listener stays until the last one ends.
    expect(process.listenerCount('SIGCHLD')).toBe(before + 1)
    expect(ok(await long).stdout).toBe('long\n')
    expect(process.listenerCount('SIGCHLD')).toBe(before)
  })

  test('a failure that ends this process reaps the owned work still running', async () => {
    const marker = join(root, 'abort-child')
    const r = await run(['bun', probe, 'fail-fast', marker])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('native subprocess request failed')
    expect(gone(Number(readFileSync(marker, 'utf8').trim()))).toBe(true)
  })

  test('capture is byte-exact and discloses its cut', async () => {
    const c = ok(await P.capture(['/bin/sh', '-c', "printf '\\000\\377\\012'; printf e >&2"], '', 1000, 3))
    expect([...c.stdout]).toEqual([0, 255, 10])
    expect(c.flags).toBe(0)
    const cut = ok(await P.capture(['/bin/sh', '-c', 'printf abcdef'], '', 1000, 4))
    expect(new TextDecoder().decode(cut.stdout)).toBe('cdef')
    expect(cut.flags & R.STDOUT_CUT).toBe(R.STDOUT_CUT)
    const aborted = new AbortController()
    const pending = P.capture(['/bin/sleep', '5'], '', 5000, 16, aborted.signal)
    await Bun.sleep(50)
    aborted.abort()
    const a = ok(await pending)
    expect(a.flags & R.CANCELLED).toBe(R.CANCELLED)
    expect(a.code).toBe(143)
  })

  test('logged spools keep the first 1 MiB; rolling spools the latest 1 MiB behind their header', async () => {
    process.env.JEV_FABRIC_HOME = join(root, 'store')
    const id = ok(Host.make(1024))
    const out = ok(Host.spool(id, 'stdout.bin', true))
    const err = ok(Host.spool(id, 'stderr.bin', true))
    const r = ok(await P.execLogged(['/bin/sh', '-c', 'head -c 1400000 /dev/zero; printf e >&2'], 5000, out, err))
    expect(r.code).toBe(0)
    expect(statSync(join(root, 'store', id, 'stdout.bin')).size).toBe(1048576)
    expect(readFileSync(join(root, 'store', id, 'stderr.bin'), 'utf8')).toBe('e')

    const ringOut = ok(Host.spool(id, 'stdout.ring', true))
    const ringErr = ok(Host.spool(id, 'stderr.ring', true))
    const [reader, writer] = ok(P.pipe())
    closeSync(writer)
    const script = "head -c 1048570 /dev/zero; printf 'abcdefghijklmnop'"
    ok(await P.execPipe(['/bin/sh', '-c', script], reader, 5000, ringOut, ringErr, true))
    const ring = readFileSync(join(root, 'store', id, 'stdout.ring'))
    expect(ring.length).toBe(16 + 1048576)
    expect(SpoolCore.head(ring)).toEqual({count: 1048586, closed: true})
    // Byte N lives at 16 + N mod 1 MiB: the last ten wrapped to the start of the ring.
    expect(ring.subarray(16, 26).toString()).toBe('ghijklmnop')
    expect(ring.subarray(16 + 1048570, 16 + 1048576).toString()).toBe('abcdef')
    expect(SpoolCore.head(readFileSync(join(root, 'store', id, 'stderr.ring')))).toEqual({count: 0, closed: true})
    // A rejected request still consumes and marks its spools.
    const rejOut = ok(Host.spool(id, 'rejected.ring', true))
    const rejErr = ok(Host.spool(id, 'rejected-err.ring', true))
    const [r2, w2] = ok(P.pipe())
    closeSync(w2)
    expect((await P.execPipe([], r2, 1000, rejOut, rejErr, true)).ok).toBe(false)
    expect(SpoolCore.head(readFileSync(join(root, 'store', id, 'rejected.ring')))).toEqual({count: 0, closed: true})
    expect(() => closeSync(rejOut)).toThrow()
  })

  test('run_logged keeps the hour; the effect admits a day only for workers', async () => {
    const devnull = () => openSync('/dev/null', 'w')
    expect(await P.runLogged(['/bin/echo'], 3600001, devnull(), devnull())).toEqual({ok: false, error: {code: 22, message: 'run_logged timeout must be 1..3600000 milliseconds'}})
  })
})
