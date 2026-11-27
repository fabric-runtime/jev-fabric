// The `serve` JSONL protocol: banner, options, strict requests and errors,
// framing, concurrency matched by id, deadlines, shutdown and job operations.
import { afterAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, FEATURES, Fixture, Serve, expectLine, jobReceipt, processReceipt, run, running, serve, vary } from './harness.ts';

const fx = new Fixture('serve');
afterAll(() => fx.cleanup());

const noul = { state: 'synthetic', questions: { ok: { type: 'noul', instructions: 'Is two plus two four?' } } };
const NOT_FOUND = 'native private job operation failed';
const banner = (timeoutMs: number, maxEvaluations: number, maxTokens: number) => ({
  ready: {
    protocol: 2, version: vary.text(/^\d+\.\d+\.\d+-native$/), timeoutMs, maxEvaluations, maxTokens, store: 1,
    platform: vary.text(/^(darwin|linux)-(arm64|x64)$/),
    features: vary.where('the 0.8.1 features, then additions', v => Array.isArray(v) && FEATURES.every((f, i) => v[i] === f)),
  },
});

describe.concurrent('serve session', () => {
  test('the banner names protocol, version, deadline, budgets, store, platform and features', async () => {
    const s = fx.store();
    const c = await serve(fx, s, ['--timeout-ms', '60000', '3', '500']);
    expectLine(c.bannerRaw, banner(60000, 3, 500), 'std');
    const caps = JSON.parse((await s.run(['capabilities'])).out);
    expect(c.banner.ready).toMatchObject(caps);
    expect(await c.ok({ op: 'capabilities' })).toEqual(caps);
    expect(await c.close()).toEqual({ code: 0, err: '' });
    const d = await serve(fx, s);
    expectLine(d.bannerRaw, banner(3600000, 1, 100000), 'std');
    await d.close();
    const e = await serve(fx, s, ['2']);
    expect(e.banner.ready).toMatchObject({ maxEvaluations: 2, maxTokens: 100000 });
    await e.close();
    const f = await serve(fx, s, ['--timeout-ms', '86400000'], { JEV_FABRIC_TIMEOUT_MS: '5000' });
    expect(f.banner.ready.timeoutMs).toBe(86400000);
    await f.close();
    const g = await serve(fx, s, [], { JEV_FABRIC_TIMEOUT_MS: '5000' });
    expect(g.banner.ready.timeoutMs).toBe(5000);
    await g.close();
  });

  test("'-- serve' and 'serve' are the same session; argv reaches the child verbatim", async () => {
    const s = fx.store();
    const replies = [];
    for (const bare of [false, true]) {
      const c = await serve(fx, s, ['--timeout-ms', '60000', '1', '60000'], {}, { bare });
      const echo = await c.send({ id: 1, op: 'exec', argv: ['/bin/echo', '--', '+RTS', '--threads', '2', '-RTS', '--RTS', 'x'] });
      replies.push({ banner: c.bannerRaw, echo: c.rawById.get(1), closed: await c.close() });
      expect(echo.result.stdout).toBe('-- +RTS --threads 2 -RTS --RTS x\n');
    }
    expect(replies[1]).toEqual(replies[0]!);
  });

  test('invalid options or configuration fail before the banner', async () => {
    const s = fx.store();
    const budgets = 'serve budgets must be integers: [max-evaluations [max-tokens]]';
    const timeout = 'timeout must be an integer within the operation limit';
    const cases: [string[], Record<string, string>, number, string][] = [
      [['x'], {}, 2, budgets],
      [['1', '2', '3'], {}, 2, 'usage: serve [--timeout-ms N] [max-evaluations [max-tokens]]'],
      [['-1'], {}, 2, 'unknown option; use -- before a literal command'],
      [['--timeout-ms', '0'], {}, 2, timeout],
      [['--timeout-ms', '86400001'], {}, 2, timeout],
      [['--stdin'], {}, 2, '--stdin is supported once, for exec only'],
      [['--label', 'x'], {}, 2, '--label is supported for start only'],
      [[], { JEV_FABRIC_TIMEOUT_MS: 'bad' }, 2, timeout],
      [[], { JEV_FABRIC_TIMEOUT_MS: '86400000' }, 2, timeout],
      [[], { JEV_FABRIC_JEV_TIMEOUT_MS: 'bad' }, 2, timeout],
      [[], { JEV_PROVIDER: 'elsewhere' }, 1, 'JEV_PROVIDER must be typesafe, openrouter, vercel, or subq'],
    ];
    const actual = [];
    for (const [args, env] of cases) {
      const r = await s.run(['serve', ...args], { env, input: '' });
      actual.push([args, env, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, env, code, message]) => [args, env, code, '', message]));
  });

  test('stdin may be a socket, as Node, Bun and libuv children get', async () => {
    const s = fx.store();
    const py = `
import json, socket, subprocess, sys
a, b = socket.socketpair()
p = subprocess.Popen([sys.argv[1], '--', 'serve'], stdin=b, stdout=subprocess.PIPE)
b.close()
banner = json.loads(p.stdout.readline())
a.sendall(b'{"id":1,"op":"exec","argv":["/bin/echo","socket"]}\\n')
reply = json.loads(p.stdout.readline())
a.shutdown(socket.SHUT_WR)
print(json.dumps({"protocol": banner["ready"]["protocol"], "stdout": reply["result"]["stdout"], "code": p.wait()}))
`;
    const child = Bun.spawn(['/usr/bin/python3', '-c', py, BIN], { env: s.env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ protocol: 2, stdout: 'socket\n', code: 0 });
  });

  test('exec answers process receipts; failing commands are receipts, unlaunchable ones errors', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    await c.send({ id: 1, op: 'exec', argv: ['/bin/sh', '-c', 'printf "a\\tb\\001 é\\n"'] });
    expectLine(c.rawById.get(1), { id: 1, ok: true, result: processReceipt({ state: 'exited', exitCode: 0, stdout: 'a\tb\u0001 é\n' }) }, 'std');
    await c.send({ id: 2, op: 'exec', argv: ['/bin/cat'], stdin: 'piped\n' });
    expectLine(c.rawById.get(2), { id: 2, ok: true, result: processReceipt({ state: 'exited', exitCode: 0, stdout: 'piped\n' }) }, 'std');
    await c.send({ id: 3, op: 'exec', argv: ['/bin/sh', '-c', 'echo no >&2; exit 3'] });
    expectLine(c.rawById.get(3), { id: 3, ok: true, result: processReceipt({ state: 'failed', exitCode: 3, stderr: 'no\n' }) }, 'std');
    const missing = await c.send({ id: 4, op: 'exec', argv: [join(fx.root, 'missing')] });
    expect(missing).toEqual({ id: 4, ok: false, error: { code: 2, message: 'native subprocess request failed' } });
    await c.send({ id: 5, op: 'exec', argv: ['/bin/sleep', '5'], timeoutMs: 200 });
    expectLine(c.rawById.get(5), { id: 5, ok: true, result: processReceipt({ state: 'timed_out', exitCode: 124 }) }, 'std');
    const literal = await c.ok({ id: 6, op: 'exec', argv: ['/bin/echo', '--timeout-ms', '$HOME', '--'] });
    expect(literal.stdout).toBe('--timeout-ms $HOME --\n');
    const big = await c.ok({ id: 7, op: 'exec', argv: ['/bin/sh', '-c', 'head -c 100000 /dev/zero | tr "\\0" x; printf END'] });
    expect([big.stdout.length, big.stdout.slice(-3), big.truncated]).toEqual([32768, 'END', { stdout: true, stderr: false }]);
    const cwd = await c.ok({ id: 8, op: 'exec', argv: ['/bin/pwd'], cwd: '/' });
    expect(cwd.stdout).toBe('/\n');
    expect((await c.ok({ id: 9, op: 'exec', argv: ['/bin/echo', 'still here'] })).stdout).toBe('still here\n');
    expect(await c.close()).toEqual({ code: 0, err: '' });
  });

  test('requests are strict: every malformed request gets a correlated error and the session continues', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const Z = 'a'.repeat(32);
    const unknownOp = 'unknown op: use exec, start, spawn, write, closeInput, read, status, events, wait, stop, watch, list, '
      + 'capabilities, validate, jev, decide, validateDecision or decisionProviders';
    const cases: [unknown, unknown, number, string][] = [
      [{ id: 'a', op: 'launch' }, 'a', 2, unknownOp],
      [{ id: 'b', op: 'exec', argv: ['/bin/echo'], timeout: 5 }, 'b', 2, 'unknown request field: timeout'],
      [{ id: 'c', op: 'exec' }, 'c', 2, 'missing field: argv'],
      [{ id: 'd', op: 'exec', argv: [] }, 'd', 2, 'argv must be an array of 1 to 57 strings'],
      [{ id: 'e', op: 'exec', argv: [''] }, 'e', 2, 'argv[0] must name a command'],
      [{ id: 'f', op: 'exec', argv: ['/bin/echo', 1] }, 'f', 2, 'argv entries must be a string'],
      [{ id: 'g', op: 'exec', argv: Array(58).fill('/bin/echo') }, 'g', 2, 'argv must be an array of 1 to 57 strings'],
      [{ id: 'g2', op: 'exec', argv: 'x' }, 'g2', 2, 'argv must be an array of 1 to 57 strings'],
      [{ id: 'g3', op: 'exec', argv: ['/bin/echo', 'x'.repeat(4097)] }, 'g3', 22, 'jev-fabric could not run the request: native subprocess request failed'],
      [{ id: 'h', op: 'exec', argv: ['/bin/echo'], timeoutMs: 0 }, 'h', 2, 'timeoutMs must be an integer from 1 to 3600000'],
      [{ id: 'h2', op: 'exec', argv: ['/bin/echo'], timeoutMs: 1.5 }, 'h2', 2, 'timeoutMs must be an integer from 1 to 3600000'],
      [{ id: 'h3', op: 'exec', argv: ['/bin/echo'], timeoutMs: '5' }, 'h3', 2, 'timeoutMs must be an integer from 1 to 3600000'],
      [{ id: 'h4', op: 'exec', argv: ['/bin/echo'], stdin: 5 }, 'h4', 2, 'stdin must be a string'],
      [{ id: 'h5', op: 'exec', argv: ['/bin/pwd'], cwd: 'relative' }, 'h5', 2, 'cwd must be an absolute path'],
      // A path made unique under this file's root, so it cannot exist on any machine.
      [{ id: 'h6', op: 'exec', argv: ['/bin/pwd'], cwd: join(fx.root, 'no-such-directory') }, 'h6', 2, 'cwd must be an existing directory'],
      [{ id: 'i', op: 'watch', job: 'x', literal: 'y', timeoutMs: 300001 }, 'i', 2, 'timeoutMs must be an integer from 1 to 300000'],
      [{ id: 'i3', op: 'watch', job: Z }, 'i3', 2, 'missing field: literal'],
      [{ id: 'j', op: 'status', job: '--help' }, 'j', 2, 'job must be an id returned by start'],
      [{ id: 'j2', op: 'status', job: '' }, 'j2', 2, 'job must be an id returned by start'],
      [{ id: 'j3', op: 'status' }, 'j3', 2, 'missing field: job'],
      [{ id: 'j4', op: 'status', job: Z }, 'j4', 2, NOT_FOUND],
      [{ id: 'j5', op: 'status', job: '../x' }, 'j5', 22, NOT_FOUND],
      [{ id: 'j6', op: 'status', job: 7 }, 'j6', 2, 'job must be a string'],
      [{ id: 'k', op: 'events', job: 'x', after: -1 }, 'k', 2, 'after must be an event sequence number'],
      [{ id: 'k2', op: 'events', job: 'x', after: 1.5 }, 'k2', 2, 'after must be an event sequence number'],
      [{ id: 'l', op: 'events', job: 'x', waitMs: 0 }, 'l', 2, 'waitMs must be an integer from 1 to 300000'],
      [{ id: 'm', op: 'events', job: 'x', waitMs: 300001 }, 'm', 2, 'waitMs must be an integer from 1 to 300000'],
      [{ id: 'n', op: 'start', argv: ['/bin/echo'], timeoutMs: 86400001 }, 'n', 2, 'timeoutMs must be an integer from 1 to 86400000'],
      [{ id: 'n2', op: 'start', argv: ['/bin/echo'], input: 'file' }, 'n2', 2, 'input must be "pipe" or "null"'],
      [{ id: 'n3', op: 'start', argv: ['/bin/echo'], stdin: 'x' }, 'n3', 2, 'unknown request field: stdin'],
      [{ id: 'o', op: 'wait', job: 'x', timeoutMs: 3600001 }, 'o', 2, 'timeoutMs must be an integer from 1 to 3600000'],
      [{ id: 'p', op: 'start', argv: ['/bin/echo'], label: '' }, 'p', 2, 'label must be 1..120 printable characters on one line'],
      [{ id: 'q', op: 'start', argv: ['/bin/echo'], label: 'a\nb' }, 'q', 2, 'label must be 1..120 printable characters on one line'],
      [{ id: 'r', op: 'start', argv: ['/bin/echo'], label: 7 }, 'r', 2, 'label must be a string'],
      [{ id: 's', op: 'list', job: 'x' }, 's', 2, 'unknown request field: job'],
      [{ id: { nested: true }, op: 'status', job: 'x' }, null, 2, 'id must be a string or number'],
      [[1, 2], null, 2, 'request must be a JSON object'],
      ['str', null, 2, 'request must be a JSON object'],
      [{ id: 'x'.repeat(129), op: 'capabilities' }, 'x'.repeat(129), 22, 'id must be at most 128 characters'],
      [{ id: 't', op: 'capabilities', extra: 1 }, 't', 2, 'unknown request field: extra'],
      [{ id: 'u' }, 'u', 2, 'missing field: op'],
      [{ id: 'v', op: 7 }, 'v', 2, 'op must be a string'],
      [{ id: 'w', op: 'validate' }, 'w', 2, 'missing field: request'],
      [{ id: 'w2', op: 'validate', request: { state: 'x', questions: {} } }, 'w2', 22, 'invalid question count'],
      [{ id: 'w3', op: 'validate', request: 'x' }, 'w3', 22, 'expected wire object'],
      [{ id: 'z', op: 'write', job: Z }, 'z', 2, 'missing field: text'],
      [{ id: 'z2', op: 'write', job: Z, text: 'x' }, 'z2', 2, NOT_FOUND],
      [{ id: 'z3', op: 'closeInput', job: Z }, 'z3', 2, NOT_FOUND],
      [{ id: 'z4', op: 'read', job: Z, stream: 'stdout' }, 'z4', 2, NOT_FOUND],
      [{ id: 'z5', op: 'stop', job: Z }, 'z5', 2, NOT_FOUND],
      [{ id: 'z6', op: 'wait', job: Z, timeoutMs: 100 }, 'z6', 2, NOT_FOUND],
      [{ id: 'zc', op: 'decisionProviders', x: 1 }, 'zc', 2, 'unknown request field: x'],
    ];
    const actual = [];
    for (const [request, id] of cases) {
      c.write(JSON.stringify(request) + '\n');
      actual.push(await c.response(id));
      c.arrived.length = 0;
    }
    expect(actual).toEqual(cases.map(([, id, code, message]) => ({ id, ok: false, error: { code, message } })));
    // Lines that are not strict JSON are answered with a null id. Oracle 0.8.1: the code is not from the
    // documented table but the strict parser's failure position.
    const lines: [string, number, string][] = [
      ['{"id":1,"id":2,"op":"status","job":"x"}', 22, 'request line is not strict JSON: duplicate JSON key'],
      ['nope', 1, 'request line is not strict JSON: bad literal'],
      ['{"id":5,"op":"capabilities"', 27, 'request line is not strict JSON: unexpected end'],
    ];
    const parsed = [];
    for (const [line] of lines) {
      c.write(line + '\n');
      parsed.push(await c.response(null));
      c.arrived.length = 0;
    }
    expect(parsed).toEqual(lines.map(([, code, message]) => ({ id: null, ok: false, error: { code, message } })));
    expect((await c.ok({ id: 99, op: 'exec', argv: ['/bin/echo', 'ok'] })).stdout).toBe('ok\n');
    expect((await c.close()).code).toBe(0);
  });

  test('ids are echoed verbatim: strings up to 128 characters and numbers', async () => {
    const s = fx.store();
    const c = new Serve([], s.env);
    fx.track(c.child);
    expect(await c.lines.json()).toHaveProperty('ready');
    for (const [line, raw] of [
      ['{"id":"é\\u0001","op":"validate","request":{"state":"a\\u0001\\n/","questions":{"q":{"type":"noul","instructions":"x"}}}}',
        '{"id":"é\\u0001","ok":true,"result":{"state":"a\\u0001\\n/","questions":{"q":{"type":"noul","instructions":"x"}}}}'],
      [`{"id":"${'x'.repeat(128)}","op":"validate","request":${JSON.stringify(noul)}}`,
        `{"id":"${'x'.repeat(128)}","ok":true,"result":${JSON.stringify(noul)}}`],
      ['{"id":0,"op":"validate","request":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}',
        '{"id":0,"ok":true,"result":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}'],
      ['{"id":-3,"op":"validate","request":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}',
        '{"id":-3,"ok":true,"result":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}'],
      ['{"id":1.50,"op":"validate","request":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}',
        '{"id":1.50,"ok":true,"result":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}'],
      ['{"id":1e3,"op":"validate","request":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}',
        '{"id":1e3,"ok":true,"result":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}'],
      ['{"op":"validate","request":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}',
        '{"id":null,"ok":true,"result":{"state":"x","questions":{"q":{"type":"noul","instructions":"y"}}}}'],
    ]) {
      c.write(line + '\n');
      expect(await c.lines.next()).toBe(raw);
    }
    await c.close();
  });

  test('framing: blank lines skipped, CRLF accepted, an unterminated last line answered at end of input', async () => {
    const s = fx.store();
    const c = new Serve([], s.env);
    fx.track(c.child);
    expect(await c.lines.json()).toHaveProperty('ready');
    c.write('\n\r\n{"id":1,"op":"exec","argv":["/bin/echo","crlf"]}\r\n');
    expect((await c.lines.json()).result.stdout).toBe('crlf\n');
    // Only empty lines are blank: a line of spaces is malformed JSON (oracle 0.8.1: its code is the parse offset).
    c.write('   \n');
    expect(await c.lines.next()).toBe('{"id":null,"ok":false,"error":{"code":3,"message":"request line is not strict JSON: unexpected end"}}');
    c.write('{"id":2,"op":"exec","argv":["/bin/echo","a"]}\n{"id":3,"op":"exec","argv":["/bin/echo","b"]}\n');
    const pair = [await c.lines.json(), await c.lines.json()].sort((a, b) => a.id - b.id);
    expect(pair.map(r => [r.id, r.result.stdout])).toEqual([[2, 'a\n'], [3, 'b\n']]);
    c.write('{"id":4,"op":"exec","argv":["/bin/echo","last"]}');
    c.child.stdin.end();
    expect(await c.lines.json()).toMatchObject({ id: 4, ok: true, result: { stdout: 'last\n' } });
    expect(await c.lines.next()).toBeUndefined();
    expect(await c.child.exited).toBe(0);
  });

  test('a partial line beyond 16 MiB ends the session with exit 2', async () => {
    const s = fx.store();
    const c = new Serve([], s.env);
    fx.track(c.child);
    await c.lines.json();
    c.write('{"id":1,"op":"exec","argv":["' + 'x'.repeat(16777240));
    expect(await c.lines.next()).toBe('{"id":null,"ok":false,"error":{"code":2,"message":"request line exceeds 16 MiB"}}');
    c.child.stdin.end();
    const [code, err] = await Promise.all([c.child.exited, new Response(c.child.stderr).text()]);
    expect([code, err]).toEqual([2, 'request line exceeds 16 MiB\n']);
  });

  test('requests run concurrently: responses may arrive out of order, matched by id', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const slow = c.send({ id: 'slow', op: 'exec', argv: ['/bin/sh', '-c', 'sleep 0.8; echo slow'] });
    const fast = c.send({ id: 'fast', op: 'exec', argv: ['/bin/echo', 'fast'] });
    const offline = c.send({ id: 'caps', op: 'capabilities' });
    expect((await fast).result.stdout).toBe('fast\n');
    await offline;
    expect(c.arrived.map(line => line.id).slice(0, 2).sort()).toEqual(['caps', 'fast']);
    expect((await slow).result.stdout).toBe('slow\n');
    expect(c.arrived.map(line => line.id).at(-1)).toBe('slow');
    // Ending input waits for every request in flight to answer.
    const pending = c.send({ id: 'last', op: 'exec', argv: ['/bin/sh', '-c', 'sleep 0.3; echo done'] });
    const closed = c.close();
    expect((await pending).result.stdout).toBe('done\n');
    expect(await closed).toEqual({ code: 0, err: '' });
  });

  test('the session deadline cuts requests to fit its receipt grace, then ends the session with 124', async () => {
    const s = fx.store();
    const c = await serve(fx, s, ['--timeout-ms', '2600']);
    const begin = performance.now();
    const cut = await c.send({ id: 1, op: 'exec', argv: ['/bin/sleep', '5'], timeoutMs: 60000 });
    expect(cut).toEqual({ id: 1, ok: true, result: processReceipt({ state: 'timed_out', exitCode: 124 }) });
    expect(performance.now() - begin).toBeLessThan(2500);
    await Bun.sleep(100);
    const late = await c.send({ id: 2, op: 'validate', request: noul });
    expect(late).toEqual({ id: 2, ok: false, error: { code: 124, message: 'serve deadline expired' } });
    const { code, err } = await c.close();
    expect(code).toBe(124);
    expect(err).toBe('serve deadline expired\n');
  });

  test('validate runs in process with the strict Jev request contract', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    expect(await c.send({ id: 1, op: 'validate', request: noul })).toEqual({ id: 1, ok: true, result: noul });
    expect(await c.send({ id: 2, op: 'validate', request: { ...noul, extra: 1 } }))
      .toEqual({ id: 2, ok: false, error: { code: 22, message: 'unknown request field' } });
    await c.close();
  });
});

describe.concurrent('serve job operations', () => {
  test('start, watch, wait, status, events and stop answer the CLI’s records', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const release = join(fx.root, 'serve-release');
    const job = (await c.ok({ id: 1, op: 'start', label: 'svc',
      argv: ['/bin/sh', '-c', 'echo booting; while [ ! -f "$1" ]; do sleep 0.02; done; echo ready; echo done', 'sh', release] })).id;
    expect(c.rawById.get(1)).toBe(`{"id":1,"ok":true,"result":{"id":"${job}"}}`);
    s.started.add(job);
    const watching = c.send({ id: 2, op: 'watch', job, literal: 'ready', timeoutMs: 10000 });
    await c.send({ id: 3, op: 'status', job });
    expectLine(c.rawById.get(3), { id: 3, ok: true, result: running(job, { label: 'svc' }) }, 'std');
    writeFileSync(release, 'go');
    const watched = await watching;
    expect(watched.result.filter((r: any) => r.type === 'monitor.batch').flatMap((r: any) => r.lines)).toEqual([{ text: 'ready', clipped: false }]);
    expect(watched.result.at(-1)).toMatchObject({ type: 'monitor.end', terminal: true });
    const receipt = jobReceipt(job, { label: 'svc', state: 'exited', exitCode: 0, stdout: 'booting\nready\ndone\n' });
    await c.send({ id: 4, op: 'wait', job, timeoutMs: 5000 });
    expectLine(c.rawById.get(4), { id: 4, ok: true, result: receipt }, 'std');
    expect(await c.ok({ id: 5, op: 'status', job })).toEqual(receipt);
    const events = await c.ok({ id: 6, op: 'events', job });
    expect(events).toEqual(JSON.parse('[' + (await s.ok(['events', job])).trim().split('\n').join(',') + ']'));
    expect(await c.ok({ id: 7, op: 'events', job, after: events[1].sequence })).toEqual(events.slice(2));
    expect(await c.ok({ id: 8, op: 'stop', job })).toEqual(receipt);
    expect(await c.ok({ id: 9, op: 'events', job, after: events.at(-1).sequence })).toEqual([]);
    await c.close();
  });

  test('jobs outlive the session; another session or the CLI controls them', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'start', argv: ['/bin/sleep', '30'], timeoutMs: 86400000 })).id;
    s.started.add(job);
    const waited = await c.send({ id: 'w', op: 'wait', job, timeoutMs: 300 });
    expect(waited).toEqual({ id: 'w', ok: true, result: running(job) });
    await c.close();
    const d = await serve(fx, s);
    expect(await d.ok({ op: 'status', job })).toEqual(running(job));
    const stopped = await d.ok({ op: 'stop', job });
    expect(stopped).toEqual(jobReceipt(job, { state: 'cancelled', exitCode: 143 }));
    await d.close();
    expect(JSON.parse(await s.ok(['status', job]))).toEqual(stopped);
  });

  test('events long-polls with waitMs; list answers the store listing', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const release = join(fx.root, 'serve-poll-release');
    const job = (await c.ok({ op: 'start', label: 'long poll',
      argv: ['/bin/sh', '-c', 'while [ ! -f "$1" ]; do sleep 0.02; done; echo late', 'sh', release] })).id;
    s.started.add(job);
    let begin = performance.now();
    expect(await c.send({ id: 'q', op: 'events', job, after: 1, waitMs: 100 })).toEqual({ id: 'q', ok: true, result: [] });
    expect(performance.now() - begin).toBeGreaterThanOrEqual(90);
    expect(await c.ok({ op: 'events', job, after: 1 })).toEqual([]);
    setTimeout(() => writeFileSync(release, 'go'), 300);
    begin = performance.now();
    const later = await c.ok({ op: 'events', job, after: 1, waitMs: 20000 });
    expect(performance.now() - begin).toBeLessThan(10000);
    expect(later.length).toBeGreaterThan(0);
    await c.ok({ op: 'wait', job, timeoutMs: 5000 });
    const last = (await c.ok({ op: 'events', job })).at(-1);
    begin = performance.now();
    expect(await c.ok({ op: 'events', job, after: last.sequence, waitMs: 20000 })).toEqual([]);
    expect(performance.now() - begin).toBeLessThan(3000);
    const listed = await c.ok({ op: 'list' });
    expect(listed).toEqual(JSON.parse(await s.ok(['list'])));
    expect(listed.jobs).toEqual([{ id: job, state: 'exited', label: 'long poll', startedAt: listed.jobs[0].startedAt, exitCode: 0 }]);
    await c.close();
  });

  test('start honours input pipe; write, closeInput and read reach a durable job', async () => {
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'start', argv: ['/bin/cat'], input: 'pipe' })).id;
    s.started.add(job);
    const reading = c.send({ id: 'r', op: 'read', job, stream: 'stdout', waitMs: 10000 });
    expect(await c.ok({ op: 'write', job, text: 'durable\n' })).toEqual({ id: job, written: 8, closed: false });
    expect((await reading).result).toEqual({ id: job, stream: 'stdout', offset: 0, bytes: 8, omittedBytes: 0, text: 'durable\n', next: 8, eof: false, state: 'running' });
    expect(await c.ok({ op: 'closeInput', job })).toEqual({ id: job, written: 0, closed: true });
    expect(await c.ok({ op: 'wait', job, timeoutMs: 5000 })).toEqual(jobReceipt(job, { state: 'exited', exitCode: 0, stdout: 'durable\n' }));
    expect(await c.send({ id: 'late', op: 'write', job, text: 'x' })).toEqual({ id: 'late', ok: false, error: { code: 1, message: 'job has finished' } });
    const batch = (await c.ok({ op: 'start', argv: ['/bin/echo'] })).id;
    s.started.add(batch);
    expect(await c.send({ id: 'np', op: 'write', job: batch, text: 'x' }))
      .toEqual({ id: 'np', ok: false, error: { code: 22, message: 'job was not started with --input pipe' } });
    await c.close();
  });

  test('oracle 0.8.1: a watch whose CLI step rejects its literal answers an empty array, not an error', async () => {
    // docs/serve-protocol.md implies code 2; the oracle relays the failed step's empty output instead.
    const s = fx.store();
    const c = await serve(fx, s);
    const job = (await c.ok({ op: 'start', argv: ['/bin/echo'] })).id;
    s.started.add(job);
    expect(await c.send({ id: 1, op: 'watch', job, literal: '' })).toEqual({ id: 1, ok: true, result: [] });
    // Likewise exec stdin beyond the documented 128 KiB is accepted.
    expect((await c.ok({ op: 'exec', argv: ['/bin/sh', '-c', 'wc -c'], stdin: 'x'.repeat(131073) })).stdout.trim()).toBe('131073');
    await c.close();
  });
});

test('nothing in this file reached the network', () => {
  expect(fx.networkAttempts()).toBe('');
  void run;
});
