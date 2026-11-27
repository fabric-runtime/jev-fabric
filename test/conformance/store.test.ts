// The storage home: its format marker, adoption of older homes, refusal of
// newer ones, the default root's .gitignore and --cwd independence.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEND_RUN, Fixture, expectOut, run, serve } from './harness.ts';

const fx = new Fixture('store');
afterAll(() => fx.cleanup());

const marker = (dir: string) => join(dir, '.jev-fabric-store.json');
const MARKER = '{"store":1}\n';
const NEWER = (n: number) => `storage home uses store format ${n}; this jev-fabric supports store format 1 (upgrade jev-fabric to use it)\n`;

describe.concurrent('store', () => {
  test('a new home records {"store":1} privately at once; list never shows the marker', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/echo', 'hi']);
    expect(readFileSync(marker(s.home), 'utf8')).toBe(MARKER);
    expect(statSync(marker(s.home)).mode & 0o777).toBe(0o600);
    expect(statSync(s.home).mode & 0o777).toBe(0o700);
    await s.wait(id);
    expect(JSON.parse(await s.ok(['list'])).jobs.map((j: any) => j.id)).toEqual([id]);
    // A JEV_FABRIC_HOME root is never given a .gitignore.
    expect(readdirSync(s.home).sort()).toEqual(['.jev-fabric-store.json', id]);
    // Even a reading verb writes the marker when it creates the home.
    const fresh = fx.store();
    expectOut(await fresh.ok(['list']), [{ jobs: [], truncated: false }]);
    expect(readFileSync(marker(fresh.home), 'utf8')).toBe(MARKER);
  });

  test('an existing home without a marker is adopted by its first writing verb, never by a read', async () => {
    const s = fx.store();
    mkdirSync(s.home, { mode: 0o700 });
    for (const args of [['list'], ['events', 'a'.repeat(32)], ['read', 'a'.repeat(32), 'stdout'],
      ['follow', '--timeout-ms', '10', 'a'.repeat(32)], ['watch', '--timeout-ms', '10', 'a'.repeat(32), 'x']]) {
      await s.run(args);
      expect(existsSync(marker(s.home)), args.join(' ')).toBe(false);
    }
    await s.run(['status', 'a'.repeat(32)]);
    expect(readFileSync(marker(s.home), 'utf8')).toBe(MARKER);
    for (const args of [['start', '/bin/echo'], ['wait', 'a'.repeat(32)], ['stop', 'a'.repeat(32)]]) {
      const other = fx.store();
      mkdirSync(other.home, { mode: 0o700 });
      await other.run(args);
      expect(readFileSync(marker(other.home), 'utf8'), args.join(' ')).toBe(MARKER);
    }
  });

  test('a home with a newer store format is refused by every store verb (22) and never rewritten', async () => {
    const s = fx.store();
    const id = await s.start(['/bin/echo', 'old']);
    await s.wait(id);
    const newer = '{"store":2,"note":"written by a later release"}\n';
    writeFileSync(marker(s.home), newer, { mode: 0o600 });
    const verbs = [
      ['start', '/bin/echo', 'x'], ['status', id], ['wait', id], ['stop', id], ['events', id],
      ['follow', '--timeout-ms', '100', id], ['watch', '--timeout-ms', '100', id, 'x'], ['list'],
      ['read', id, 'stdout'], ['write', id, '--', 'x'], ['close-input', id],
      // `run` prepares its directory in the store before the program starts:
      // 0.8.1 compiled a .bend source there, later builds run a .ts program.
      ['run', '--timeout-ms', '1000', BEND_RUN ? 'missing.bend' : 'missing.ts'],
    ];
    const actual = [];
    for (const args of verbs) {
      const r = await s.run(args);
      actual.push([args, r.code, r.out, r.err]);
    }
    expect(actual).toEqual(verbs.map(args => [args, 22, '', NEWER(2)]));
    expect(readFileSync(marker(s.home), 'utf8')).toBe(newer);
    // Verbs that do not touch the store still work.
    expect((await s.run(['exec', '/bin/echo'])).code).toBe(0);
    expect((await s.run(['capabilities'])).code).toBe(0);
  });

  test('an unreadable marker is refused (22) and left as it is', async () => {
    const contents = ['not json', '{"store":"1"}', '{}', '{"store":0}', '{"store":1.0}'];
    const actual = [];
    for (const content of contents) {
      const s = fx.store();
      mkdirSync(s.home, { mode: 0o700 });
      writeFileSync(marker(s.home), content, { mode: 0o600 });
      const r = await s.run(['list']);
      const w = await s.run(['start', '/bin/echo']);
      actual.push([content, r.code, r.out, r.err, w.code, readFileSync(marker(s.home), 'utf8')]);
    }
    const err = 'storage home marker .jev-fabric-store.json is not readable by this jev-fabric\n';
    expect(actual).toEqual(contents.map(content => [content, 22, '', err, 22, content]));
  });

  test('extra fields in a format-1 marker are accepted (changes within a store version are additive)', async () => {
    const s = fx.store();
    mkdirSync(s.home, { mode: 0o700 });
    const content = '{"store":1,"writer":"a later 0.x"}\n';
    writeFileSync(marker(s.home), content, { mode: 0o600 });
    const id = await s.start(['/bin/echo']);
    await s.wait(id);
    expect(readFileSync(marker(s.home), 'utf8')).toBe(content);
  });

  test('serve refuses a newer store per request (22) and the session continues', async () => {
    const s = fx.store();
    mkdirSync(s.home, { mode: 0o700 });
    writeFileSync(marker(s.home), '{"store":3}\n', { mode: 0o600 });
    const c = await serve(fx, s);
    const error = { code: 22, message: NEWER(3).trim() };
    expect(await c.send({ op: 'list' })).toEqual({ id: 1, ok: false, error });
    expect(await c.send({ op: 'spawn', argv: ['/bin/cat'] })).toEqual({ id: 2, ok: false, error });
    expect(await c.send({ op: 'start', argv: ['/bin/cat'] })).toMatchObject({ id: 3, ok: false, error: { code: 22 } });
    expect((await c.ok({ op: 'exec', argv: ['/bin/echo', 'ok'] })).stdout).toBe('ok\n');
    expect((await c.close()).code).toBe(0);
  });

  test('the default root .jev-fabric-native is created in the caller’s directory with a private .gitignore', async () => {
    const cwd = join(fx.root, 'fresh-project');
    mkdirSync(cwd);
    const env = { PATH: `${fx.guard}:/usr/bin:/bin`, JEV_FABRIC_HTTP: 'exec' };
    expectOut((await run(['list'], { env, cwd })).out, [{ jobs: [], truncated: false }]);
    const store = join(cwd, '.jev-fabric-native');
    expect(statSync(store).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(store, '.gitignore'), 'utf8')).toBe('*\n');
    expect(statSync(join(store, '.gitignore')).mode & 0o777).toBe(0o600);
    expect(readFileSync(marker(store), 'utf8')).toBe(MARKER);
    const { id } = JSON.parse((await run(['start', '/bin/echo', 'x'], { env, cwd })).out);
    await run(['wait', id], { env, cwd });
    expect(JSON.parse((await run(['list'], { env, cwd })).out).jobs.map((j: any) => j.id)).toEqual([id]);
    // An existing root is never given a .gitignore again.
    Bun.spawnSync(['/bin/rm', join(store, '.gitignore')]);
    await run(['list'], { env, cwd });
    expect(readdirSync(store).sort()).toEqual(['.jev-fabric-store.json', id]);
  });

  test('--cwd moves the command, never the storage home', async () => {
    const s = fx.store();
    const work = join(fx.root, 'cwd-work');
    mkdirSync(work, { recursive: true });
    const id = await s.start(['--cwd', work, '--label', 'here', '/bin/pwd']);
    expect(await s.wait(id)).toMatchObject({ stdout: `${realpathSync(work)}\n`, label: 'here', lifetime: 'durable' });
    expect(existsSync(join(s.home, id))).toBe(true);
    expect(readdirSync(work)).toEqual([]);
    const r = await s.run(['wait', '--cwd', work, id]);
    expect([r.code, r.err.trim()]).toEqual([2, '--cwd is supported for exec and start only']);
  });
});
