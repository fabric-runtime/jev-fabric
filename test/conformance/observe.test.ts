// Observation verbs: `follow` (live events, loss records, one follow.end),
// `events --timeout-ms` (long poll) and `watch` (filtered line batches).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Fixture, expectLine, expectOut, finished, jobReceipt, jsonLines, output, running, started, stream, streamText, until, vary,
} from './harness.ts';

const fx = new Fixture('observe');
afterAll(() => fx.cleanup());

const NOTE = 'matched lines are observations, not semantic completion';
const end = (reason: string, terminal: boolean, lines: number, batches: number, losses: number, limit = false) => ({
  type: 'monitor.end', reason, terminal, lines, batches, losses, elapsedMs: vary.count(), outputLimitReached: limit, note: NOTE,
});
const batch = (stream: string, first: number, last: number, lines: (string | [string, boolean])[], omitted = 0, clipped = 0) => ({
  type: 'monitor.batch', stream, first, last, omitted, clipped,
  lines: lines.map(line => (typeof line === 'string' ? { text: line, clipped: false } : { text: line[0], clipped: line[1] })),
});
const TIMEOUT = 'timeout must be an integer within the operation limit';

// A finished job whose 64-event ring has evicted its oldest events.
const ring = fx.store();
let ringId = '';
beforeAll(async () => {
  ringId = await ring.start(['/bin/sh', '-c', 'i=0; while [ $i -lt 100 ]; do printf "x$i\\n"; sleep 0.03; i=$((i+1)); done']);
  await ring.wait(ringId, 20000);
}, 30000);

describe.concurrent('follow', () => {
  test('streams each event once as the worker publishes it, then one follow.end with the receipt', async () => {
    const s = fx.store();
    const release = join(fx.root, 'follow-release');
    const id = await s.start(['--label', 'follow me', '/bin/sh', '-c',
      'printf "first\\n"; while [ ! -f "$1" ]; do sleep 0.02; done; printf "second\\n"', 'sh', release]);
    const live = stream(s, ['follow', '--timeout-ms', '20000', id]);
    fx.track(live.child);
    expect(await live.lines.until(line => line.type === 'process.output')).toBeDefined();
    // Still running: nothing has ended the follow yet.
    expectOut(await s.ok(['status', id]), [running(id, { label: 'follow me' })]);
    writeFileSync(release, 'go');
    expect(await live.lines.until(line => line.type === 'follow.end')).toBeDefined();
    expect(await live.child.exited).toBe(0);
    expect(await live.lines.next()).toBeUndefined();
    const receipt = jobReceipt(id, { label: 'follow me', state: 'exited', exitCode: 0, stdout: 'first\nsecond\n' });
    const want = [started(1, id), output(2, 'stdout', 0, 'first\n'), output(3, 'stdout', 6, 'second\n'), finished(4),
      { type: 'follow.end', reason: 'finished', next: 4, receipt }];
    expectOut(live.lines.raw.join('\n') + '\n', want);
    // A cursor at the end prints only follow.end, at once; one in the middle replays what follows it.
    expectOut(await s.ok(['follow', id, '4']), want.slice(4));
    expectOut(await s.ok(['follow', id, '2']), want.slice(2));
    expectOut(await s.ok(['follow', id, '9']), [{ ...want[4], next: 9 }]);
  });

  test('times out with the running state, exit 0, without stopping or renewing the job', async () => {
    const s = fx.store();
    const id = await s.start(['--label', 'sleeper', '/bin/sleep', '30']);
    expect(await until(async () => (await s.events(id)).length === 1)).toBe(true);
    for (const [args, env] of [
      [['follow', '--timeout-ms', '300', id], {}],
      [['follow', id], { JEV_FABRIC_WAIT_MS: '300' }],
    ] as [string[], Record<string, string>][]) {
      const r = await s.run(args, { env });
      expect([r.code, r.err]).toEqual([0, '']);
      expect(r.ms).toBeGreaterThanOrEqual(290);
      expect(r.ms).toBeLessThan(3000);
      expectOut(r.out, [started(1, id), { type: 'follow.end', reason: 'timeout', next: 1, receipt: running(id, { label: 'sleeper' }) }]);
    }
    expectOut(await s.ok(['status', id]), [running(id, { label: 'sleeper' })]);
  });

  test('discloses events evicted before its cursor with one follow.loss record first', async () => {
    const events = await ring.events(ringId);
    const first = events[0].sequence;
    const r = await ring.run(['follow', ringId]);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expectLine(lines[0], { type: 'follow.loss', after: 0, next: first });
    expect(jsonLines(r.out).slice(1, -1)).toEqual(events);
    expect(jsonLines(r.out).at(-1)).toMatchObject({ type: 'follow.end', reason: 'finished', next: events.at(-1).sequence });
    const partial = await ring.ok(['follow', ringId, String(first - 5)]);
    expectLine(partial.split('\n')[0], { type: 'follow.loss', after: first - 5, next: first });
    // No loss when the cursor is inside the retained window.
    const inside = jsonLines(await ring.ok(['follow', ringId, String(first)]));
    expect(inside.some(line => line.type === 'follow.loss')).toBe(false);
    expect(inside.slice(0, -1)).toEqual(events.slice(1));
  });

  test('fails like the other controls for unknown or invalid jobs, cursors and ceilings', async () => {
    const s = fx.store();
    await s.ok(['list']);
    const unknown = 'e'.repeat(32);
    const cases: [string[], number, string][] = [
      [['follow', unknown], 2, 'native private job operation failed'],
      [['follow', '--timeout-ms', '100', '../escape'], 22, 'native private job operation failed'],
      [['follow', unknown, 'oops'], 2, 'after-sequence must be a U32'],
      [['follow', '--timeout-ms', '0', unknown], 2, TIMEOUT],
      [['follow', '--timeout-ms', '3600001', unknown], 2, TIMEOUT],
      [['follow'], 2, 'usage: follow [--timeout-ms N] <id> [after-sequence]'],
      // Oracle 0.8.1: despite its usage line, follow has no positional-timeout form; 300 is read as the id.
      [['follow', '300', unknown], 2, 'after-sequence must be a U32'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, code, message]) => [args, code, '', message]));
    const bad = await s.run(['follow', unknown], { env: { JEV_FABRIC_WAIT_MS: 'nope' } });
    expect([bad.code, bad.err.trim()]).toEqual([2, TIMEOUT]);
  });
});

describe.concurrent('events --timeout-ms', () => {
  test('long-polls: empty at the ceiling, early on a later event, at once for a terminal job', async () => {
    const s = fx.store();
    const release = join(fx.root, 'events-release');
    const id = await s.start(['/bin/sh', '-c', 'while [ ! -f "$1" ]; do sleep 0.02; done; printf late', 'sh', release]);
    expect(await until(async () => (await s.events(id)).length === 1)).toBe(true);
    const quiet = await s.run(['events', '--timeout-ms', '150', id, '1']);
    expect([quiet.code, quiet.out, quiet.err]).toEqual([0, '', '']);
    expect(quiet.ms).toBeGreaterThanOrEqual(140);
    setTimeout(() => writeFileSync(release, 'go'), 300);
    const later = await s.run(['events', '--timeout-ms', '20000', id, '1']);
    expect(later.ms).toBeLessThan(10000);
    const events = jsonLines(later.out);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.sequence > 1)).toBe(true);
    await s.wait(id);
    const all = await s.events(id);
    const done = await s.run(['events', '--timeout-ms', '20000', id, String(all.at(-1).sequence)]);
    expect([done.code, done.out]).toEqual([0, '']);
    expect(done.ms).toBeLessThan(3000);
    // A snapshot past the cursor of a terminal job is printed whole.
    expect(jsonLines(await s.ok(['events', '--timeout-ms', '20000', id, '0']))).toEqual(all);
  });

  test('accepts 1..300000 ms and checks the job', async () => {
    const s = fx.store();
    await s.ok(['list']);
    const unknown = 'e'.repeat(32);
    const actual = [];
    for (const args of [['events', '--timeout-ms', '0', unknown], ['events', '--timeout-ms', '300001', unknown],
      ['events', '--timeout-ms', '100', unknown]]) {
      const r = await s.run(args);
      actual.push([r.code, r.err.trim()]);
    }
    expect(actual).toEqual([[2, TIMEOUT], [2, TIMEOUT], [2, 'native private job operation failed']]);
  });
});

describe.concurrent('watch', () => {
  test('filters by literal, trims, drops consecutive duplicates and batches per stream', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c',
      'printf "booting\\n  ready  \\nready\\nother ready\\nready\\n\\tready\\t\\n"; printf "err ready\\n" >&2']);
    await s.wait(id);
    const r = await s.run(['watch', id, 'ready']);
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [
      batch('stdout', 2, 2, ['ready', 'other ready', 'ready']),
      batch('stderr', 3, 3, ['err ready']),
      end('finished', true, 4, 2, 0),
    ]);
  });

  test('reassembles a line split across live chunks, and flushes a final partial line at EOF', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'printf "HEL"; sleep 0.15; printf "LO\\nHELLO\\n"; sleep 0.05; printf "HELLO\\nHELp"']);
    const events = jsonLines(await s.ok(['watch', '--timeout-ms', '5000', id, 'HEL']));
    expect(events.filter(e => e.type === 'monitor.batch').flatMap(e => e.lines.map((l: any) => l.text))).toEqual(['HELLO', 'HELp']);
    expect(events.at(-1)).toMatchObject({ type: 'monitor.end', reason: 'finished', terminal: true, lines: 2, losses: 0 });
  });

  test('clips a line at 4096 characters and discloses it', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'i=0; while [ $i -lt 5 ]; do head -c 1000 /dev/zero | tr "\\0" a; sleep 0.05; i=$((i+1)); done; printf "\\n"']);
    const events = jsonLines(await s.ok(['watch', '--timeout-ms', '5000', id, 'aaa']));
    const batches = events.filter(e => e.type === 'monitor.batch');
    expect(batches.length).toBe(1);
    expect(batches[0].lines).toEqual([{ text: 'a'.repeat(4096), clipped: true }]);
    expect(batches[0].clipped).toBe(1);
  });

  test('emits at most 32 lines per batch', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'i=0; while [ $i -lt 70 ]; do echo "m $i"; i=$((i+1)); done']);
    await s.wait(id);
    const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `m ${from + i}`);
    expectOut(await s.ok(['watch', id, 'm']), [
      batch('stdout', 2, 2, lines(0, 32)), batch('stdout', 2, 2, lines(32, 64)), batch('stdout', 2, 2, lines(64, 70)),
      end('finished', true, 70, 3, 0),
    ]);
  });

  test('ends at its deadline (terminal false) while the job keeps running; JEV_FABRIC_WATCH_MS sets the default', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'echo ready; exec sleep 30']);
    expect(await until(async () => streamText(await s.events(id)) === 'ready\n')).toBe(true);
    for (const [args, env] of [
      [['watch', '--timeout-ms', '200', id, 'ready'], {}],
      [['watch', id, '200', 'ready'], {}],
      [['watch', id, 'ready'], { JEV_FABRIC_WATCH_MS: '200' }],
    ] as [string[], Record<string, string>][]) {
      const r = await s.run(args, { env });
      expect([r.code, r.err]).toEqual([0, '']);
      expect(r.ms).toBeGreaterThanOrEqual(190);
      expectOut(r.out, [batch('stdout', 2, 2, ['ready']), end('deadline', false, 1, 1, 0)]);
    }
    expectOut(await s.ok(['status', id]), [running(id)]);
    const none = await s.run(['watch', '--timeout-ms', '100', id, 'NEVER']);
    expectOut(none.out, [end('deadline', false, 0, 0, 0)]);
  });

  test('a terminal job ends the watch even when nothing matches', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/sleep', '0.2']);
    const r = await s.run(['watch', '--timeout-ms', '5000', id, 'NEVER']);
    expectOut(r.out, [end('finished', true, 0, 0, 0)]);
    expect(r.ms).toBeLessThan(4000);
  });

  test('discloses evicted events, omitted bytes and spool caps as monitor.loss records', async () => {
    const events = await ring.events(ringId);
    const evicted = await ring.ok(['watch', ringId, 'x9']);
    expectOut(evicted, [
      { type: 'monitor.loss', stream: '*', reason: 'replay-eviction', count: events[0].sequence - 1 },
      batch('stdout', vary.count(), events.at(-2).sequence, ['x90', 'x91', 'x92', 'x93', 'x94', 'x95', 'x96', 'x97', 'x98', 'x99']),
      end('finished', true, 10, 1, 1),
    ]);
    const s = fx.store();
    const id = await s.start(['/bin/sh', '-c', 'head -c 1400000 /dev/zero | tr "\\0" y; echo; echo tail-line']);
    await s.wait(id);
    const flood = await s.events(id);
    const omitted = flood.filter(e => e.type === 'process.output' && e.data.omittedBytes > 0).map(e => e.data.omittedBytes);
    expect(omitted.length).toBeGreaterThan(0);
    expectOut(await s.ok(['watch', id, 'tail']), [
      ...omitted.map(count => ({ type: 'monitor.loss', stream: 'stdout', reason: 'omitted-bytes', count })),
      { type: 'monitor.loss', stream: 'stdout', reason: 'spool-limit', count: 0 },
      end('finished', true, 0, 0, omitted.length + 1),
    ]);
  });

  test('rejects bad literals, durations and jobs before looping', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/echo']);
    const usage = 'usage: watch <id> <duration-ms> <literal>; duration 1..300000, literal 1..256 chars';
    const cases: [string[], number, string][] = [
      [['watch', id], 2, 'usage: watch [--timeout-ms N] <id> <literal>'],
      [['watch', '--timeout-ms', '100', id, ''], 2, usage],
      [['watch', '--timeout-ms', '100', id, 'x'.repeat(257)], 2, usage],
      [['watch', '--timeout-ms', '0', id, 'x'], 2, TIMEOUT],
      [['watch', '--timeout-ms', '300001', id, 'x'], 2, TIMEOUT],
      [['watch', '--timeout-ms', '100', 'b'.repeat(32), 'x'], 2, 'native private job operation failed'],
      [['watch', '--timeout-ms', '100', '../outside', 'x'], 22, 'native private job operation failed'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, code, message]) => [args, code, '', message]));
    expect((await s.run(['watch', '--timeout-ms', '100', id, 'x'.repeat(256)])).code).toBe(0);
    const bad = await s.run(['watch', id, 'x'], { env: { JEV_FABRIC_WATCH_MS: 'nope' } });
    expect([bad.code, bad.err.trim()]).toEqual([2, TIMEOUT]);
  });
});
