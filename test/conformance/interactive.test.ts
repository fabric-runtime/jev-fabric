// Durable interactive jobs (`start --input pipe`), `write`, `close-input` and
// `read`, each from separate processes, and their on-disk queue and rings.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Captured, Fixture, JOB_USAGE, SPOOL, Store, expectLine, expectOut, gone, jobReceipt, failedJob, until, vary } from './harness.ts';

const fx = new Fixture('interactive');
afterAll(() => fx.cleanup());

const writeRecord = (id: string, written: number, closed = false) => ({ id, written, closed });
const readRecord = (id: string, r: {
  stream?: string; offset: number; text?: string; data?: string; bytes?: number; omittedBytes?: number; next: number; eof: boolean; state: string;
}) => ({
  id, stream: r.stream ?? 'stdout', offset: r.offset,
  bytes: r.bytes ?? Buffer.byteLength(r.text ?? ''), omittedBytes: r.omittedBytes ?? 0,
  ...(r.data === undefined ? { text: r.text ?? '' } : { data: r.data }),
  next: r.next, eof: r.eof, state: r.state,
});

/** Reads from `offset` until `want` appears, following `next`. */
async function readUntil(s: Store, id: string, want: string, offset = 0) {
  let text = '';
  for (let i = 0; i < 100 && !text.includes(want); i++) {
    const r = await s.json(['read', '--wait-ms', '2000', id, 'stdout', String(offset)]);
    text += r.text;
    offset = r.next;
    if (r.eof) break;
  }
  return { text, offset };
}

describe.concurrent('interactive jobs', () => {
  test('keeps state across writes from separate processes; exact write, close and read records', async () => {
    const s = fx.store();
    const counter = 'i=0; while IFS= read -r value; do i=$((i+1)); printf \'{"count":%s,"value":"%s"}\\n\' "$i" "$value"; done; echo bye';
    const id = await s.start(['--input', 'pipe', '--label', 'counter', '/bin/sh', '-c', counter]);
    expectOut(await s.ok(['status', id]), [{ schemaVersion: 1, id, label: 'counter', lifetime: 'durable', state: 'running', spoolLimitBytes: SPOOL }]);
    expectLine(readFileSync(join(s.home, id, 'meta.json'), 'utf8'),
      { schemaVersion: 1, startedAt: vary.time(), label: 'counter', lifetime: 'durable', input: 'pipe' });

    // Words after -- are joined by single spaces; nothing is appended.
    expectOut(await s.ok(['write', id, '--', 'one', 'two\n']), [writeRecord(id, 8)]);
    const first = await s.ok(['read', '--wait-ms', '5000', id, 'stdout']);
    expectOut(first, [readRecord(id, { offset: 0, text: '{"count":1,"value":"one two"}\n', next: 30, eof: false, state: 'running' })]);
    // --stdin passes bytes as they are; written counts UTF-8 bytes.
    expectOut(await s.ok(['write', id, '--stdin'], { input: 'héllo\n' }), [writeRecord(id, 7)]);
    let { text, offset } = await readUntil(s, id, '\n', 30);
    expect(JSON.parse(text)).toEqual({ count: 2, value: 'héllo' });
    // Writes from separate processes land in the order they were made.
    for (let n = 0; n < 15; n++) await s.ok(['write', id, '--', `${n}\n`]);
    ({ text, offset } = await readUntil(s, id, '"value":"14"', offset));
    expect(text.trim().split('\n').map(line => JSON.parse(line).value)).toEqual(Array.from({ length: 15 }, (_, n) => String(n)));
    expectOut(await s.ok(['write', id, '--']), [writeRecord(id, 0)]);

    expectOut(await s.ok(['close-input', id]), [writeRecord(id, 0, true)]);
    expectOut(await s.ok(['close-input', id]), [writeRecord(id, 0, true)]);
    const late = await s.run(['write', id, '--', 'late\n']);
    expect([late.code, late.out]).toEqual([1, '']);
    expect(['job input is closed\n', 'job has finished\n']).toContain(late.err);

    const receipt = await s.wait(id);
    expect(receipt).toMatchObject({ id, label: 'counter', lifetime: 'durable', state: 'exited', exitCode: 0 });
    expect(receipt.stdout.endsWith('bye\n')).toBe(true);
    expectOut(await s.ok(['read', id, 'stdout', String(offset)]),
      [readRecord(id, { offset, text: 'bye\n', next: offset + 4, eof: true, state: 'exited' })]);
    expect(await s.run(['write', id, '--', 'x'])).toMatchObject({ code: 1, out: '', err: 'job has finished\n' });
    expect(await s.run(['close-input', id])).toMatchObject({ code: 0 });

    // On disk: a private input queue and two rolling rings with a 16-byte header.
    const dir = join(s.home, id);
    expect(readdirSync(dir).sort()).toEqual(['.lease', 'events.jsonl', 'input.closed', 'input.queue', 'meta.json', 'ready', 'receipt.json',
      'result.json', 'stderr.ring', 'stdout.ring']);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777, name).toBe(0o600);
    const ring = readFileSync(join(dir, 'stdout.ring'));
    expect(ring.readBigUInt64LE(0)).toBe(BigInt(offset + 4));
    expect(ring.readBigUInt64LE(8)).toBe(1n);
    expect(ring.subarray(16).toString()).toBe(receipt.stdout);
    const err = readFileSync(join(dir, 'stderr.ring'));
    expect([err.length, err.readBigUInt64LE(0), err.readBigUInt64LE(8)]).toEqual([16, 0n, 1n]);
  }, 30000);

  test('a long-poll read returns as soon as another process writes', async () => {
    const s = fx.store();
    const id = await s.start(['--input', 'pipe', '/bin/cat']);
    const pending = s.run(['read', '--wait-ms', '20000', id, 'stdout']);
    await Bun.sleep(200);
    await s.ok(['write', id, '--', 'ping\n']);
    const r = await pending;
    expect(r.ms).toBeLessThan(5000);
    expectOut(r.out, [readRecord(id, { offset: 0, text: 'ping\n', next: 5, eof: false, state: 'running' })]);
    // Nothing new: an empty record once the wait passes.
    const empty = await s.run(['read', '--wait-ms', '150', id, 'stdout', '5']);
    expect(empty.ms).toBeGreaterThanOrEqual(140);
    expectOut(empty.out, [readRecord(id, { offset: 5, text: '', next: 5, eof: false, state: 'running' })]);
    await s.ok(['stop', id]);
  });

  test('the input queue holds at most 1 MiB not yet handed over; a full queue refuses the write (1)', async () => {
    const s = fx.store();
    const id = await s.start(['--input', 'pipe', '/bin/sleep', '60']);
    const chunk = 'x'.repeat(65536);
    let refused: Captured | undefined;
    let accepted = 0;
    for (let i = 0; i < 40 && !refused; i++) {
      const r = await s.run(['write', id, '--stdin'], { input: chunk });
      if (r.code === 0) accepted++;
      else refused = r;
    }
    expect(refused).toEqual({ code: 1, out: '', err: 'job input queue is full: 1 MiB is waiting for the child to read it\n', ms: refused!.ms });
    // The pipe buffer may absorb some, but no more than the queue bound plus that.
    expect(accepted).toBeGreaterThanOrEqual(16);
    expect(accepted).toBeLessThan(40);
    expect(statSync(join(s.home, id, 'input.queue')).size).toBeLessThanOrEqual(SPOOL);
    expect((await s.json(['stop', id])).state).toBe('cancelled');
    expect(await s.run(['write', id, '--', 'x'])).toMatchObject({ code: 1, out: '', err: 'job has finished\n' });
  }, 30000);

  test('read returns raw bytes of a batch job from any offset; writes to it are refused (22)', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'printf "héllo wörld"; printf oops >&2']);
    await s.wait(id);
    expectOut(await s.ok(['read', id, 'stdout']), [readRecord(id, { offset: 0, text: 'héllo wörld', next: 13, eof: true, state: 'exited' })]);
    expectOut(await s.ok(['read', '--base64', id, 'stdout', '1', '2']),
      [readRecord(id, { offset: 1, bytes: 2, data: Buffer.from('é').toString('base64'), next: 3, eof: false, state: 'exited' })]);
    expectOut(await s.ok(['read', id, 'stderr']), [readRecord(id, { stream: 'stderr', offset: 0, text: 'oops', next: 4, eof: true, state: 'exited' })]);
    expectOut(await s.ok(['read', id, 'stdout', '6', '4']), [readRecord(id, { offset: 6, text: ' wö', next: 10, eof: false, state: 'exited' })]);
    // At or past the end: nothing, at once even with a wait, and eof.
    const past = await s.run(['read', '--wait-ms', '5000', id, 'stdout', '13']);
    expect(past.ms).toBeLessThan(3000);
    expectOut(past.out, [readRecord(id, { offset: 13, text: '', next: 13, eof: true, state: 'exited' })]);
    expectOut(await s.ok(['read', id, 'stdout', '100']), [readRecord(id, { offset: 100, text: '', next: 100, eof: true, state: 'exited' })]);
    // read never writes to the store.
    const before = readdirSync(join(s.home, id)).sort();
    await s.ok(['read', id, 'stdout']);
    expect(readdirSync(join(s.home, id)).sort()).toEqual(before);

    expect(await s.run(['write', id, '--', 'x'])).toMatchObject({ code: 22, out: '', err: 'job was not started with --input pipe\n' });
    expect(await s.run(['close-input', id])).toMatchObject({ code: 22, out: '', err: 'job was not started with --input pipe\n' });
    const cases: [string[], number, string][] = [
      [['read', id], 2, 'usage: read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]'],
      [['read', id, 'stdin'], 2, 'stream must be stdout or stderr'],
      [['read', id, 'stdout', 'x'], 2, 'offset must be a byte offset'],
      [['read', id, 'stdout', '0', '0'], 2, 'max must be an integer from 1 to 65536'],
      [['read', id, 'stdout', '0', '65537'], 2, 'max must be an integer from 1 to 65536'],
      [['read', '--wait-ms', '0', id, 'stdout'], 2, '--wait-ms must be an integer from 1 to 300000'],
      [['read', '--wait-ms', '300001', id, 'stdout'], 2, '--wait-ms must be an integer from 1 to 300000'],
      [['write', id, '--', 'x'.repeat(65537)], 2, 'write takes at most 65536 characters'],
      [['write', id], 2, JOB_USAGE],
      [['write', id, 'x'], 2, JOB_USAGE],
      [['write', id, '--stdin', 'extra'], 2, JOB_USAGE],
      [['close-input'], 2, JOB_USAGE],
      [['start', '--input', 'file', '/bin/cat'], 2, '--input takes pipe'],
      [['exec', '--input', 'pipe', '/bin/cat'], 2, '--input is supported for start only'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, code, message]) => [args, code, '', message]));
    // 65536 characters (not bytes) are accepted: two words joined by a space,
    // 131071 bytes in all. (One 131072-byte word would exceed Linux's 128 KiB
    // limit on a single argument, MAX_ARG_STRLEN, before the binary ran.)
    const pipe = await s.start(['--input', 'pipe', '/bin/sh', '-c', 'cat > /dev/null']);
    expectOut(await s.ok(['write', pipe, '--', 'é'.repeat(32768), 'é'.repeat(32767)]), [writeRecord(pipe, 131071)]);
    expect(await s.run(['write', pipe, '--stdin'], { input: new Uint8Array([0xc3]) })).toMatchObject({ code: 22, out: '', err: 'truncated UTF-8\n' });
    await s.ok(['close-input', pipe]);
    expect((await s.wait(pipe)).state).toBe('exited');
  });

  test('a partial UTF-8 character at the end of a live stream is held until more bytes or the end', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', "printf 'a\\303'; sleep 30"]);
    expect(await until(async () => (await s.json(['read', '--base64', id, 'stdout'])).bytes === 1 || statSync(join(s.home, id, 'stdout.bin')).size === 2, 5000)).toBe(true);
    await Bun.sleep(100);
    expectOut(await s.ok(['read', id, 'stdout']), [readRecord(id, { offset: 0, text: 'a', next: 1, eof: false, state: 'running' })]);
    expectOut(await s.ok(['read', '--base64', id, 'stdout']), [readRecord(id, { offset: 0, bytes: 1, data: 'YQ==', next: 1, eof: false, state: 'running' })]);
    await s.ok(['stop', id]);
    expectOut(await s.ok(['read', id, 'stdout']), [readRecord(id, { offset: 0, bytes: 2, text: 'a�', next: 2, eof: true, state: 'cancelled' })]);
  });

  test('an interactive job keeps the latest 1 MiB per stream; loss shows as omittedBytes, not a spool limit', async () => {
    const s = fx.store();
    const total = 3 * SPOOL + 3;
    const id = await s.start(['--input', 'pipe', '/bin/sh', '-c', 'head -c 3145728 /dev/zero | tr "\\0" x; printf end']);
    expect((await s.wait(id, 20000)).state).toBe('exited');
    expectOut(await s.ok(['read', id, 'stdout', '0', '16']),
      [readRecord(id, { offset: total - SPOOL, text: 'x'.repeat(16), omittedBytes: total - SPOOL, next: total - SPOOL + 16, eof: false, state: 'exited' })]);
    expectOut(await s.ok(['read', id, 'stdout', String(total - 3)]), [readRecord(id, { offset: total - 3, text: 'end', next: total, eof: true, state: 'exited' })]);
    const events = await s.events(id);
    expect(events.some(e => e.type === 'process.spool_limit')).toBe(false);
    expect(events.some(e => e.type === 'process.output' && e.data.omittedBytes > 0)).toBe(true);
    expect(statSync(join(s.home, id, 'stdout.ring')).size).toBe(16 + SPOOL);
  }, 30000);

  test('a crashed worker is reported failed and its queued input is not replayed', async () => {
    const s = fx.store();
    const id = await s.start(['--input', 'pipe', '/bin/sh', '-c', 'echo $PPID $$; exec cat']);
    const { text } = await readUntil(s, id, '\n');
    const [worker, child] = text.trim().split(' ').map(Number) as [number, number];
    process.kill(worker, 'SIGKILL');
    expect(await until(() => gone(worker), 2000)).toBe(true);
    expectOut(await s.ok(['status', id]), [failedJob(id, 'worker exited without a terminal receipt')]);
    expect(await s.run(['write', id, '--', 'x'])).toMatchObject({ code: 1, out: '', err: 'job has finished\n' });
    if (!gone(child)) process.kill(child, 'SIGKILL');
  });

  test('a job that ends while input is queued stops accepting writes', async () => {
    const s = fx.store();
    const id = await s.start(['--input', 'pipe', '/bin/sh', '-c', 'read line; echo "got $line"']);
    await s.ok(['write', id, '--', 'one\n']);
    expect(await s.wait(id)).toEqual(jobReceipt(id, { state: 'exited', exitCode: 0, stdout: 'got one\n' }));
    expect(await s.run(['write', id, '--', 'two\n'])).toMatchObject({ code: 1, out: '', err: 'job has finished\n' });
  });
});
