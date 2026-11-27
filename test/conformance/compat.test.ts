// Store compatibility between two binaries sharing one storage home. Runs only
// when JEV_FABRIC_OTHER_BIN is set (for example to the 0.8.1 oracle while
// JEV_FABRIC_BIN names the port); every check runs in both directions.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN, Fixture, OTHER_BIN, Serve, gone, jobReceipt, running, until } from './harness.ts';

const fx = new Fixture('compat');
afterAll(() => fx.cleanup());

const directions: [string, string, string][] = OTHER_BIN
  ? [['bin → other', BIN, OTHER_BIN], ['other → bin', OTHER_BIN, BIN]]
  : [];
/** One home, driven by two binaries. */
function pair(first: string, second: string) {
  const a = fx.store({}, first);
  const b = fx.store({}, second, a.home);
  return { a, b };
}

describe.skipIf(!OTHER_BIN).concurrent('store compatibility (JEV_FABRIC_OTHER_BIN)', () => {
  test('both binaries advertise the same protocol and store format', async () => {
    const [x, y] = await Promise.all([BIN, OTHER_BIN!].map(bin => fx.store({}, bin).run(['capabilities'])));
    const [cx, cy] = [JSON.parse(x!.out), JSON.parse(y!.out)];
    expect([cx.protocol, cx.store]).toEqual([cy.protocol, cy.store]);
  });

  for (const [name, first, second] of directions) {
    test(`${name}: a finished job is listed, read, waited and replayed identically`, async () => {
      const { a, b } = pair(first, second);
      const id = await a.start(['--label', 'shared', '/bin/sh', '-c', 'printf "out\\n"; printf err >&2; exit 3']);
      const receipt = await a.ok(['wait', id]);
      expect(JSON.parse(receipt)).toEqual(jobReceipt(id, { label: 'shared', state: 'failed', exitCode: 3, stdout: 'out\n', stderr: 'err' }));
      for (const args of [['status', id], ['wait', id], ['stop', id], ['events', id], ['list'], ['follow', id],
        ['read', id, 'stdout'], ['read', '--base64', id, 'stderr'], ['watch', id, 'out']]) {
        const [x, y] = [await a.run(args), await b.run(args)];
        const strip = (text: string) => text.replace(/"elapsedMs":\d+/g, '"elapsedMs":0');
        expect([y.code, strip(y.out), y.err], args.join(' ')).toEqual([x.code, strip(x.out), x.err]);
      }
    });

    test(`${name}: a running job is seen as running and stopped by the other binary`, async () => {
      const { a, b } = pair(first, second);
      const id = await a.start(['--label', 'svc', '/bin/sh', '-c', 'echo $$; exec sleep 60']);
      expect(await until(async () => (await b.json(['read', id, 'stdout'])).bytes > 0, 5000)).toBe(true);
      const pid = Number((await b.json(['read', id, 'stdout'])).text.trim());
      expect(await b.json(['status', id])).toEqual(running(id, { label: 'svc' }));
      expect((await b.json(['list'])).jobs).toEqual([{ id, state: 'running', label: 'svc', startedAt: expect.any(Number) }]);
      const stopped = await b.ok(['stop', id]);
      expect(JSON.parse(stopped)).toEqual(jobReceipt(id, { label: 'svc', state: 'cancelled', exitCode: 143, stdout: `${pid}\n` }));
      expect(gone(pid)).toBe(true);
      expect(await a.ok(['status', id])).toBe(stopped);
    });

    test(`${name}: an interactive job takes writes and close-input from the other binary`, async () => {
      const { a, b } = pair(first, second);
      const id = await a.start(['--input', 'pipe', '/bin/sh', '-c', 'while IFS= read -r l; do echo "got $l"; done; echo bye']);
      expect(await b.json(['write', id, '--', 'one\n'])).toEqual({ id, written: 4, closed: false });
      expect(await a.json(['write', id, '--stdin'], { input: 'two\n' })).toEqual({ id, written: 4, closed: false });
      expect(await until(async () => (await a.json(['read', id, 'stdout'])).text === 'got one\ngot two\n', 5000)).toBe(true);
      expect(await b.json(['read', id, 'stdout'])).toEqual(await a.json(['read', id, 'stdout']));
      expect(await b.json(['close-input', id])).toEqual({ id, written: 0, closed: true });
      expect(await a.json(['close-input', id])).toEqual({ id, written: 0, closed: true });
      expect(await a.wait(id)).toEqual(jobReceipt(id, { state: 'exited', exitCode: 0, stdout: 'got one\ngot two\nbye\n' }));
      expect(await b.run(['write', id, '--', 'x'])).toMatchObject({ code: 1, err: 'job has finished\n' });
    });

    test(`${name}: a store root made by one is accepted, not rewritten, by the other`, async () => {
      const { a, b } = pair(first, second);
      await a.ok(['list']);
      const marker = readFileSync(join(a.home, '.jev-fabric-store.json'), 'utf8');
      const id = await b.start(['/bin/echo', 'second']);
      await b.wait(id);
      expect(readFileSync(join(a.home, '.jev-fabric-store.json'), 'utf8')).toBe(marker);
      expect(await a.ok(['list'])).toBe(await b.ok(['list']));
      // A pre-marker home is adopted the same way by either binary.
      const old = fx.store({}, first);
      const other = fx.store({}, second, old.home);
      mkdirSync(old.home, { mode: 0o700 });
      await other.start(['/bin/echo']);
      expect(readFileSync(join(old.home, '.jev-fabric-store.json'), 'utf8')).toBe('{"store":1}\n');
      expect((await old.json(['list'])).jobs.length).toBe(1);
      // Both refuse a newer format the same way.
      writeFileSync(join(old.home, '.jev-fabric-store.json'), '{"store":2}\n', { mode: 0o600 });
      const [x, y] = [await old.run(['list']), await other.run(['list'])];
      expect([y.code, y.err]).toEqual([x.code, x.err]);
    });

    test(`${name}: the default root and its .gitignore made by one are used by the other`, async () => {
      const cwd = join(fx.root, `default-${Math.random().toString(16).slice(2)}`);
      mkdirSync(cwd);
      const env = { PATH: `${fx.guard}:/usr/bin:/bin` };
      const start = Bun.spawnSync([first, '--', 'start', '/bin/echo', 'x'], { cwd, env });
      const { id } = JSON.parse(start.stdout.toString());
      Bun.spawnSync([first, '--', 'wait', id], { cwd, env });
      const listed = Bun.spawnSync([second, '--', 'list'], { cwd, env });
      expect(JSON.parse(listed.stdout.toString()).jobs.map((j: any) => j.id)).toEqual([id]);
      expect(readFileSync(join(cwd, '.jev-fabric-native', '.gitignore'), 'utf8')).toBe('*\n');
    });

    test(`${name}: a job started over one binary's serve is controlled by the other's CLI and serve`, async () => {
      const { a, b } = pair(first, second);
      const c = new Serve([], a.env, { bin: first });
      fx.track(c.child);
      await c.open();
      const job = (await c.ok({ op: 'start', argv: ['/bin/cat'], input: 'pipe', label: 'served' })).id;
      a.started.add(job);
      expect(await b.json(['write', job, '--', 'hello\n'])).toEqual({ id: job, written: 6, closed: false });
      const d = new Serve([], b.env, { bin: second });
      fx.track(d.child);
      await d.open();
      expect((await d.ok({ op: 'read', job, stream: 'stdout', waitMs: 5000 })).text).toBe('hello\n');
      expect(await d.ok({ op: 'closeInput', job })).toEqual({ id: job, written: 0, closed: true });
      const receipt = await d.ok({ op: 'wait', job, timeoutMs: 5000 });
      expect(receipt).toEqual(jobReceipt(job, { label: 'served', state: 'exited', exitCode: 0, stdout: 'hello\n' }));
      expect(await c.ok({ op: 'status', job })).toEqual(receipt);
      await Promise.all([c.close(), d.close()]);
    });

    test(`${name}: a dead worker is recovered as failed by the other binary`, async () => {
      const { a, b } = pair(first, second);
      const id = await a.start(['/bin/sh', '-c', 'echo $PPID $$; exec sleep 60']);
      expect(await until(async () => /^\d+ \d+\n$/.test((await a.json(['read', id, 'stdout'])).text), 5000)).toBe(true);
      const [worker, child] = (await a.json(['read', id, 'stdout'])).text.trim().split(' ').map(Number) as [number, number];
      process.kill(worker, 'SIGKILL');
      expect(await until(() => gone(worker), 2000)).toBe(true);
      const recovered = await b.ok(['status', id]);
      expect(JSON.parse(recovered)).toMatchObject({ id, state: 'failed', exitCode: null, error: 'worker exited without a terminal receipt' });
      expect(await a.ok(['status', id])).toBe(recovered);
      if (!gone(child)) process.kill(child, 'SIGKILL');
    });
  }
});
