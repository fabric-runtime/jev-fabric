// Top-level CLI surface: version, help, capabilities, the `--` spelling,
// unknown commands, `run` argument errors and `update`.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEND_RUN, FEATURES, Fixture, JOB_USAGE, expectOut, run, script, vary } from './harness.ts';

const fx = new Fixture('cli');
afterAll(() => fx.cleanup());

describe.concurrent('cli', () => {
  test('capabilities is one JSON line: version, protocol 2, store 1, platform, features', async () => {
    const s = fx.store();
    const r = await s.run(['capabilities']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    expectOut(r.out, [{
      version: vary.text(/^\d+\.\d+\.\d+-native$/),
      protocol: 2,
      store: 1,
      platform: vary.text(/^(darwin|linux)-(arm64|x64)$/),
      features: vary.where('the 0.8.1 features, in order, then only additions',
        v => Array.isArray(v) && FEATURES.every((f, i) => v[i] === f)),
    }]);
    const caps = JSON.parse(r.out);
    expect(caps.platform).toBe(`${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
    // capabilities never touches the store.
    expect(await Bun.file(join(s.home, '.jev-fabric-store.json')).exists()).toBe(false);
    const extra = await s.run(['capabilities', 'x']);
    expect([extra.code, extra.out, extra.err]).toEqual([2, '', `${JOB_USAGE}\n`]);
  });

  test('--version prints the capabilities version on one line and touches no store', async () => {
    const s = fx.store();
    const caps = JSON.parse((await s.run(['capabilities'])).out);
    const r = await s.run(['--version']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const match = /^(\S+)( \([^\n]+\))?\n$/.exec(r.out);
    expect(match?.[1]).toBe(caps.version);
    const extra = await s.run(['--version', 'x']);
    expect([extra.code, extra.out, extra.err]).toEqual([2, '', `${JOB_USAGE}\n`]);
  });

  test('--help lists every verb and the timer configuration, exit 0', async () => {
    const s = fx.store();
    const r = await s.run(['--help']);
    expect(r.code).toBe(0);
    for (const verb of ['exec', 'run', 'validate', 'jev', 'decide', 'validate-decision', 'resolve-decision',
      'decision-providers', 'start', 'status', 'list', 'events', 'follow', 'watch', 'wait', 'stop', 'serve',
      'capabilities', 'update', '--timeout-ms', '--label', '--cwd', '--stdin',
      'JEV_FABRIC_TIMEOUT_MS', 'JEV_FABRIC_JEV_TIMEOUT_MS', 'JEV_FABRIC_WAIT_MS', 'JEV_FABRIC_WATCH_MS']) {
      expect(r.out, verb).toContain(verb);
    }
    // A malformed timer environment does not break help.
    expect((await s.run(['--help'], { env: { JEV_FABRIC_TIMEOUT_MS: 'invalid' } })).code).toBe(0);
  });

  test("'jev-fabric -- <command>' and 'jev-fabric <command>' are the same call", async () => {
    const s = fx.store();
    const commands = [
      ['--version'],
      ['capabilities'],
      ['exec', '2000', '/bin/echo', '--', 'a', '--', 'b'],
      ['exec', '--timeout-ms', '2000', '--', '/bin/echo', '--timeout-ms'],
      ['status', '../escape'],
      ['no-such-command'],
      ['list'],
    ];
    for (const args of commands) {
      const dashed = await s.run(args);
      const bare = await s.run(args, { bare: true });
      expect({ ...bare, ms: 0 }, args.join(' ')).toEqual({ ...dashed, ms: 0 });
    }
    expectOut((await s.run(['exec', '2000', '/bin/echo', '--', 'a', '--', 'b'])).out, [{
      schemaVersion: 1, state: 'exited', exitCode: 0, timedOut: false, cancelled: false,
      stdout: '-- a -- b\n', stderr: '', truncated: { stdout: false, stderr: false },
    }]);
    // A durable job started either way runs the same literal argv through its worker.
    for (const bare of [false, true]) {
      const r = await s.run(['start', '/bin/echo', '--', 'job'], { bare });
      const { id } = JSON.parse(r.out);
      s.started.add(id);
      expect((await s.json(['wait', id], { bare })).stdout).toBe('-- job\n');
    }
  });

  test('an unknown command is a usage error (2); no command at all prints help (0)', async () => {
    const s = fx.store();
    expect(await s.run(['no-such-command'])).toMatchObject({ code: 2, out: '', err: `${JOB_USAGE}\n` });
    const help = await s.run(['--help']);
    for (const bare of [false, true]) {
      expect(await s.run([], { bare })).toMatchObject({ code: 0, out: help.out, err: '' });
    }
  });

  test('run fails on bad arguments before compiling anything', async () => {
    const s = fx.store();
    // 0.8.1 compiled Bend sources; later builds run .ts/.js programs with their
    // embedded Bun and send a .bend source to the migration guide. Every check
    // before the program path is the same in both, in the same order.
    const program = BEND_RUN
      ? 'run requires 1..3600000 ms and a .bend source path (not an option)'
      : 'run requires 1..3600000 ms and a .ts or .js program path (not an option)';
    const cases: [string[], number, string][] = [
      [['run'], 2, 'command or file is required'],
      [['run', '0', 'x.bend'], 2, 'timeout must be an integer within the operation limit'],
      [['run', '--timeout-ms', '0', 'x.bend'], 2, 'timeout must be an integer within the operation limit'],
      [['run', '--timeout-ms', '3600001', 'x.bend'], 2, 'timeout must be an integer within the operation limit'],
      [['run', '--timeout-ms', 'oops', 'x.bend'], 2, 'timeout must be an integer within the operation limit'],
      [['run', '--timeout-ms'], 2, '--timeout-ms requires milliseconds'],
      [['run', '2000', '--evil.bend'], 2, program],
      [['run', '2000', '--evil.ts'], 2, program],
      [['run', '2000', BEND_RUN ? 'file.ts' : 'file.txt'], 2, program],
      [['run', '--stdin', 'x.bend'], 2, '--stdin is supported once, for exec only'],
      [['run', '--label', 'x', 'x.bend'], 2, '--label is supported for start only'],
      [['run', '--cwd', '/', 'x.bend'], 2, '--cwd is supported for exec and start only'],
      [['run', '--input', 'pipe', 'x.bend'], 2, '--input is supported for start only'],
      [['run', '--timeout-ms', '1000', '--timeout-ms', '1000', 'x.bend'], 2, 'specify the timeout only once'],
      ...(BEND_RUN ? [] : [
        [['run', '2000', 'x.bend'], 2, 'run executes TypeScript or JavaScript programs; Bend programs are no longer supported (see docs/bend-to-typescript.md)'],
      ] as [string[], number, string][]),
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await s.run(args, { env: { JEV_FABRIC_TIMEOUT_MS: '1000' } });
      actual.push([args, r.code, r.err.trim(), r.out]);
    }
    expect(actual).toEqual(cases.map(([args, code, err]) => [args, code, err, '']));
    // A malformed work default stops run before compiling, like every work verb.
    const bad = await s.run(['run', 'x.bend'], { env: { JEV_FABRIC_TIMEOUT_MS: 'invalid' } });
    expect([bad.code, bad.err.trim()]).toEqual([2, 'timeout must be an integer within the operation limit']);
  });

  test.skipIf(BEND_RUN)('run executes a TypeScript program: a missing one is a failed receipt (exit 1)', async () => {
    const s = fx.store();
    const missing = join(fx.root, 'missing-program.ts');
    const r = await s.run(['run', '--timeout-ms', '20000', missing]);
    expect([r.code, r.err]).toEqual([1, 'native program did not complete successfully\n']);
    const receipt = JSON.parse(r.out);
    // Bun's own message names the missing module; the rest is exact.
    expect(receipt.stderr).toContain(missing);
    expectOut(r.out, [{
      schemaVersion: 1, state: 'failed', exitCode: 1, timedOut: false, cancelled: false, stdout: '',
      stderr: receipt.stderr, truncated: { stdout: false, stderr: false },
    }]);
  });

  test('update shows and runs the curl installer, relaying its output and exit status', async () => {
    const bin = join(fx.root, 'update-bin');
    const record = join(fx.root, 'update-curl-args');
    mkdirSync(bin, { recursive: true });
    script(join(bin, 'curl'),
      `printf '%s\\n' "$@" > '${record}'`,
      `printf '%s\\n' 'echo "installed $FAKE_RELEASE"' 'echo "installer note" >&2' 'exit "$FAKE_EXIT"'`);
    const command = 'curl -fsSL https://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh | sh';
    const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_RELEASE: 'v9.9.9', FAKE_EXIT: '0' };
    const ok = await run(['update'], { env });
    expect(ok).toMatchObject({ code: 0, out: 'installed v9.9.9\n', err: `${command}\ninstaller note\n` });
    expect(readFileSync(record, 'utf8')).toBe('-fsSL\nhttps://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh\n');
    const failed = await run(['update'], { env: { ...env, FAKE_EXIT: '3' } });
    expect(failed).toMatchObject({ code: 3, out: 'installed v9.9.9\n' });
    const extra = await run(['update', 'now'], { env });
    expect(extra.code).toBe(2);
    expect(extra.out).toBe('');
  });
});
