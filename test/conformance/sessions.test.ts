// serve session children: `spawn`, `write`, `closeInput`, `read`, rolling
// windows, session listings and their end with the connection.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Fixture, SPOOL, Serve, expectLine, failedJob, gone, jobReceipt, running, serve, until } from './harness.ts';

const fx = new Fixture('sessions');
afterAll(() => fx.cleanup());

const readRecord = (id: string, r: { offset: number; text?: string; data?: string; bytes?: number; omittedBytes?: number; next: number; eof: boolean; state: string; stream?: string }) => ({
  id, stream: r.stream ?? 'stdout', offset: r.offset, bytes: r.bytes ?? Buffer.byteLength(r.text ?? ''),
  omittedBytes: r.omittedBytes ?? 0, ...(r.data === undefined ? { text: r.text ?? '' } : { data: r.data }),
  next: r.next, eof: r.eof, state: r.state,
});

/** Reads a stream from `from` until `want` appears or it ends, following `next`. */
async function readUntil(c: Serve, job: string, want: string, from = 0) {
  let text = '';
  let offset = from;
  for (let i = 0; i < 200 && !text.includes(want); i++) {
    const r = await c.ok({ op: 'read', job, stream: 'stdout', offset, waitMs: 2000 });
    text += r.text;
    offset = r.next;
    if (r.eof) break;
  }
  return { text, offset };
}

describe.concurrent('session children', () => {
  test('spawn, write, read, closeInput, wait, status and events answer exact records', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const script = 'i=0; while IFS= read -r value; do i=$((i+1)); printf \'{"count":%s,"value":%s}\\n\' "$i" "$value"; done';
    await c.send({ id: 1, op: 'spawn', argv: ['/bin/sh', '-c', script], label: 'counter' });
    const job = JSON.parse(c.rawById.get(1)!).result.id as string;
    expect(job).toMatch(/^s-[0-9a-f]{32}$/);
    expectLine(c.rawById.get(1), { id: 1, ok: true, result: running(job, { label: 'counter', lifetime: 'session' }) }, 'std');
    let offset = 0;
    for (const [n, value] of [[1, 10], [2, 20], [3, 30]] as const) {
      expect(await c.ok({ op: 'write', job, text: `${value}\n` })).toEqual({ id: job, written: String(value).length + 1, closed: false });
      const line = `{"count":${n},"value":${value}}\n`;
      const read = await c.ok({ op: 'read', job, stream: 'stdout', offset, waitMs: 5000 });
      expect(read).toEqual(readRecord(job, { offset, text: line, next: offset + line.length, eof: false, state: 'running' }));
      offset = read.next;
    }
    expect(await c.ok({ op: 'closeInput', job })).toEqual({ id: job, written: 0, closed: true });
    expect(await c.ok({ op: 'closeInput', job })).toEqual({ id: job, written: 0, closed: true });
    expect(await c.send({ id: 'late', op: 'write', job, text: 'x\n' }))
      .toEqual({ id: 'late', ok: false, error: { code: 1, message: 'session child stdin is closed' } });
    const receipt = jobReceipt(job, { label: 'counter', lifetime: 'session', state: 'exited', exitCode: 0,
      stdout: '{"count":1,"value":10}\n{"count":2,"value":20}\n{"count":3,"value":30}\n' });
    expect(await c.ok({ op: 'wait', job, timeoutMs: 5000 })).toEqual(receipt);
    expect(await c.ok({ op: 'status', job })).toEqual(receipt);
    expect(await c.ok({ op: 'stop', job })).toEqual(receipt);
    expect(await c.ok({ op: 'read', job, stream: 'stdout', offset })).toEqual(readRecord(job, { offset, next: offset, eof: true, state: 'exited' }));
    const events = await c.ok({ op: 'events', job });
    expect(events[0]).toEqual({ sequence: 1, type: 'job.started', data: { id: job } });
    expect(events.at(-1)).toEqual({ sequence: events.length, type: 'job.finished', data: { receiptAvailable: true } });
    const watched = await c.ok({ op: 'watch', job, literal: 'count', timeoutMs: 1000 });
    expect(watched.flatMap((r: any) => (r.type === 'monitor.batch' ? r.lines.map((l: any) => l.text) : [])))
      .toEqual(['{"count":1,"value":10}', '{"count":2,"value":20}', '{"count":3,"value":30}']);
    expect((await c.close()).code).toBe(0);
  });

  test('a long-poll read waits while later writes and status are answered first', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/cat'] })).id;
    const pending = c.send({ id: 'read', op: 'read', job, stream: 'stdout', waitMs: 20000 });
    expect(await c.ok({ id: 'status', op: 'status', job })).toEqual(running(job, { lifetime: 'session' }));
    expect((await c.ok({ id: 'write', op: 'write', job, text: 'hello\n' })).written).toBe(6);
    expect((await pending).result).toEqual(readRecord(job, { offset: 0, text: 'hello\n', next: 6, eof: false, state: 'running' }));
    const order = c.arrived.map(line => line.id);
    expect(order.indexOf('read')).toBeGreaterThan(order.indexOf('status'));
    expect(order.indexOf('read')).toBeGreaterThan(order.indexOf('write'));
    // Writes to one child apply in arrival order, even sent back to back.
    const writes = Array.from({ length: 20 }, (_, i) => c.send({ op: 'write', job, text: `${i}\n` }));
    expect((await Promise.all(writes)).every(r => r.ok)).toBe(true);
    const { text } = await readUntil(c, job, '19\n');
    expect(text).toBe('hello\n' + Array.from({ length: 20 }, (_, i) => `${i}\n`).join(''));
    expect((await c.ok({ op: 'stop', job })).state).toBe('cancelled');
    expect((await c.close()).code).toBe(0);
  });

  test('read: base64 is byte-exact, a partial character is held, a rolling 1 MiB window discloses loss', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/cat'], stdin: 'pipe' })).id;
    await c.ok({ op: 'write', job, text: 'é' });
    expect(await c.ok({ op: 'read', job, stream: 'stdout', waitMs: 5000 })).toEqual(readRecord(job, { offset: 0, text: 'é', next: 2, eof: false, state: 'running' }));
    expect(await c.ok({ op: 'read', job, stream: 'stdout', encoding: 'base64' }))
      .toEqual(readRecord(job, { offset: 0, bytes: 2, data: 'w6k=', next: 2, eof: false, state: 'running' }));
    expect(await c.ok({ op: 'read', job, stream: 'stdout', max: 1 })).toEqual(readRecord(job, { offset: 0, bytes: 0, text: '', next: 0, eof: false, state: 'running' }));
    // Oracle 0.8.1: base64 reads of a live stream hold a partial character back too.
    expect(await c.ok({ op: 'read', job, stream: 'stdout', max: 1, encoding: 'base64' }))
      .toEqual(readRecord(job, { offset: 0, bytes: 0, data: '', next: 0, eof: false, state: 'running' }));
    expect(await c.ok({ op: 'read', job, stream: 'stderr' })).toEqual(readRecord(job, { stream: 'stderr', offset: 0, next: 0, eof: false, state: 'running' }));

    const total = 3 * SPOOL + 3;
    const big = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'head -c 3145728 /dev/zero | tr "\\0" x; printf end'], stdin: 'null' })).id;
    expect((await c.ok({ op: 'wait', job: big, timeoutMs: 20000 })).state).toBe('exited');
    expect(await c.ok({ op: 'read', job: big, stream: 'stdout', offset: 0, max: 16 }))
      .toEqual(readRecord(big, { offset: total - SPOOL, text: 'x'.repeat(16), omittedBytes: total - SPOOL, next: total - SPOOL + 16, eof: false, state: 'exited' }));
    expect(await c.ok({ op: 'read', job: big, stream: 'stdout', offset: total - 3 }))
      .toEqual(readRecord(big, { offset: total - 3, text: 'end', next: total, eof: true, state: 'exited' }));
    expect(await c.send({ id: 'w', op: 'write', job: big, text: 'x' }))
      .toEqual({ id: 'w', ok: false, error: { code: 1, message: 'session child stdin is closed' } });
    expect((await c.close()).code).toBe(0);
  }, 30000);

  test('list scope session; the store listing never shows session children; another connection cannot reach them', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const a = (await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'], label: 'a' })).id;
    const b = (await c.ok({ op: 'spawn', argv: ['/bin/echo', 'b'], stdin: 'null' })).id;
    await c.ok({ op: 'wait', job: b, timeoutMs: 5000 });
    const listed = await c.ok({ op: 'list', scope: 'session' });
    expect(listed.truncated).toBe(false);
    const byId = Object.fromEntries(listed.jobs.map((j: any) => [j.id, j]));
    expect(Object.keys(byId).sort()).toEqual([a, b].sort());
    expect(byId[a]).toEqual({ id: a, state: 'running', label: 'a', lifetime: 'session', startedAt: byId[a].startedAt });
    expect(byId[b]).toEqual({ id: b, state: 'exited', lifetime: 'session', startedAt: byId[b].startedAt, exitCode: 0 });
    expect(await c.ok({ op: 'list' })).toEqual({ jobs: [], truncated: false });
    expect(await c.ok({ op: 'list', scope: 'store' })).toEqual({ jobs: [], truncated: false });
    expect(JSON.parse(await s.ok(['list']))).toEqual({ jobs: [], truncated: false });
    const other = await serve(fx, s);
    const foreign = { ok: false, error: { code: 22, message: 'unknown session child for this connection' } };
    for (const op of ['status', 'stop', 'events', 'closeInput']) expect(await other.send({ id: op, op, job: a })).toEqual({ id: op, ...foreign });
    expect(await other.send({ id: 'w', op: 'write', job: a, text: 'x' })).toEqual({ id: 'w', ...foreign });
    expect(await other.send({ id: 'r', op: 'read', job: a, stream: 'stdout' })).toEqual({ id: 'r', ...foreign });
    await other.close();
    // The CLI cannot address a session child either.
    expect((await s.run(['status', a])).code).toBe(22);

    const cases: [Record<string, unknown>, number, string][] = [
      [{ op: 'write', job: 'deadbeef', text: 'x' }, 22, 'native private job operation failed'],
      [{ op: 'read', job: a, stream: 'stdin' }, 2, 'stream must be "stdout" or "stderr"'],
      [{ op: 'read', job: a }, 2, 'missing field: stream'],
      [{ op: 'read', job: a, stream: 'stdout', max: 65537 }, 2, 'max must be an integer from 1 to 65536'],
      [{ op: 'read', job: a, stream: 'stdout', max: 0 }, 2, 'max must be an integer from 1 to 65536'],
      [{ op: 'read', job: a, stream: 'stdout', offset: -1 }, 2, 'offset must be a byte offset (a non-negative integer)'],
      [{ op: 'read', job: a, stream: 'stdout', encoding: 'hex' }, 2, 'encoding must be "text" or "base64"'],
      [{ op: 'read', job: a, stream: 'stdout', waitMs: 0 }, 2, 'waitMs must be an integer from 1 to 300000'],
      [{ op: 'write', job: a, text: 'x'.repeat(65537) }, 2, 'text must be at most 65536 characters'],
      [{ op: 'write', job: a, text: 7 }, 2, 'text must be a string'],
      [{ op: 'spawn', argv: ['/bin/cat'], stdin: 'file' }, 2, 'stdin must be "pipe" or "null"'],
      [{ op: 'spawn', argv: ['/bin/cat'], input: 'pipe' }, 2, 'unknown request field: input'],
      [{ op: 'spawn', argv: ['/bin/cat'], cwd: 'relative' }, 2, 'cwd must be an absolute path'],
      [{ op: 'spawn', argv: ['/bin/pwd'], cwd: join(fx.root, 'nope') }, 2, 'cwd must be an existing directory'],
      [{ op: 'spawn', argv: ['/bin/cat'], timeoutMs: 86400001 }, 2, 'timeoutMs must be an integer from 1 to 86400000'],
      [{ op: 'list', scope: 'all' }, 2, 'scope must be "store" or "session"'],
    ];
    const actual = [];
    for (const [request] of cases) actual.push((await c.send(request)).error);
    expect(actual).toEqual(cases.map(([, code, message]) => ({ code, message })));
    expect((await c.close()).code).toBe(0);
  }, 30000);

  test('cwd applies to exec, start and spawn without moving the storage home', async () => {
    const s = fx.store();
    const dir = join(fx.root, 'session work dir');
    mkdirSync(dir, { recursive: true });
    const real = realpathSync(dir);
    const c = await serve(fx, s);
    expect((await c.ok({ op: 'exec', argv: ['/bin/pwd'], cwd: dir })).stdout).toBe(`${real}\n`);
    const job = (await c.ok({ op: 'start', argv: ['/bin/pwd'], cwd: dir })).id;
    s.started.add(job);
    expect((await c.ok({ op: 'wait', job, timeoutMs: 5000 })).stdout).toBe(`${real}\n`);
    expect(existsSync(join(s.home, job))).toBe(true);
    const child = (await c.ok({ op: 'spawn', argv: ['/bin/pwd'], cwd: dir, stdin: 'null' })).id;
    expect((await c.ok({ op: 'wait', job: child, timeoutMs: 5000 })).stdout).toBe(`${real}\n`);
    expect(readdirSync(dir)).toEqual([]);
    expect((await c.close()).code).toBe(0);
  });

  test('stop sends SIGTERM then SIGKILL after 500 ms; timeoutMs bounds a child; a launch failure is a failed receipt', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const stubborn = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'trap "" TERM; echo $$; while :; do sleep 0.05; done'] })).id;
    const pid = Number((await readUntil(c, stubborn, '\n')).text.trim());
    const begin = performance.now();
    const stopped = await c.ok({ op: 'stop', job: stubborn });
    expect(performance.now() - begin).toBeGreaterThanOrEqual(450);
    expect(stopped).toEqual(jobReceipt(stubborn, { lifetime: 'session', state: 'cancelled', exitCode: 143, stdout: `${pid}\n` }));
    expect(gone(pid)).toBe(true);
    const timed = (await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'], timeoutMs: 300 })).id;
    expect(await c.ok({ op: 'wait', job: timed, timeoutMs: 5000 })).toEqual(jobReceipt(timed, { lifetime: 'session', state: 'timed_out', exitCode: 124 }));
    // Launch is asynchronous: spawn answers running, and the failure is the receipt.
    const missing = (await c.ok({ op: 'spawn', argv: ['/nonexistent/x'] })).id;
    expect(await c.ok({ op: 'wait', job: missing, timeoutMs: 5000 })).toEqual(failedJob(missing, 'command launch failed', { lifetime: 'session' }));
    expect((await c.close()).code).toBe(0);
  });

  test('a write to a child that has exited is an error, never a silent drop', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'read line; echo "$line"'] })).id;
    await c.ok({ op: 'write', job, text: 'one\n' });
    expect((await c.ok({ op: 'wait', job, timeoutMs: 5000 })).stdout).toBe('one\n');
    expect(await c.send({ id: 'late', op: 'write', job, text: 'two\n' }))
      .toEqual({ id: 'late', ok: false, error: { code: 1, message: 'session child is no longer reading its input' } });
    expect((await c.close()).code).toBe(0);
  });

  test('a child that stops reading queues at most 64 writes, closes and stops; ending the session fails them', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'] })).id;
    const chunk = 'x'.repeat(65536);
    // The first write fills the pipe; the next 64 wait in the child's queue.
    expect(await c.ok({ id: 'w1', op: 'write', job, text: chunk })).toEqual({ id: job, written: 65536, closed: false });
    const queued = Array.from({ length: 64 }, (_, i) => c.send({ id: `w${i + 2}`, op: 'write', job, text: chunk }));
    const full = { ok: false, error: { code: 1, message: 'too many pending requests for this session child' } };
    expect(await c.send({ id: 'over', op: 'write', job, text: 'x' })).toEqual({ id: 'over', ...full });
    expect(await c.send({ id: 'close', op: 'closeInput', job })).toEqual({ id: 'close', ...full });
    expect(await c.send({ id: 'stop', op: 'stop', job })).toEqual({ id: 'stop', ...full });
    // Other requests are not held up.
    expect((await c.ok({ op: 'status', job })).state).toBe('running');
    const closed = c.close();
    const answers = await Promise.all(queued);
    expect(answers).toEqual(answers.map((_, i) => ({ id: `w${i + 2}`, ok: false, error: { code: 1, message: 'session child is no longer reading its input' } })));
    expect((await closed).code).toBe(0);
  }, 20000);

  test('a connection may run 16 session children at once', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const ids = [];
    for (let i = 0; i < 16; i++) ids.push((await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'] })).id);
    const extra = await c.send({ id: 'extra', op: 'spawn', argv: ['/bin/sleep', '30'] });
    expect(extra).toEqual({ id: 'extra', ok: false, error: { code: 22, message: 'this connection already has 16 running session children' } });
    await c.ok({ op: 'stop', job: ids[0] });
    expect((await c.ok({ op: 'spawn', argv: ['/bin/echo'], stdin: 'null' })).state).toBe('running');
    const begin = performance.now();
    expect((await c.close()).code).toBe(0);
    expect(performance.now() - begin).toBeLessThan(6000);
  }, 20000);

  test('ending the connection stops its children (forcing TERM-ignorers) and removes their directories', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'trap "" TERM; echo $$; exec sleep 60'] })).id;
    const plain = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'echo $$; exec sleep 60'] })).id;
    const pid = Number((await readUntil(c, job, '\n')).text.trim());
    const other = Number((await readUntil(c, plain, '\n')).text.trim());
    expect(gone(pid) || gone(other)).toBe(false);
    expect(readdirSync(s.home)).toContain(job.slice(2));
    const begin = performance.now();
    expect((await c.close()).code).toBe(0);
    expect(performance.now() - begin).toBeLessThan(6000);
    expect(gone(pid) && gone(other)).toBe(true);
    expect(readdirSync(s.home).filter(name => !name.startsWith('.'))).toEqual([]);
  }, 20000);

  test('a killed connection still stops its children: each worker notices its owner is gone', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'echo $$; exec sleep 60'] })).id;
    const pid = Number((await readUntil(c, job, '\n')).text.trim());
    c.child.kill('SIGKILL');
    await c.child.exited;
    expect(await until(() => gone(pid), 3000)).toBe(true);
  }, 20000);

  test('a durable job and a session child started by one connection: only the job outlives it', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const durable = (await c.ok({ op: 'start', argv: ['/bin/sleep', '30'] })).id;
    s.started.add(durable);
    const child = (await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'] })).id;
    expect(durable).toMatch(/^[0-9a-f]{32}$/);
    expect(child).toMatch(/^s-[0-9a-f]{32}$/);
    await c.close();
    expect(JSON.parse(await s.ok(['status', durable])).state).toBe('running');
    expect(existsSync(join(s.home, child.slice(2)))).toBe(false);
  });

  test('echo round trip through serve: a write then a long-poll read, well under a polling interval', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/cat'] })).id;
    let offset = 0;
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const begin = performance.now();
      await c.ok({ op: 'write', job, text: `ping ${i}\n` });
      let text = '';
      while (!text.endsWith('\n')) {
        const r = await c.ok({ op: 'read', job, stream: 'stdout', offset, waitMs: 2000 });
        text += r.text;
        offset = r.next;
      }
      times.push(performance.now() - begin);
      expect(text).toBe(`ping ${i}\n`);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(100);
    expect((await c.close()).code).toBe(0);
  }, 30000);

  test('a killed connection cancels its children as a stop would: TERM-ignorers forced after 500 ms, each receipt published', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const plain = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'echo $$; exec sleep 60'] })).id;
    const stubborn = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'trap "" TERM; echo $$; while :; do sleep 0.05; done'], label: 'stubborn' })).id;
    const plainPid = Number((await readUntil(c, plain, '\n')).text.trim());
    const stubbornPid = Number((await readUntil(c, stubborn, '\n')).text.trim());
    const begin = performance.now();
    c.child.kill('SIGKILL');
    await c.child.exited;
    expect(await until(() => gone(plainPid), 3000)).toBe(true);
    expect(await until(() => gone(stubbornPid), 3000)).toBe(true);
    expect(performance.now() - begin).toBeGreaterThanOrEqual(400);
    // Nothing removes a killed connection's directories; each child's receipt is the cancelled one a stop publishes.
    for (const [job, pid, label] of [[plain, plainPid, undefined], [stubborn, stubbornPid, 'stubborn']] as const) {
      const dir = job.slice(2);
      expect(await until(() => existsSync(join(s.home, dir, 'receipt.json')), 5000)).toBe(true);
      expect(await s.json(['status', dir])).toMatchObject(jobReceipt(job, { label, lifetime: 'session', state: 'cancelled', exitCode: 143, stdout: `${pid}\n`, stderr: expect.any(String) as any }));
      const events = await s.events(dir);
      expect(events[0]).toEqual({ sequence: 1, type: 'job.started', data: { id: job } });
      expect(events.at(-1)).toEqual({ sequence: events.length, type: 'job.finished', data: { receiptAvailable: true } });
      // Both rings are marked ended (flag bit 0 after the 8-byte count).
      for (const ring of ['stdout.ring', 'stderr.ring']) expect(readFileSync(join(s.home, dir, ring))[8]! & 1).toBe(1);
    }
    expect(JSON.parse(await s.ok(['list']))).toEqual({ jobs: [], truncated: false });
  }, 20000);

  test('another process sees a live session child by its directory, through the lease the connection holds, and can stop it there', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'spawn', argv: ['/bin/sleep', '30'], label: 'held' })).id;
    const dir = job.slice(2);
    expect(await s.json(['status', dir])).toEqual(running(job, { label: 'held', lifetime: 'session' }));
    expect(await s.events(dir)).toEqual([{ sequence: 1, type: 'job.started', data: { id: job } }]);
    expect(readdirSync(join(s.home, dir)).sort()).toEqual(['.lease', 'events.jsonl', 'meta.json', 'ready', 'stderr.ring', 'stdout.ring', 'worker-err.log', 'worker-out.log']);
    expect(JSON.parse(await s.ok(['list']))).toEqual({ jobs: [], truncated: false });
    // The CLI's stop writes the child's stop marker, which its supervisor honours as it would its own stop.
    const receipt = await s.json(['stop', dir]);
    expect(receipt).toEqual(jobReceipt(job, { label: 'held', lifetime: 'session', state: 'cancelled', exitCode: 143 }));
    expect(await c.ok({ op: 'status', job })).toEqual(receipt);
    expect(await c.ok({ op: 'stop', job })).toEqual(receipt);
    expect((await c.close()).code).toBe(0);
    expect(existsSync(join(s.home, dir))).toBe(false);
  });

  test('a child whose command its worker could not take never starts: unlisted, and (oracle 0.8.1) its directory is left', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const notStarted = { ok: false, error: { code: 1, message: 'session child did not start' } };
    expect(await c.send({ id: 'nul', op: 'spawn', argv: ['/bin/echo', 'a\u0000b'] })).toEqual({ id: 'nul', ...notStarted });
    // Oracle 0.8.1 answers this one only after its worker's announcement times out (5 s or more).
    expect(await c.send({ id: 'long', op: 'spawn', argv: ['/bin/echo', 'x'.repeat(4097)] })).toEqual({ id: 'long', ...notStarted });
    const fits = (await c.ok({ op: 'spawn', argv: ['/bin/echo', 'x'.repeat(4096)], stdin: 'null' })).id;
    expect((await c.ok({ op: 'wait', job: fits, timeoutMs: 5000 })).stdout).toBe(`${'x'.repeat(4096)}\n`);
    expect((await c.ok({ op: 'list', scope: 'session' })).jobs.map((j: any) => j.id)).toEqual([fits]);
    expect((await c.close()).code).toBe(0);
    const left = readdirSync(s.home).filter(name => !name.startsWith('.'));
    expect(left.length).toBe(2);
    for (const dir of left) expect(readdirSync(join(s.home, dir)).sort()).toEqual(['meta.json', 'stop', 'worker-err.log', 'worker-out.log']);
  }, 20000);

  test('SIGTERM or SIGINT to serve cancels its children (exit 143 either way); later spawns do not start; the session goes on', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const s = fx.store();
      const c = await serve(fx, s);
      const job = (await c.ok({ op: 'spawn', argv: ['/bin/sh', '-c', 'trap "echo got-term; exit 3" TERM; echo $$; while :; do sleep 0.05; done'] })).id;
      const pid = Number((await readUntil(c, job, '\n')).text.trim());
      c.child.kill(signal);
      expect(await until(() => gone(pid), 3000)).toBe(true);
      const receiptFile = join(s.home, job.slice(2), 'receipt.json');
      expect(await until(() => existsSync(receiptFile), 3000)).toBe(true);
      expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toMatchObject({ id: job, state: 'cancelled', exitCode: 143, cancelled: true, stdout: `${pid}\ngot-term\n` });
      expect(await c.send({ id: 'late', op: 'spawn', argv: ['/bin/echo'] })).toEqual({ id: 'late', ok: false, error: { code: 1, message: 'session child did not start' } });
      expect((await c.ok({ op: 'capabilities' })).protocol).toBe(2);
      expect((await c.close()).code).toBe(0);
    }
  }, 20000);

  test('a child flooding its stdout never holds up the connection: requests and other children answer at once', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const cat = (await c.ok({ op: 'spawn', argv: ['/bin/cat'] })).id;
    const flood = (await c.ok({ op: 'spawn', argv: ['/usr/bin/yes', 'flood'.repeat(20)] })).id;
    await Bun.sleep(200);
    const caps: number[] = [];
    const trips: number[] = [];
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      let begin = performance.now();
      await c.ok({ op: 'capabilities' });
      caps.push(performance.now() - begin);
      begin = performance.now();
      await c.ok({ op: 'write', job: cat, text: `ping ${i}\n` });
      const { text, offset: next } = await readUntil(c, cat, '\n', offset);
      offset = next;
      expect(text).toBe(`ping ${i}\n`);
      trips.push(performance.now() - begin);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(median(caps)).toBeLessThan(20);
    expect(Math.max(...caps)).toBeLessThan(500);
    expect(median(trips)).toBeLessThan(100);
    expect((await c.ok({ op: 'read', job: flood, stream: 'stdout', max: 1 })).next).toBeGreaterThan(1048576);
    expect((await c.ok({ op: 'stop', job: flood })).state).toBe('cancelled');
    expect((await c.close()).code).toBe(0);
  }, 30000);
});
