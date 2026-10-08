import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Can compile in isolation or use the suite's supervised, prebuilt fixture.
const root = mkdtempSync(join(tmpdir(), 'jev-decision-transport-'));
const bin = process.env.JEV_NATIVE_PREBUILT === '1' ? resolve('build/test-decision-http-probe') : join(root, 'probe');
const marker = 'SYNTHETIC_PRIVATE_DECISION_KEY';
const received: Array<{ path: string; headers: Headers; body: string }> = [];
let onRequest: (() => void) | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    received.push({ path, headers: request.headers, body: await request.text() });
    onRequest?.();
    onRequest = undefined;
    if (path === '/redirect') return Response.redirect(`${server.url}target`, 302);
    if (path === '/status') return new Response('PRIVATE_PROVIDER_ERROR_BODY', { status: 401 });
    if (path === '/slow') {
      await Bun.sleep(1000);
      return new Response('late');
    }
    if (path === '/big') return new Response(new Uint8Array(2 * 1024 * 1024));
    if (path === '/max') return new Response(new Uint8Array(16 * 1024 * 1024));
    if (path === '/overflow') return new Response(new Uint8Array(16 * 1024 * 1024 + 1));
    if (path === '/chunked-overflow') {
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(1024 * 1024));
          controller.close();
        },
      });
      return new Response(stream);
    }
    return new Response(new Uint8Array([0, 255]));
  },
});

beforeAll(() => {
  if (process.env.JEV_NATIVE_PREBUILT === '1') return;
  const build = Bun.spawnSync(['bend', resolve('native/tests/decision-http-probe.bend'), '-o', bin], {
    env: { ...process.env, BEND_NO_TELEMETRY: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 120000,
  });
  expect(build.exitCode, build.stdout.toString() + build.stderr.toString()).toBe(0);
}, 125000);
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

async function run(path = 'ok', auth = 'bearer', key = marker, mode = 'small', env: Record<string, string> = {}) {
  const child = Bun.spawn([bin, `${server.url}${path}`, auth, mode], {
    env: { ...process.env, DECISION_PROBE_KEY: key, ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  expect(out + err).not.toContain(marker);
  expect(out + err).not.toContain('private-body');
  expect(out + err).not.toContain('PRIVATE_PROVIDER_ERROR_BODY');
  return out.trim();
}

test('byte-exact response and bearer request body', async () => {
  expect(await run()).toBe('ok:2');
  const last = received.at(-1)!;
  expect(last.headers.get('authorization')).toBe(`Bearer ${marker}`);
  expect(last.headers.get('content-type')).toBe('application/json');
  expect(JSON.parse(last.body)).toEqual({ payload: 'private-body-🙂' });
});

test('anthropic and google headers, no bearer header', async () => {
  expect(await run('ok', 'anthropic')).toBe('ok:2');
  expect(received.at(-1)!.headers.get('x-api-key')).toBe(marker);
  expect(received.at(-1)!.headers.get('anthropic-version')).toBe('2023-06-01');
  expect(received.at(-1)!.headers.get('authorization')).toBeNull();
  expect(await run('ok', 'google')).toBe('ok:2');
  expect(received.at(-1)!.headers.get('x-goog-api-key')).toBe(marker);
  expect(received.at(-1)!.headers.get('authorization')).toBeNull();
});

test('anonymous bearer and none only local; header injection rejected before network', async () => {
  expect(await run('ok', 'bearer', '')).toBe('ok:2');
  expect(received.at(-1)!.headers.get('authorization')).toBeNull();
  expect(await run('ok', 'none', '')).toBe('ok:2');
  const before = received.length;
  expect(await run('ok', 'bearer', `${marker}\r\nInjected: yes`)).toContain('Invalid decision authentication');
  expect(await run('ok', 'anthropic', '')).toContain('Invalid decision authentication');
  expect(received.length).toBe(before);
});

test('status preserved without provider body, no redirect or retry', async () => {
  let before = received.length;
  expect(await run('status')).toBe('error:401:Decision HTTP 401; no automatic retry');
  expect(received.length - before).toBe(1);
  before = received.length;
  expect(await run('redirect')).toBe('error:302:Decision HTTP 302; no automatic retry');
  expect(received.length - before).toBe(1);
  expect(received.some(r => r.path === '/target')).toBe(false);
});

test('exchange preserves non2xx status and bounded raw body without following redirects', async () => {
  expect(await run('ok', 'bearer', marker, 'exchange')).toBe('exchange:200:2');
  const before = received.length;
  expect(await run('status', 'bearer', marker, 'exchange')).toBe(`exchange:401:${'PRIVATE_PROVIDER_ERROR_BODY'.length}`);
  expect(received.length - before).toBe(1);
  expect(await run('redirect', 'bearer', marker, 'exchange')).toBe('exchange:302:0');
  expect(received.some(r => r.path === '/target')).toBe(false);
});

test('ignores curlrc and environment proxies', async () => {
  writeFileSync(join(root, '.curlrc'), 'proxy = "http://127.0.0.1:1"\nlocation\nretry = 3\n');
  expect(await run('ok', 'bearer', marker, 'small', {
    HOME: root, CURL_HOME: root, XDG_CONFIG_HOME: root,
    http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
  })).toBe('ok:2');
});

test('private config holds secrets and body, fixed argv never does', async () => {
  const fake = join(root, 'curl');
  const argvPath = join(root, 'argv');
  const configPath = join(root, 'config');
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROBE_ARGV"\ncat > "$PROBE_CONFIG"\nprintf "\\000\\377\\n200"\n');
  chmodSync(fake, 0o700);
  expect(await run('ok', 'bearer', marker, 'small', { PATH: `${root}:${process.env.PATH}`, PROBE_ARGV: argvPath, PROBE_CONFIG: configPath })).toBe('ok:2');
  const argv = readFileSync(argvPath, 'utf8');
  const config = readFileSync(configPath, 'utf8');
  expect(argv.split('\n')[0]).toBe('--disable');
  expect(argv).not.toContain(marker);
  expect(argv).not.toContain('private-body');
  expect(argv).not.toContain(server.url.toString());
  expect(argv).not.toContain('--location');
  expect(argv).not.toContain('--retry');
  expect(config).toContain(marker);
  expect(config).toContain('private-body-🙂');
  for (const line of config.split('\n').filter(line => line.startsWith('json = '))) {
    expect(JSON.parse(line.slice(7)).startsWith('@')).toBe(false);
  }
});

test('chunk-leading @file, @- and long @ runs remain JSON data', async () => {
  expect(await run('ok', 'bearer', marker, 'at-boundary')).toBe('ok:2');
  const body = received.at(-1)!.body;
  expect(JSON.parse(body).payload).toBe('a'.repeat(16372) + '@/does-not-exist' + '@'.repeat(40000));
  expect(body).toContain('1.234567890123456789e-99');
  expect(body).toContain('\\u0040/does-not-exist');
  expect(await run('ok', 'bearer', marker, 'at-stdin-boundary')).toBe('ok:2');
  expect(JSON.parse(received.at(-1)!.body).payload).toBe('a'.repeat(16372) + '@-');
});

test('request and response above legacy 1 MiB succeed', async () => {
  expect(await run('ok', 'bearer', marker, 'large')).toBe('ok:2');
  expect(JSON.parse(received.at(-1)!.body).payload.length).toBe(1200000);
  expect(await run('big')).toBe('ok:2097152');
}, 30000);

test('16 MiB response succeeds; known and unknown-length overflow fail closed', async () => {
  expect(await run('max')).toBe('ok:16777216');
  expect(await run('overflow')).toContain('Decision transport failed');
  expect(await run('chunked-overflow')).toContain('Decision transport failed');
}, 60000);

test('16 MiB request succeeds and one extra byte is rejected before dispatch', async () => {
  expect(await run('ok', 'bearer', marker, 'max-request')).toBe('ok:2');
  expect(new TextEncoder().encode(received.at(-1)!.body).length).toBe(16777216);
  const before = received.length;
  expect(await run('ok', 'bearer', marker, 'overflow-request')).toContain('JSON byte limit');
  expect(received.length).toBe(before);
}, 60000);

test('Process.capture cancellation interrupts a running request', async () => {
  const seen = new Promise<void>(resolve => { onRequest = resolve; });
  const child = Bun.spawn([bin, `${server.url}slow`, 'bearer', 'small'], {
    env: { ...process.env, DECISION_PROBE_KEY: marker }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  await Promise.race([seen, Bun.sleep(2000).then(() => { throw new Error('request did not start'); })]);
  child.kill('SIGTERM');
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  expect(out).toContain('Decision transport failed');
  expect(out + err).not.toContain(marker);
}, 10000);

test('Process.capture deadline interrupts exactly one attempt', async () => {
  const before = received.length;
  const start = performance.now();
  expect(await run('slow', 'bearer', marker, 'deadline')).toContain('Decision transport failed');
  expect(performance.now() - start).toBeLessThan(2500);
  expect(received.length - before).toBe(1);
}, 10000);
