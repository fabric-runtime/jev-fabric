// `exec`: literal argv in an owned process group, bounded receipts, deadlines,
// signals and the timer configuration.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Fixture, TAIL, expectOut, gone, processReceipt, script, until } from './harness.ts';

const fx = new Fixture('exec');
afterAll(() => fx.cleanup());

const FAILED = 'subprocess did not complete successfully\n';
const pids = (receipt: any) => receipt.stdout.trim().split(/\s+/).map(Number) as number[];
/** A shell that ignores SIGTERM, with a background grandchild that ignores it too. */
const STUBBORN = 'trap "" TERM; (trap "" TERM; while :; do sleep 0.05; done) & echo $$ $!; : > "$1"; while :; do sleep 0.05; done';

describe.concurrent('exec', () => {
  test('a successful command prints one exact receipt and exits 0', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/bin/echo', 'hi']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out).toBe('{"schemaVersion":1,"state":"exited","exitCode":0,"timedOut":false,"cancelled":false,'
      + '"stdout":"hi\\u000a","stderr":"","truncated":{"stdout":false,"stderr":false}}\n');
  });

  test('a nonzero exit is a failed receipt with the child exit code; stdout and stderr stay apart', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/bin/sh', '-c', 'printf out; printf err >&2; exit 7']);
    expect([r.code, r.err]).toEqual([7, FAILED]);
    expectOut(r.out, [processReceipt({ state: 'failed', exitCode: 7, stdout: 'out', stderr: 'err' })]);
  });

  test('receipt text is escaped byte for byte: control characters as \\u00XX, the rest raw', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/bin/sh', '-c', 'printf "a\\tb\\"c\\\\\\\\d/e\\001\\037\\177 é 🙂 \\342\\200\\250 \\r\\n\\b\\f"']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe('{"schemaVersion":1,"state":"exited","exitCode":0,"timedOut":false,"cancelled":false,'
      + '"stdout":"a\\u0009b\\"c\\\\d/e\\u0001\\u001f\x7f é 🙂   \\u000d\\u000a\\u0008\\u000c","stderr":"",'
      + '"truncated":{"stdout":false,"stderr":false}}\n');
  });

  test('malformed UTF-8 becomes U+FFFD in text receipts', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/bin/sh', '-c', "printf '\\377A\\355\\240\\200B'; printf '\\360\\237' >&2"]);
    expect(r.code, r.err).toBe(0);
    const receipt = JSON.parse(r.out);
    expect([receipt.stdout, receipt.stderr]).toEqual(['�A���B', '�']);
  });

  test('argv is literal: no shell, no option parsing after the command, Unicode intact', async () => {
    const s = fx.store();
    const marker = join(fx.root, 'not-executed');
    const text = `🙂\n\t"\\ $(touch ${marker}); $HOME --timeout-ms 1`;
    const r = await s.run(['exec', '/bin/sh', '-c', 'printf "%s" "$1"', 'sh', text]);
    expect(JSON.parse(r.out).stdout).toBe(text);
    expect(existsSync(marker)).toBe(false);
    const literal = await s.run(['exec', '/bin/echo', '--timeout-ms', '$HOME', '--', '--stdin']);
    expect(JSON.parse(literal.out).stdout).toBe('--timeout-ms $HOME -- --stdin\n');
    const shell = await s.run(['exec', '/bin/sh', '-c', "cat <<'TEXT' | tr a-z A-Z\nhello native\nTEXT"]);
    expect(JSON.parse(shell.out).stdout).toBe('HELLO NATIVE\n');
  });

  test('a command-local -- runs numeric or option-like command names from PATH', async () => {
    const bin = join(fx.root, 'literal-bin');
    mkdirSync(bin, { recursive: true });
    script(join(bin, '123'), 'printf "%s\\n" "$@"');
    script(join(bin, '--stdin'), 'printf "literal-command:%s\\n" "$1"');
    const s = fx.store({ PATH: `${bin}:/usr/bin:/bin` });
    expect(JSON.parse(await s.ok(['exec', '--', '123', '--timeout-ms', 'x'])).stdout).toBe('--timeout-ms\nx\n');
    expect(JSON.parse(await s.ok(['exec', '--', '--stdin', 'argument'])).stdout).toBe('literal-command:argument\n');
    expect(JSON.parse(await s.ok(['exec', '--timeout-ms', '2000', '--', '123', 'y'])).stdout).toBe('y\n');
  });

  test('legacy positional timeouts and flag spellings are the same call', async () => {
    const s = fx.store();
    for (const prefix of [[], ['2000'], ['--timeout-ms', '2000']]) {
      expect(JSON.parse(await s.ok(['exec', ...prefix, '/bin/echo', 'x'])).stdout).toBe('x\n');
    }
    for (const prefix of [['--stdin'], ['2000', '--stdin'], ['--stdin', '--timeout-ms', '2000'], ['--timeout-ms', '2000', '--stdin']]) {
      expect(JSON.parse(await s.ok(['exec', ...prefix, '/bin/cat'], { input: 'streamed\n' })).stdout).toBe('streamed\n');
    }
  });

  test('stdin is empty unless --stdin, which streams input beyond the 128 KiB buffer', async () => {
    const s = fx.store();
    expect(JSON.parse(await s.ok(['exec', '/bin/cat'], { input: 'ignored\n' })).stdout).toBe('');
    const r = await s.run(['exec', '--stdin', '/bin/sh', '-c', 'wc -c'], { input: 'x'.repeat(200_000) });
    expect(r.code, r.err).toBe(0);
    expect(Number(JSON.parse(r.out).stdout.trim())).toBe(200_000);
  });

  test('receipts keep the last 32 KiB of each stream and disclose truncation', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/bin/sh', '-c',
      "head -c 100000 /dev/zero | tr '\\000' x; printf END; head -c 40000 /dev/zero | tr '\\000' y >&2; printf ERR >&2"]);
    expect(r.code, r.err).toBe(0);
    expectOut(r.out, [processReceipt({
      state: 'exited', exitCode: 0,
      stdout: 'x'.repeat(TAIL - 3) + 'END', stderr: 'y'.repeat(TAIL - 3) + 'ERR',
      truncated: { stdout: true, stderr: true },
    })]);
    const exact = await s.run(['exec', '/bin/sh', '-c', `head -c ${TAIL} /dev/zero | tr '\\000' z`]);
    expect(JSON.parse(exact.out).truncated).toEqual({ stdout: false, stderr: false });
  });

  test('a deadline is a timed_out receipt with exit 124', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '--timeout-ms', '100', '/bin/sleep', '5']);
    expect([r.code, r.err]).toEqual([124, FAILED]);
    expectOut(r.out, [processReceipt({ state: 'timed_out', exitCode: 124 })]);
    expect(r.ms).toBeLessThan(2000);
  });

  test('a deadline kills the whole process group at once, grandchildren and TERM-ignorers included', async () => {
    const s = fx.store();
    const marker = join(fx.root, 'deadline-started');
    const r = await s.run(['exec', '--timeout-ms', '300', '/bin/sh', '-c', STUBBORN, 'sh', marker]);
    expect(r.code).toBe(124);
    const receipt = JSON.parse(r.out);
    expect(receipt).toMatchObject({ state: 'timed_out', exitCode: 124, timedOut: true });
    const [child, grandchild] = pids(receipt);
    expect(child).toBeGreaterThan(1);
    expect(grandchild).toBeGreaterThan(1);
    // No 500 ms SIGTERM grace for a deadline: the group is killed outright.
    expect(r.ms).toBeLessThan(800);
    expect(await until(() => gone(child!) && gone(grandchild!), 1000)).toBe(true);
  });

  test('SIGTERM stops the owned group: SIGTERM, then SIGKILL after 500 ms; receipt cancelled, exit 143', async () => {
    const marker = join(fx.root, 'sigterm-started');
    const s = fx.store();
    const p = fx.track(Bun.spawn([s.bin, '--', 'exec', '60000', '/bin/sh', '-c', STUBBORN, 'sh', marker], {
      env: s.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    }));
    expect(await until(() => existsSync(marker), 5000)).toBe(true);
    const begin = performance.now();
    p.kill('SIGTERM');
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const elapsed = performance.now() - begin;
    expect([code, err]).toEqual([143, FAILED]);
    const receipt = JSON.parse(out);
    expectOut(out, [processReceipt({ state: 'cancelled', exitCode: 143, stdout: receipt.stdout })]);
    const [child, grandchild] = pids(receipt);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(3000);
    expect(gone(child!) && gone(grandchild!)).toBe(true);
  });

  test('SIGINT cancels a cooperative child promptly; receipt cancelled, exit 130', async () => {
    const marker = join(fx.root, 'sigint-started');
    const s = fx.store();
    const p = fx.track(Bun.spawn([s.bin, '--', 'exec', '60000', '/bin/sh', '-c', 'echo $$; : > "$1"; exec sleep 60', 'sh', marker], {
      env: s.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    }));
    expect(await until(() => existsSync(marker), 5000)).toBe(true);
    const begin = performance.now();
    p.kill('SIGINT');
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect([code, err]).toEqual([130, FAILED]);
    const receipt = JSON.parse(out);
    expectOut(out, [processReceipt({ state: 'cancelled', exitCode: receipt.exitCode, stdout: receipt.stdout })]);
    expect(performance.now() - begin).toBeLessThan(450);
    expect(gone(pids(receipt)[0]!)).toBe(true);
  });

  test('a missing executable is an error (2) with a sanitized message, not a receipt', async () => {
    const s = fx.store();
    const r = await s.run(['exec', '/nonexistent/SYNTHETIC_NOT_A_REAL_SECRET']);
    expect(r).toMatchObject({ code: 2, out: '', err: 'native subprocess request failed\n' });
  });

  test('argv bounds: 64 entries, each at most 4096 bytes; beyond either is refused (22)', async () => {
    const s = fx.store();
    expect((await s.run(['exec', '/bin/echo', ...Array(63).fill('x')])).code).toBe(0);
    expect((await s.run(['exec', '/bin/echo', 'x'.repeat(4096)])).code).toBe(0);
    const tooMany = await s.run(['exec', '/bin/echo', ...Array(64).fill('x')]);
    const tooLong = await s.run(['exec', '/bin/echo', 'x'.repeat(4097)]);
    expect([tooMany.code, tooMany.out, tooMany.err]).toEqual([22, '', 'native subprocess request failed\n']);
    expect([tooLong.code, tooLong.out, tooLong.err]).toEqual([22, '', 'native subprocess request failed\n']);
  });

  test('--cwd starts the command in an absolute existing directory without moving the store', async () => {
    const s = fx.store();
    const work = join(fx.root, 'exec work dir');
    mkdirSync(work, { recursive: true });
    expect(JSON.parse(await s.ok(['exec', '--cwd', work, '/bin/pwd'])).stdout).toBe(`${realpathSync(work)}\n`);
    expect(existsSync(join(work, '.jev-fabric-native'))).toBe(false);
    const cases: [string[], string][] = [
      [['exec', '--cwd', 'relative', '/bin/pwd'], 'cwd must be an absolute path'],
      [['exec', '--cwd', join(fx.root, 'missing'), '/bin/pwd'], 'cwd must be an existing directory'],
      [['exec', '--cwd'], '--cwd requires a directory'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([, message]) => [2, '', message]));
  });

  test('JEV_FABRIC_TIMEOUT_MS bounds exec; explicit limits replace it; malformed limits never launch', async () => {
    const s = fx.store();
    const timed = await s.run(['exec', '/bin/sleep', '1'], { env: { JEV_FABRIC_TIMEOUT_MS: '40' } });
    expect(timed.code).toBe(124);
    expect(JSON.parse(timed.out).timedOut).toBe(true);
    for (const prefix of [['1000'], ['--timeout-ms', '1000']]) {
      const override = await s.run(['exec', ...prefix, '/bin/echo'], { env: { JEV_FABRIC_TIMEOUT_MS: 'invalid' } });
      expect(override.code, override.err).toBe(0);
    }
    const marker = join(fx.root, 'must-not-run');
    const outcomes: [string, number, string, string][] = [];
    for (const raw of ['0', '-1', '1.5', '3600001', '86400000', '4294967297', 'words', ' 5']) {
      for (const [args, env] of [
        [['exec', '--timeout-ms', raw, '/usr/bin/touch', marker], {}],
        [['exec', '/usr/bin/touch', marker], { JEV_FABRIC_TIMEOUT_MS: raw }],
      ] as [string[], Record<string, string>][]) {
        const r = await s.run(args, { env });
        outcomes.push([raw, r.code, r.out, r.err.trim()]);
      }
    }
    expect(outcomes).toEqual(outcomes.map(([raw]): [string, number, string, string] => [raw, 2, '', 'timeout must be an integer within the operation limit']));
    expect(existsSync(marker)).toBe(false);
    // Empty configuration uses the default.
    expect((await s.run(['exec', '/bin/echo'], { env: { JEV_FABRIC_TIMEOUT_MS: '' } })).code).toBe(0);
  });

  test('malformed option sequences are usage errors (2)', async () => {
    const s = fx.store();
    const cases: [string[], string][] = [
      [['exec'], 'command or file is required'],
      [['exec', '--timeout-ms'], '--timeout-ms requires milliseconds'],
      [['exec', 'oops', '/bin/echo'], 'native subprocess request failed'],
      [['exec', '--stdin', '--stdin', '/bin/echo'], '--stdin is supported once, for exec only'],
      [['exec', '--timeout-ms', '3', '4', '/bin/echo'], 'specify the timeout only once'],
      [['exec', '--label', 'a', '/bin/echo'], '--label is supported for start only'],
      [['exec', '--input', 'pipe', '/bin/cat'], '--input is supported for start only'],
      [['exec', '--bogus', '/bin/echo'], 'unknown option; use -- before a literal command'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, message]) => [args, 2, '', message]));
  });

  test('runs with no Node or Bun on PATH', async () => {
    const s = fx.store({ PATH: join(fx.root, 'no-tools') });
    expect(JSON.parse(await s.ok(['exec', '/bin/echo', 'native'])).stdout).toBe('native\n');
  });
});
