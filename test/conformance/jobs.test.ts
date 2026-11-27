// Durable jobs: `start`, `status`, `wait`, `stop`, `events`, `list`; their
// records, on-disk files, bounds, deadlines, stops and detached workers.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ERRNO, Fixture, JOB_USAGE, Lines, SPOOL, TAIL, expectLine, expectOut, failedJob, finished, gone, jobReceipt, jsonLines, output,
  running, started, streamText, until, vary,
} from './harness.ts';

const fx = new Fixture('jobs');
afterAll(() => fx.cleanup());

const mode = (path: string) => statSync(path).mode & 0o777;
const STUBBORN = 'trap "" TERM; (trap "" TERM; while :; do sleep 0.05; done) & echo $$ $!; while :; do sleep 0.05; done';
const pids = (text: string) => text.trim().split(/\s+/).map(Number);
const NOT_FOUND = 'native private job operation failed\n';

// One job that prints 100 separate lines, so its 64-event ring has evicted the oldest.
const ring = fx.store();
let ringId = '';
beforeAll(async () => {
  ringId = await ring.start(['/bin/sh', '-c', 'i=0; while [ $i -lt 100 ]; do printf "x$i\\n"; sleep 0.03; i=$((i+1)); done']);
  await ring.wait(ringId, 20000);
}, 30000);

describe.concurrent('jobs', () => {
  test('start, status, wait, events and stop print exact records', async () => {
    const s = fx.store();
    const release = join(fx.root, 'lifecycle-release');
    const label = 'dev server 🙂 "quoted"';
    const id = await s.start(['--label', label, '/bin/sh', '-c',
      'printf "first\\n"; while [ ! -f "$1" ]; do sleep 0.02; done; printf "second\\n"', 'sh', release]);
    const state = running(id, { label });
    expectOut(await s.ok(['status', id]), [state]);
    expectOut(await s.ok(['wait', '--timeout-ms', '50', id]), [state]);
    expect(await until(async () => streamText(await s.events(id)) === 'first\n')).toBe(true);
    expectOut(await s.ok(['events', id]), [started(1, id), output(2, 'stdout', 0, 'first\n')]);
    writeFileSync(release, 'go');
    const receipt = jobReceipt(id, { label, state: 'exited', exitCode: 0, stdout: 'first\nsecond\n' });
    const waited = await s.run(['wait', id]);
    expect([waited.code, waited.err]).toEqual([0, '']);
    expectOut(waited.out, [receipt]);
    const events = [started(1, id), output(2, 'stdout', 0, 'first\n'), output(3, 'stdout', 6, 'second\n'), finished(4)];
    expectOut(await s.ok(['events', id]), events);
    expectOut(await s.ok(['events', id, '2']), events.slice(2));
    expect(await s.ok(['events', id, '4'])).toBe('');
    expect(await s.ok(['events', id, '99'])).toBe('');
    expectOut(await s.ok(['status', id]), [receipt]);
    expectOut(await s.ok(['stop', id]), [receipt]);
    expectOut(await s.ok(['wait', id]), [receipt]);
  });

  test('the job directory holds the documented private files, byte-compatible with the records', async () => {
    const s = fx.store();
    const id = await s.start(['--label', 'files', '/bin/sh', '-c', 'printf "out\\n"; printf err >&2']);
    const receipt = await s.ok(['wait', id]);
    expect(mode(s.home)).toBe(0o700);
    const dir = join(s.home, id);
    expect(mode(dir)).toBe(0o700);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['.lease', 'events.jsonl', 'meta.json', 'ready', 'receipt.json', 'result.json', 'stderr.bin', 'stdout.bin']);
    for (const name of names) expect(mode(join(dir, name)), name).toBe(0o600);
    expectLine(readFileSync(join(dir, 'meta.json'), 'utf8'), { schemaVersion: 1, startedAt: vary.time(), label: 'files', lifetime: 'durable' });
    expect(readFileSync(join(dir, 'receipt.json'), 'utf8') + '\n').toBe(receipt);
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe(await s.ok(['events', id]));
    expect(readFileSync(join(dir, 'stdout.bin'), 'utf8')).toBe('out\n');
    expect(readFileSync(join(dir, 'stderr.bin'), 'utf8')).toBe('err');
    expect(readFileSync(join(s.home, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n');
    // A job without a label has no label member anywhere.
    const plain = await s.start(['/bin/echo', 'plain']);
    expectOut(await s.ok(['wait', plain]), [jobReceipt(plain, { state: 'exited', exitCode: 0, stdout: 'plain\n' })]);
    expectLine(readFileSync(join(s.home, plain, 'meta.json'), 'utf8'), { schemaVersion: 1, startedAt: vary.time(), lifetime: 'durable' });
  });

  test('labels are 1..120 printable characters on one line; start rejects bad options with code 2', async () => {
    const s = fx.store();
    const literal = await s.start(['--label', 'x'.repeat(120), '--', '/bin/echo', '--label']);
    expect(await s.wait(literal)).toMatchObject({ label: 'x'.repeat(120), stdout: '--label\n' });
    const label = 'label must be 1..120 printable characters on one line';
    const timeout = 'timeout must be an integer within the operation limit';
    const cases: [string[], string][] = [
      ...['', 'x'.repeat(121), 'two\nlines', 'tab\there', 'bell\u0007', 'del\u007f', 'c1\u0085', 'sep ', 'par ']
        .map((bad): [string[], string] => [['start', '--label', bad, '/bin/echo'], label]),
      [['start', '--label', 'a', '--label', 'b', '/bin/echo'], 'specify the label only once'],
      [['start', '--label'], '--label requires text'],
      [['start'], 'command or file is required'],
      [['start', '--timeout-ms', '0', '/bin/echo'], timeout],
      [['start', '--timeout-ms', '86400001', '/bin/echo'], timeout],
      [['start', '86400001', '/bin/echo'], timeout],
      [['start', '-1', '/bin/echo'], 'unknown option; use -- before a literal command'],
      [['start', '--stdin', '/bin/echo'], '--stdin is supported once, for exec only'],
      [['start', '--input', 'file', '/bin/cat'], '--input takes pipe'],
      [['start', '--cwd', 'relative', '/bin/pwd'], 'cwd must be an absolute path'],
      [['start', '--cwd', join(fx.root, 'missing'), '/bin/pwd'], 'cwd must be an existing directory'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, message]) => [args, 2, '', message]));
  });

  test('a lifetime may be a day; wait and its configuration only bound observation', async () => {
    const s = fx.store();
    const id = await s.start(['--timeout-ms', '86400000', '/bin/sleep', '30']);
    const r = await s.run(['wait', id], { env: { JEV_FABRIC_WAIT_MS: '40' } });
    expect(r.code).toBe(0);
    expectOut(r.out, [running(id)]);
    expect(r.ms).toBeLessThan(2000);
    expectOut(await s.ok(['wait', id, '40']), [running(id)]);
    const errors = [
      await s.run(['wait', id], { env: { JEV_FABRIC_WAIT_MS: 'invalid' } }),
      await s.run(['wait', '--timeout-ms', '3600001', id]),
      await s.run(['wait', '--timeout-ms', '0', id]),
    ];
    expect(errors.map(e => [e.code, e.err.trim()])).toEqual(Array(3).fill([2, 'timeout must be an integer within the operation limit']));
    expectOut(await s.ok(['status', id]), [running(id)]);
    const stopped = await s.json(['stop', id]);
    expect(stopped).toMatchObject({ id, state: 'cancelled', cancelled: true, exitCode: 143 });
  });

  test('a deadline kills the job’s whole process group at once and records timed_out', async () => {
    const s = fx.store();
    const id = await s.start(['--timeout-ms', '400', '/bin/sh', '-c', STUBBORN]);
    const receipt = await s.wait(id);
    expect(receipt).toEqual(jobReceipt(id, { state: 'timed_out', exitCode: 124, stdout: receipt.stdout }));
    const [child, grandchild] = pids(receipt.stdout);
    expect(child).toBeGreaterThan(1);
    expect(await until(() => gone(child!) && gone(grandchild!), 1000)).toBe(true);
  });

  test('stop sends SIGTERM then SIGKILL after 500 ms to the group; concurrent and repeated stops agree', async () => {
    const s = fx.store();
    const id = await s.start(['--label', 'stubborn', '/bin/sh', '-c', STUBBORN]);
    expect(await until(async () => /^\d+ \d+\n$/.test(streamText(await s.events(id))), 5000)).toBe(true);
    const [child, grandchild] = pids(streamText(await s.events(id)));
    const begin = performance.now();
    const [a, b] = await Promise.all([s.run(['stop', id]), s.run(['stop', id])]);
    const elapsed = performance.now() - begin;
    expect([a.code, b.code]).toEqual([0, 0]);
    const receipt = jobReceipt(id, { label: 'stubborn', state: 'cancelled', exitCode: 143, stdout: `${child} ${grandchild}\n` });
    expectOut(a.out, [receipt]);
    expect(b.out).toBe(a.out);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(5000);
    expect(gone(child!) && gone(grandchild!)).toBe(true);
    expect(await s.ok(['status', id])).toBe(a.out);
    expect(await s.ok(['stop', id])).toBe(a.out);
    const events = await s.events(id);
    expect(events.at(-1)).toEqual(finished(events.length));
  });

  test('a detached worker survives its caller being killed and keeps the job running', async () => {
    const s = fx.store();
    const release = join(fx.root, 'survivor-release');
    // The caller runs start, then lingers; killing its whole process group must not touch the job.
    const caller = fx.track(Bun.spawn(['/bin/sh', '-c', `"$0" -- start /bin/sh -c 'while [ ! -f "$1" ]; do sleep 0.02; done; echo survived' sh '${release}'; exec sleep 60`, s.bin], {
      env: s.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true,
    }));
    const first = await new Lines(caller.stdout).json();
    const id = first?.id as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    s.started.add(id);
    expect(await until(async () => (await s.json(['status', id])).state === 'running', 5000)).toBe(true);
    process.kill(-caller.pid, 'SIGKILL');
    await caller.exited;
    await Bun.sleep(100);
    expectOut(await s.ok(['status', id]), [running(id)]);
    writeFileSync(release, 'go');
    expect(await s.wait(id)).toEqual(jobReceipt(id, { state: 'exited', exitCode: 0, stdout: 'survived\n' }));
  });

  test('start returns at once: the worker holds none of the caller’s descriptors', async () => {
    const s = fx.store();
    const begin = performance.now();
    // run() reads stdout and stderr to EOF: a worker that kept them open would hang this.
    const id = await s.start(['/bin/sleep', '30']);
    expect(performance.now() - begin).toBeLessThan(5000);
    expectOut(await s.ok(['status', id]), [running(id)]);
    // The worker is the child's parent and leads a process group of its own.
    const probe = await s.start(['/bin/sh', '-c', 'ps -o pgid= -p $PPID; ps -o pgid= -p $$; echo $PPID $$']);
    const lines = (await s.wait(probe)).stdout.trim().split('\n').map((x: string) => x.trim());
    const [workerGroup, childGroup, ids] = lines;
    const [worker, child] = pids(ids!);
    expect(Number(workerGroup)).toBe(worker!);
    expect(Number(childGroup)).toBe(child!);
    await s.run(['stop', id]);
  });

  test('the worker re-enters the executable with no Node, Bun or tools on PATH', async () => {
    const s = fx.store({ PATH: join(fx.root, 'no-tools') });
    const id = await s.start(['/bin/echo', 'native']);
    expect((await s.wait(id)).stdout).toBe('native\n');
  });

  test('a command that cannot launch gets a sanitized failed receipt; a nonzero exit keeps its code', async () => {
    const s = fx.store();
    const id = await s.start(['/nonexistent/SYNTHETIC_NOT_A_REAL_SECRET']);
    expectOut(await s.ok(['wait', id]), [failedJob(id, 'command launch failed')]);
    expectOut(await s.ok(['events', id]), [started(1, id), finished(2)]);
    const nonzero = await s.start(['--label', 'n', '/bin/sh', '-c', 'printf error >&2; exit 7']);
    expectOut(await s.ok(['wait', nonzero]), [jobReceipt(nonzero, { label: 'n', state: 'failed', exitCode: 7, stderr: 'error' })]);
  });

  test('spools keep the first 1 MiB per stream, receipts the last 32 KiB, events disclose both', async () => {
    const s = fx.store();
    const flood = (ch: string) => `head -c 1400000 /dev/zero | tr '\\000' ${ch}`;
    const id = await s.start(['/bin/sh', '-c', `printf A; ${flood('a')}; printf Z; printf B >&2; ${flood('b')} >&2; printf Y >&2`]);
    const receipt = await s.wait(id, 20000);
    expect(receipt).toEqual(jobReceipt(id, {
      state: 'exited', exitCode: 0, stdout: 'a'.repeat(TAIL - 1) + 'Z', stderr: 'b'.repeat(TAIL - 1) + 'Y',
      truncated: { stdout: true, stderr: true },
    }));
    const stdout = readFileSync(join(s.home, id, 'stdout.bin'));
    expect(stdout.length).toBe(SPOOL);
    expect(stdout.subarray(0, 2).toString()).toBe('Aa');
    expect(statSync(join(s.home, id, 'stderr.bin')).size).toBe(SPOOL);
    const events = await s.events(id);
    expect(events.length).toBeLessThanOrEqual(64);
    for (let i = 1; i < events.length; i++) expect(events[i].sequence).toBe(events[i - 1].sequence + 1);
    expect(events.filter(e => e.type === 'process.spool_limit').map(e => e.data).sort((x, y) => x.stream.localeCompare(y.stream)))
      .toEqual(['stderr', 'stdout'].map(stream => ({ stream, limitBytes: SPOOL, mayBeTruncated: true })));
    const outputs = events.filter(e => e.type === 'process.output');
    for (const { data } of outputs) {
      expect(Object.keys(data)).toEqual(['stream', 'offset', 'bytes', 'omittedBytes', 'text']);
      expect(data.bytes).toBeLessThanOrEqual(2048);
      expect(data.offset + data.bytes).toBeLessThanOrEqual(SPOOL);
    }
    expect(outputs.some(e => e.data.omittedBytes > 0)).toBe(true);
    expect(events.at(-1)).toEqual(finished(events.at(-1).sequence));
    expect(statSync(join(s.home, id, 'events.jsonl')).size).toBeLessThan(SPOOL);
  }, 30000);

  test('64 events are retained: the oldest are evicted and sequences stay contiguous', async () => {
    const events = await ring.events(ringId);
    expect(events.length).toBe(64);
    expect(events[0].sequence).toBeGreaterThan(1);
    for (let i = 1; i < events.length; i++) expect(events[i].sequence).toBe(events[i - 1].sequence + 1);
    expect(events.at(-1)).toEqual(finished(events.at(-1).sequence));
    expect(streamText(events).endsWith('x98\nx99\n')).toBe(true);
    // A cursor below the window returns the whole window.
    expect(await ring.events(ringId, 1)).toEqual(events);
    const receipt = await ring.wait(ringId);
    expect(receipt.stdout).toBe(Array.from({ length: 100 }, (_, i) => `x${i}\n`).join(''));
  });

  test('output events coalesce per tick, match the spool by offset and account for omitted bytes', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'i=0; while [ "$i" -lt 40 ]; do printf "line %s\\n" "$i"; sleep 0.01; i=$((i+1)); done']);
    await s.wait(id);
    const spool = readFileSync(join(s.home, id, 'stdout.bin'), 'utf8');
    const chunks = (await s.events(id)).filter(e => e.type === 'process.output');
    expect(chunks.length).toBeGreaterThan(1);
    let next = 0;
    for (const { data } of chunks) {
      expect(data.text).toBe(spool.slice(data.offset, data.offset + data.bytes));
      expect(data.offset).toBe(next + data.omittedBytes);
      next = data.offset + data.bytes;
    }
  });

  test('a UTF-8 character split across writes is joined; a partial one at EOF and malformed bytes become U+FFFD', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', "printf '\\360\\237'; sleep 0.15; printf '\\231\\202'; sleep 0.1; printf '\\360\\237'"]);
    await s.wait(id);
    expect(streamText(await s.events(id))).toBe('🙂�');
    const bad = await s.start(['/bin/sh', '-c', "printf '\\377A\\355\\240\\200B'"]);
    await s.wait(bad);
    // Oracle 0.8.1: events replace this invalid sequence with one U+FFFD (exec receipts use three).
    expect(streamText(await s.events(bad))).toBe('\uFFFDA\uFFFDB');
  });

  test('a worker that died without a receipt is reported failed; status writes the recovery receipt, list does not', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'echo $PPID $$; exec sleep 60']);
    expect(await until(async () => /^\d+ \d+\n$/.test(streamText(await s.events(id))), 5000)).toBe(true);
    const [worker, child] = pids(streamText(await s.events(id))) as [number, number];
    process.kill(worker, 'SIGKILL');
    expect(await until(() => gone(worker), 2000)).toBe(true);
    const listed = await s.json(['list']);
    expect(listed.jobs).toEqual([{ id, state: 'failed', startedAt: listed.jobs[0].startedAt, exitCode: null }]);
    expect(existsSync(join(s.home, id, 'receipt.json'))).toBe(false);
    const receipt = failedJob(id, 'worker exited without a terminal receipt');
    expectOut(await s.ok(['status', id]), [receipt]);
    expect(existsSync(join(s.home, id, 'receipt.json'))).toBe(true);
    expectOut(await s.ok(['stop', id]), [receipt]);
    expectOut(await s.ok(['wait', id]), [receipt]);
    // A recovered receipt does not synthesize the missing final event.
    expect((await s.events(id)).some(e => e.type === 'job.finished')).toBe(false);
    // The orphaned child is not resumed or adopted; clean it up here.
    process.kill(child, 'SIGKILL');
  });

  test('an orphan directory without a live lease becomes a stable failed receipt; stale PIDs are never trusted', async () => {
    const s = fx.store();
    await s.ok(['list']);
    const id = 'd'.repeat(32);
    const dir = join(s.home, id);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'ready'), 'ready', { mode: 0o600 });
    writeFileSync(join(dir, 'pid'), String(process.pid), { mode: 0o600 });
    expect(await s.json(['list'])).toEqual({ jobs: [{ id, state: 'failed', exitCode: null }], truncated: false });
    const receipt = failedJob(id, 'worker exited without a terminal receipt');
    expectOut(await s.ok(['status', id]), [receipt]);
    expectOut(await s.ok(['stop', id]), [receipt]);
    expectLine(readFileSync(join(dir, 'receipt.json'), 'utf8'), receipt);
    expect(gone(process.pid)).toBe(false);
  });

  test('ids are checked before any access: traversal, malformed and unknown ids fail closed', async () => {
    const s = fx.store();
    await s.ok(['list']);
    const verbs = (id: string) => [['status', id], ['stop', id], ['wait', '--timeout-ms', '10', id], ['events', id],
      ['follow', '--timeout-ms', '10', id], ['watch', '--timeout-ms', '10', id, 'x'], ['read', id, 'stdout'],
      ['write', id, '--', 'x'], ['close-input', id]];
    const ids: [string, number][] = [
      ['../outside', 22], ['.', 22], ['/etc', 22], ['A'.repeat(32), 22], ['a'.repeat(31), 22], ['b'.repeat(33), 22],
      ['b'.repeat(32), 2],
    ];
    const actual = [];
    const expected = [];
    for (const [id, code] of ids) {
      for (const args of verbs(id)) {
        const r = await s.run(args);
        actual.push([args, r.code, r.out, r.err]);
        expected.push([args, code, '', NOT_FOUND]);
      }
    }
    expect(actual).toEqual(expected);
    // An id that looks like an option is never treated as a job (2 or 22, depending on the verb's parser).
    for (const args of verbs('-x')) {
      const r = await s.run(args);
      expect([2, 22], args.join(' ')).toContain(r.code);
      expect(r.out).toBe('');
    }
    const usage = [['status'], ['status', 'a', 'b'], ['stop'], ['list', 'x']];
    const usages = [];
    for (const args of usage) usages.push([args, ...Object.values(await s.run(args)).slice(0, 3)]);
    expect(usages).toEqual(usage.map(args => [args, '', `${JOB_USAGE}\n`, 2]));
    expect(await s.run(['events'])).toMatchObject({ code: 2, out: '', err: 'usage: events [--timeout-ms N] <id> [after-sequence]\n' });
    const events = await s.run(['events', 'b'.repeat(32), 'oops']);
    expect([events.code, events.err]).toEqual([2, 'after-sequence must be a U32\n']);
  });

  test('symlinked roots and job directories and unsafe receipt files are refused without being followed', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/echo', 'safe']);
    const receipt = await s.ok(['wait', id]);
    // A symlinked storage root.
    const target = join(fx.root, 'link-target');
    mkdirSync(target, { mode: 0o700 });
    const alias = join(fx.root, 'root-alias');
    symlinkSync(target, alias);
    const aliased = fx.store({}, undefined, alias);
    // Oracle 0.8.1 exits ENOTDIR (not 22) for a symlinked root.
    for (const args of [['start', '/bin/echo'], ['list'], ['status', 'c'.repeat(32)]]) {
      expect(await aliased.run(args)).toMatchObject({ code: ERRNO.ENOTDIR, out: '', err: NOT_FOUND });
    }
    expect(readdirSync(target)).toEqual([]);
    // A symlinked job directory.
    const linked = 'c'.repeat(32);
    symlinkSync(target, join(s.home, linked));
    expect(await s.run(['status', linked])).toMatchObject({ code: ERRNO.ENOTDIR, out: '', err: NOT_FOUND });
    expect(readdirSync(target)).toEqual([]);
    // A symlinked, oversized or world-readable receipt.
    const path = join(s.home, id, 'receipt.json');
    const text = readFileSync(path, 'utf8');
    const outside = join(fx.root, 'untouched');
    writeFileSync(outside, 'unchanged', { mode: 0o600 });
    const codes: [string, number, string, string][] = [];
    unlinkSync(path);
    symlinkSync(outside, path);
    for (const verb of ['status', 'stop']) {
      const r = await s.run([verb, id]);
      codes.push([`symlink ${verb}`, r.code, r.out, r.err]);
    }
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    unlinkSync(path);
    writeFileSync(path, 'x'.repeat(1048577), { mode: 0o600 });
    let r = await s.run(['status', id]);
    codes.push(['oversized', r.code, r.out, r.err]);
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o644);
    r = await s.run(['status', id]);
    codes.push(['world-readable', r.code, r.out, r.err]);
    // Oracle 0.8.1 exits with the errno of the failing check, not 22 as the docs say.
    expect(codes).toEqual([
      ['symlink status', ERRNO.ELOOP, '', NOT_FOUND], ['symlink stop', ERRNO.ELOOP, '', NOT_FOUND],
      ['oversized', ERRNO.EFBIG, '', NOT_FOUND], ['world-readable', ERRNO.EPERM, '', NOT_FOUND],
    ]);
    chmodSync(path, 0o600);
    expect(await s.ok(['status', id])).toBe(receipt);
  });

  test('list: newest first, labels and exit codes, skipping files, foreign, unsafe and symlinked entries', async () => {
    const s = fx.store();
    expectOut(await s.ok(['list']), [{ jobs: [], truncated: false }]);
    const done = await s.start(['--label', 'done', '/bin/sh', '-c', 'exit 3']);
    await s.wait(done);
    await Bun.sleep(5);
    const live = await s.start(['--label', 'live', '/bin/sleep', '30']);
    await Bun.sleep(5);
    const plain = await s.start(['/bin/echo', 'plain']);
    await s.wait(plain);
    writeFileSync(join(s.home, 'notes.txt'), 'x', { mode: 0o600 });
    mkdirSync(join(s.home, 'f'.repeat(32)), { mode: 0o700 });
    mkdirSync(join(s.home, '1'.repeat(32)), { mode: 0o755 });
    writeFileSync(join(s.home, '1'.repeat(32), 'receipt.json'), '{}', { mode: 0o600 });
    symlinkSync(join(s.home, done), join(s.home, '2'.repeat(32)));
    mkdirSync(join(s.home, 'not-a-job'), { mode: 0o700 });
    const r = await s.run(['list']);
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [{
      jobs: [
        { id: plain, state: 'exited', startedAt: vary.time(), exitCode: 0 },
        { id: live, state: 'running', label: 'live', startedAt: vary.time() },
        { id: done, state: 'failed', label: 'done', startedAt: vary.time(), exitCode: 3 },
      ],
      truncated: false,
    }]);
    const jobs = JSON.parse(r.out).jobs;
    expect(jobs[0].startedAt).toBeGreaterThanOrEqual(jobs[1].startedAt);
    expect(jobs[1].startedAt).toBeGreaterThanOrEqual(jobs[2].startedAt);
    await s.ok(['stop', live]);
    const after = JSON.parse(await s.ok(['list'])).jobs;
    expect(after[1]).toEqual({ id: live, state: 'cancelled', label: 'live', startedAt: jobs[1].startedAt, exitCode: 143 });
  });
});
