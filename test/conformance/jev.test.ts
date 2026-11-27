// Jev and decisions without the network: offline validation, validation before
// credentials, missing-credential and budget errors; legacy `jev` through its
// documented `JEV_FABRIC_HTTP=exec` transport with a fake curl on PATH; and
// `decide` against a local plain-HTTP fake server on 127.0.0.1 (allowLocal).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fixture, expectOut, readIf, run, script, serve } from './harness.ts';

const fx = new Fixture('jev');
const KEY = 'SYNTHETIC_KEY_FOR_CONFORMANCE';
const REQUEST_KEY = 'SYNTHETIC_REQUEST_KEY_FOR_CONFORMANCE';
const noul = { state: 'synthetic', questions: { ok: { type: 'noul', instructions: 'Is two plus two four?' } } };
const reply = { model: 'jev-test', answers: { ok: { type: 'noul', noul: 0.99, debug: KEY } }, usage: { input_tokens: 4, output_tokens: 2 }, debug: KEY };
const normalized = { model: 'jev-test', answers: { ok: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 4, output_tokens: 2 } };

const fakeBin = join(fx.root, 'fake-bin');
const requestFile = join(fx.root, 'request.json');
const credential = join(fx.root, 'credential.sh');
let serial = 0;

// The local decision endpoint: plain HTTP on exact 127.0.0.1, never anything else.
interface Seen { method: string; path: string; headers: Record<string, string>; body: string }
const seen: Seen[] = [];
const decision = (model = 'local-model', usage: unknown = { input_tokens: 3, output_tokens: 1 }) =>
  JSON.stringify({ model, answers: { q: { type: 'noul', noul: 0.75 } }, ...(usage === null ? {} : { usage }) });
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    seen.push({ method: request.method, path, headers, body: await request.text() });
    if (path.startsWith('/status/')) return new Response('{"error":{"type":"rate_limit","opaque":9007199254740993}}', { status: Number(path.slice(8)) });
    if (path.startsWith('/redirect')) return Response.redirect(`http://127.0.0.1:${server.port}/target`, 302);
    if (path.startsWith('/nousage')) return new Response(decision('local-model', null));
    if (path.startsWith('/slow')) {
      await Bun.sleep(3000);
      return new Response(decision());
    }
    if (path.startsWith('/bad')) return new Response(JSON.stringify({ model: 'm', answers: { wrong: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 3, output_tokens: 1 } }));
    return new Response(decision());
  },
});
const local = (path: string, extra: Record<string, unknown> = {}) => ({
  provider: 'custom', api: 'system-one', endpoint: `http://127.0.0.1:${server.port}${path}`, model: 'm', allowLocal: true,
  state: 's', questions: { q: { type: 'boolean', instructions: 'x' } }, ...extra,
});
const hits = (prefix: string) => seen.filter(r => r.path.startsWith(prefix));
const decided = (budget: { exhausted: boolean; reason: string }, extra: Record<string, unknown> = {}) => ({
  httpStatus: 200, budget, status: 'ok', provider: 'custom', api: 'system-one', model: 'local-model',
  answers: { q: { type: 'boolean', probability: 0.75 } }, usage: { input_tokens: 3, output_tokens: 1 }, provenance: { kind: 'native' },
  raw: JSON.parse(decision()), rawJson: decision(), ...extra,
});

beforeAll(async () => {
  mkdirSync(fakeBin, { recursive: true });
  await Bun.write(requestFile, JSON.stringify(noul));
  // Fake curl for the legacy exec transport: records argv and the private stdin config, then answers.
  await Bun.write(join(fx.root, 'curl.ts'), `
import { appendFileSync } from 'node:fs';
const config = await Bun.stdin.text();
const value = (prefix: string) => { const line = config.split('\\n').find(l => l.startsWith(prefix)); return line === undefined ? undefined : JSON.parse(line.slice(prefix.length)); };
appendFileSync(process.env.CURL_RECORD!, JSON.stringify({
  args: process.argv.slice(2), url: value('url = '), body: value('data-binary = '), maxTime: value('max-time = '),
  headers: config.split('\\n').filter(l => l.startsWith('header = ')).map(l => JSON.parse(l.slice(9))),
}) + '\\n');
if (process.env.CURL_DELAY) await Bun.sleep(Number(process.env.CURL_DELAY));
if (process.env.INVALID_UTF8) process.stdout.write(new Uint8Array([255]));
else process.stdout.write(process.env.FAKE_RESPONSE ?? '');
process.stdout.write('\\n' + (process.env.FAKE_STATUS ?? '200'));
`);
  script(join(fakeBin, 'curl'), `exec '${process.execPath}' '${join(fx.root, 'curl.ts')}' "$@"`);
  script(credential, 'printf x >> "$CREDENTIAL_RECORD"', `printf '%s\\n' '${KEY}'`);
});
afterAll(async () => {
  server.stop(true);
  await fx.cleanup();
});

/** An environment with records for the fake curl and the credential command. */
function jevEnv(extra: Record<string, string> = {}) {
  const n = serial++;
  const curl = join(fx.root, `curl-${n}`);
  const cred = join(fx.root, `cred-${n}`);
  const env = {
    PATH: `${fakeBin}:/usr/bin:/bin`, JEV_FABRIC_HTTP: 'exec', JEV_FABRIC_HOME: join(fx.root, `home-${n}`),
    CURL_RECORD: curl, CREDENTIAL_RECORD: cred, FAKE_RESPONSE: JSON.stringify(reply), ...extra,
  };
  return {
    env,
    curls: () => (existsSync(curl) ? readFileSync(curl, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []),
    credentials: () => readIf(cred),
  };
}
const withCommand = { JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', credential]) };
const writeRequest = (name: string, value: unknown) => {
  const path = join(fx.root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

describe.concurrent('validate', () => {
  test('prints the validated request and needs no runtime, credentials or network', async () => {
    const example = readFileSync(join(import.meta.dir, '../../examples/native/request.json'), 'utf8');
    const path = writeRequest('example.json', example);
    const r = await run(['validate', path], { env: { PATH: '/nonexistent' } });
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [JSON.parse(example)], 'std');
    const escaped = writeRequest('escaped.json', { state: 'a\n\t\u0001"', questions: { q: { type: 'noul', instructions: 'x' } } });
    expect((await run(['validate', escaped])).out).toBe('{"state":"a\\n\\t\\u0001\\"","questions":{"q":{"type":"noul","instructions":"x"}}}\n');
  });

  test('rejects malformed files and requests', async () => {
    const cases: [string, string | Uint8Array, number, string][] = [
      ['duplicate', '{"state":"x","state":"y","questions":{}}', 22, 'duplicate JSON key'],
      ['utf8', new Uint8Array([0xff, 0xfe]), 22, 'invalid UTF-8 lead'],
      ['empty-questions', '{"state":"x","questions":{}}', 22, 'invalid question count'],
      ['extra', JSON.stringify({ ...noul, extra: 1 }), 22, 'unknown request field'],
      ['missing', '{}', 22, 'missing wire field'],
      ['choices', JSON.stringify({ state: 'x', questions: { q: { type: 'choice', instructions: 'x', choices: ['a'] } } }), 22, 'unknown question field'],
      ['scalar-state', JSON.stringify({ state: 5, questions: noul.questions }), 22, 'invalid Jev state'],
    ];
    const actual = [];
    for (const [name, content] of cases) {
      const path = join(fx.root, `${name}.json`);
      writeFileSync(path, content);
      const r = await run(['validate', path]);
      actual.push([name, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([name, , code, message]) => [name, code, '', message]));
    expect(await run(['validate', join(fx.root, 'absent.json')])).toMatchObject({ code: 1, out: '', err: 'Unable to read bounded UTF-8 input file\n' });
    expect(await run(['validate'])).toMatchObject({ code: 2, out: '' });
  });
});

describe.concurrent('jev (legacy) without dispatch', () => {
  test('validates the request before resolving any credential', async () => {
    const j = jevEnv(withCommand);
    const bad = writeRequest('bad-jev.json', { state: 'x', questions: {} });
    const r = await run(['jev', bad], { env: j.env });
    expect([r.code, r.out, r.err]).toEqual([1, '', 'Invalid Jev request\n']);
    expect(j.credentials()).toBe('');
    expect(j.curls()).toEqual([]);
  });

  test('fails closed on missing or malformed credentials, providers, transports and limits', async () => {
    const cases: [string[], Record<string, string>, number, string][] = [
      [['jev', requestFile], {}, 1, 'Missing provider key or JEV_CREDENTIAL_COMMAND'],
      [['jev', requestFile], { TYPESAFE_API_KEY: 'a\nb' }, 1, 'Invalid private credential'],
      [['jev', requestFile], { JEV_CREDENTIAL_COMMAND: 'not-json' }, 1, 'Credential command must be a JSON argv array'],
      [['jev', requestFile], { JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', '-c', `printf '${KEY}'; echo ${KEY} >&2; exit 3`]) }, 1, 'Private credential command failed'],
      [['jev', requestFile], { JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', '-c', 'head -c 20000 /dev/zero']) }, 1, 'Private credential command failed'],
      [['jev', requestFile], { JEV_PROVIDER: 'elsewhere', TYPESAFE_API_KEY: KEY }, 1, 'JEV_PROVIDER must be typesafe, openrouter, vercel, or subq'],
      [['jev', requestFile], { TYPESAFE_API_KEY: KEY, JEV_FABRIC_HTTP: 'bogus' }, 1, 'JEV_FABRIC_HTTP must be auto, pooled or exec'],
      // A key for another provider is not used.
      [['jev', requestFile], { OPENROUTER_API_KEY: KEY }, 1, 'Missing provider key or JEV_CREDENTIAL_COMMAND'],
      [['jev', requestFile, '0'], { TYPESAFE_API_KEY: KEY, ...withCommand }, 1, 'Jev budget exhausted'],
      [['jev', requestFile, 'x'], { TYPESAFE_API_KEY: KEY }, 2, 'Jev timeout and token limit must be integers'],
      [['jev', '--timeout-ms', '0', requestFile], { TYPESAFE_API_KEY: KEY }, 2, 'timeout must be an integer within the operation limit'],
      [['jev', '--timeout-ms', '3600001', requestFile], { TYPESAFE_API_KEY: KEY }, 2, 'timeout must be an integer within the operation limit'],
      [['jev', requestFile], { TYPESAFE_API_KEY: KEY, JEV_FABRIC_JEV_TIMEOUT_MS: 'bad' }, 2, 'timeout must be an integer within the operation limit'],
      [['jev'], {}, 2, 'command or file is required'],
    ];
    const actual = [];
    for (const [args, extra] of cases) {
      const j = jevEnv(extra);
      const r = await run(args, { env: j.env });
      expect(r.out + r.err).not.toContain(KEY);
      actual.push([args, extra, r.code, r.out, r.err.trim(), j.curls().length]);
    }
    expect(actual).toEqual(cases.map(([args, extra, code, message]) => [args, extra, code, '', message, 0]));
  });

  test('a credential command is bounded by the request deadline and never dispatches on failure', async () => {
    const j = jevEnv({ JEV_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', '-c', 'sleep 3; printf never']) });
    const r = await run(['jev', '--timeout-ms', '300', requestFile], { env: j.env });
    expect([r.code, r.err]).toEqual([1, 'Private credential command failed\n']);
    expect(r.ms).toBeLessThan(2000);
    expect(j.curls()).toEqual([]);
  });
});

describe.concurrent('jev through the exec transport (fake curl on PATH)', () => {
  test('one evaluation: normalized answer, key only in the private stdin config, HTTPS-only argv', async () => {
    const j = jevEnv({ TYPESAFE_API_KEY: KEY });
    const r = await run(['jev', requestFile], { env: j.env });
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [normalized], 'std');
    const [call] = j.curls();
    expect(call.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(call.headers).toEqual(['Content-Type: application/json', `Authorization: Bearer ${KEY}`]);
    expect(JSON.parse(call.body)).toEqual({ model: 'jev-latest', ...noul });
    expect(call.maxTime).toBe(30);
    expect(call.args[0]).toBe('--disable');
    expect(call.args.join(' ')).toContain('--proto =https');
    expect(call.args.join(' ')).not.toContain(KEY);
  });

  test('providers route to fixed HTTPS endpoints with their own key and default model; JEV_MODEL overrides', async () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ JEV_PROVIDER: 'subq', SUBQ_API_KEY: KEY }, 'https://api.subq.ai/v1/systemone', 'subq-snap-preview'],
      [{ JEV_PROVIDER: 'openrouter', OPENROUTER_API_KEY: KEY }, 'https://openrouter.ai/api/alpha/decisions', '~typesafe/jev-latest'],
      [{ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: KEY }, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev'],
      [{ TYPESAFE_API_KEY: KEY, JEV_MODEL: 'jev-test-model' }, 'https://api.typesafe.ai/v1/systemone', 'jev-test-model'],
    ];
    const actual = [];
    for (const [extra] of cases) {
      const j = jevEnv(extra);
      const r = await run(['jev', requestFile], { env: j.env });
      const [call] = j.curls();
      actual.push([r.code, call?.url, JSON.parse(call?.body ?? '{}').model, call?.headers.includes(`Authorization: Bearer ${KEY}`)]);
    }
    expect(actual).toEqual(cases.map(([, url, model]) => [0, url, model, true]));
  });

  test('failures after dispatch: HTTP status, invalid answers, invalid UTF-8, token overshoot, deadline', async () => {
    const cases: [Record<string, string>, string[], string][] = [
      [{ FAKE_STATUS: '401' }, [], 'Jev HTTP 401; no automatic retry'],
      [{ FAKE_RESPONSE: JSON.stringify({ secret: KEY }) }, [], 'Invalid typed Jev response'],
      [{ FAKE_RESPONSE: JSON.stringify({ model: 'm', answers: reply.answers }) }, [], 'Invalid typed Jev response'],
      [{ INVALID_UTF8: '1' }, [], 'Invalid UTF-8 Jev response'],
      [{}, ['5'], 'Jev reported-token budget exceeded; final request may still be billed'],
      [{ JEV_FABRIC_JEV_TIMEOUT_MS: '200', CURL_DELAY: '1500' }, [], 'Jev transport failed, was interrupted, or exceeded its output bound'],
    ];
    const actual = [];
    for (const [extra, tail] of cases) {
      const j = jevEnv({ TYPESAFE_API_KEY: KEY, ...extra });
      const r = await run(['jev', requestFile, ...tail], { env: j.env });
      expect(r.out + r.err).not.toContain(KEY);
      actual.push([extra, r.code, r.out, r.err.trim(), j.curls().length]);
    }
    expect(actual).toEqual(cases.map(([extra, , message]) => [extra, 1, '', message, 1]));
  });

  test('the request deadline reaches the transport: JEV_FABRIC_JEV_TIMEOUT_MS and --timeout-ms', async () => {
    const actual = [];
    for (const [args, extra] of [
      [['jev', requestFile], { JEV_FABRIC_JEV_TIMEOUT_MS: '2000' }],
      [['jev', '--timeout-ms', '300', requestFile], { JEV_FABRIC_JEV_TIMEOUT_MS: 'invalid' }],
      [['jev', '4000', requestFile], {}],
    ] as [string[], Record<string, string>][]) {
      const j = jevEnv({ TYPESAFE_API_KEY: KEY, ...extra });
      const r = await run(args, { env: j.env });
      actual.push([r.code, j.curls()[0]?.maxTime]);
    }
    // curl's max-time is whole seconds, rounded up; the native supervisor enforces the exact deadline.
    expect(actual).toEqual([[0, 2], [0, 1], [0, 4]]);
  });
});

describe.concurrent('jev in serve: one client, one budget', () => {
  test('the credential resolves once and stays cached; the call budget is session-wide', async () => {
    const j = jevEnv(withCommand);
    const s = fx.store();
    const c = await serve(fx, s, ['2', '1000'], j.env);
    expect(await c.send({ id: 1, op: 'jev', request: noul })).toEqual({ id: 1, ok: true, result: normalized });
    expect(await c.send({ id: 2, op: 'jev', request: noul, timeoutMs: 5000 })).toEqual({ id: 2, ok: true, result: normalized });
    expect(await c.send({ id: 3, op: 'jev', request: noul })).toEqual({ id: 3, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
    const { code, err } = await c.close();
    expect([code, err]).toEqual([0, '']);
    expect(j.curls().length).toBe(2);
    expect(j.credentials()).toBe('x');
  });

  test('invalid requests and credential failures spend nothing; failed HTTP spends a call; zero budgets resolve nothing', async () => {
    const j = jevEnv(withCommand);
    const s = fx.store();
    const c = await serve(fx, s, ['1', '1000'], j.env);
    expect(await c.send({ id: 1, op: 'jev', request: { state: 'x', questions: {} } }))
      .toEqual({ id: 1, ok: false, error: { code: 22, message: 'invalid question count' } });
    expect(await c.send({ id: 2, op: 'jev', request: noul, credential: 'a\nb' }))
      .toEqual({ id: 2, ok: false, error: { code: 1, message: 'Invalid private credential' } });
    expect(j.credentials()).toBe('');
    expect((await c.send({ id: 3, op: 'jev', request: noul })).ok).toBe(true);
    expect(await c.send({ id: 4, op: 'jev', request: noul })).toEqual({ id: 4, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
    await c.close();
    expect(j.curls().length).toBe(1);

    const failing = jevEnv({ ...withCommand, FAKE_STATUS: '500' });
    const d = await serve(fx, s, ['1'], failing.env);
    expect(await d.send({ id: 1, op: 'jev', request: noul })).toEqual({ id: 1, ok: false, error: { code: 1, message: 'Jev HTTP 500; no automatic retry' } });
    expect(await d.send({ id: 2, op: 'jev', request: noul })).toEqual({ id: 2, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
    await d.close();
    expect(failing.curls().length).toBe(1);

    for (const args of [['0'], ['1', '0']]) {
      const none = jevEnv(withCommand);
      const e = await serve(fx, s, args, none.env);
      expect(await e.send({ id: 1, op: 'jev', request: noul })).toEqual({ id: 1, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
      await e.close();
      expect([none.credentials(), none.curls().length]).toEqual(['', 0]);
    }
  });

  test('a per-request provider and credential apply once: never cached, echoed or logged', async () => {
    const j = jevEnv(withCommand);
    const s = fx.store();
    const c = await serve(fx, s, ['4', '1000'], j.env);
    expect(await c.send({ id: 1, op: 'jev', request: noul, credential: REQUEST_KEY })).toEqual({ id: 1, ok: true, result: normalized });
    expect(j.credentials()).toBe('');
    expect((await c.send({ id: 2, op: 'jev', request: noul, provider: 'openrouter', credential: REQUEST_KEY })).ok).toBe(true);
    expect((await c.send({ id: 3, op: 'jev', request: noul })).ok).toBe(true);
    expect(j.credentials()).toBe('x');
    const cases: [Record<string, unknown>, number, string][] = [
      [{ provider: 'elsewhere' }, 2, 'provider must be typesafe, openrouter, vercel or subq'],
      [{ credential: '' }, 2, 'credential must be a non-empty string'],
      [{ credential: 7 }, 2, 'credential must be a non-empty string'],
      [{ credential: `${REQUEST_KEY}\nsecond line` }, 1, 'Invalid private credential'],
    ];
    for (const [fields, code, message] of cases) {
      const response = await c.send({ id: 'e', op: 'jev', request: noul, ...fields });
      expect(response).toEqual({ id: 'e', ok: false, error: { code, message } });
      c.arrived.length = 0;
    }
    expect((await c.send({ id: 4, op: 'jev', request: noul, credential: REQUEST_KEY })).ok).toBe(true);
    expect(await c.send({ id: 5, op: 'jev', request: noul, credential: REQUEST_KEY })).toEqual({ id: 5, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
    const { code, err } = await c.close();
    expect([code, err]).toEqual([0, '']);
    for (const raw of c.rawById.values()) expect(raw).not.toContain(REQUEST_KEY);
    const calls = j.curls().map(call => [call.url, call.headers.find((h: string) => h.startsWith('Authorization'))]);
    expect(calls).toEqual([
      ['https://api.typesafe.ai/v1/systemone', `Authorization: Bearer ${REQUEST_KEY}`],
      ['https://openrouter.ai/api/alpha/decisions', `Authorization: Bearer ${REQUEST_KEY}`],
      ['https://api.typesafe.ai/v1/systemone', `Authorization: Bearer ${KEY}`],
      ['https://api.typesafe.ai/v1/systemone', `Authorization: Bearer ${REQUEST_KEY}`],
    ]);
  });
});

const ENDPOINT = 'Invalid decision endpoint; HTTP requires exact loopback and allowLocal:true';
const PRESETS = [
  ['typesafe', 'system-one', 'jev-latest', 'https://api.typesafe.ai/v1/systemone', 'TYPESAFE_API_KEY', 'supported', false],
  ['subq', 'system-one', 'subq-snap-preview', 'https://api.subq.ai/v1/systemone', 'SUBQ_API_KEY', 'supported', false],
  ['openrouter', 'system-one', '~typesafe/jev-latest', 'https://openrouter.ai/api/v1/systemone', 'OPENROUTER_API_KEY', 'unsupported', false],
  ['vercel', 'system-one', 'typesafe-ai/jev', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'AI_GATEWAY_API_KEY', 'unsupported', false],
  ['vercel-evaluate', 'vercel-evaluate', 'typesafe-ai/jev', 'https://ai-gateway.vercel.sh/v1/evaluate', 'AI_GATEWAY_API_KEY', 'unsupported', false],
  ['vercel-decisions', 'openai-decisions', 'openai/gpt-6-luna-decisions', 'https://ai-gateway.vercel.sh/v1/decisions', 'AI_GATEWAY_API_KEY', 'unsupported', false],
  ['openai', 'openai-decisions', 'gpt-6-luna', 'https://api.openai.com/v1/decisions', 'OPENAI_API_KEY', 'supported', false],
  ['cloudflare-workers-ai', 'cloudflare', 'typesafe/jev', 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run', 'CLOUDFLARE_API_TOKEN', 'model-dependent', false],
  ['opencode', 'system-one', 'jev-1.13', 'https://opencode.ai/zen/v1/systemone', 'OPENCODE_API_KEY', 'unsupported', false],
  ['llama.cpp', 'llama-cpp', 'local', 'http://127.0.0.1:8080', 'LLAMA_API_KEY', 'unsupported', false],
  ['llama-system-one', 'llama-system-one', 'local', 'http://127.0.0.1:8080/v1/systemone', 'LLAMA_API_KEY', 'model-dependent', false],
  ['anthropic', 'anthropic', 'claude-haiku-4-5-20251001', 'https://api.anthropic.com/v1/messages', 'ANTHROPIC_API_KEY', 'supported', true],
  ['google', 'google', 'gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'GEMINI_API_KEY', 'supported', true],
  ['custom', '', '', '', 'DECISION_API_KEY', 'model-dependent', false],
].map(([provider, api, defaultModel, endpoint, credentialEnv, imageSupport, generated]) =>
  ({ provider, api, defaultModel, endpoint, credentialEnv, imageSupport, generated }));

describe.concurrent('decisions offline', () => {
  test('decision-providers lists the 14 registered presets; serve answers the same', async () => {
    const r = await run(['decision-providers'], { env: { PATH: '/nonexistent' } });
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [PRESETS], 'std');
    const s = fx.store();
    const c = await serve(fx, s);
    expect(await c.ok({ op: 'decisionProviders' })).toEqual(PRESETS);
    await c.close();
  });

  test('validate-decision checks the request schema only; serve validateDecision agrees', async () => {
    const good = { provider: 'typesafe', state: { tests: 'passed' }, questions: {
      healthy: { type: 'boolean', instructions: 'Is it healthy?' },
      next: { type: 'choice', instructions: { task: 'Choose' }, criteria: { verify: 'Check', repair: null } },
      risk: { type: 'score', instructions: 'Assess', criteria: ['Low', 'High'] },
    } };
    const path = writeRequest('decision.json', good);
    const r = await run(['validate-decision', path]);
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [good], 'std');
    const cases: [unknown, string][] = [
      [{ state: 'x', questions: {} }, 'invalid question count'],
      [{ ...good, extra: 1 }, 'unknown decision request field'],
      [{ state: 'x', questions: { q: { type: 'score', instructions: 'x', criteria: ['one'] } } }, 'invalid Score criteria'],
      [{ state: 'x', questions: { q: { type: 'boolean', instructions: 'x', extra: 1 } } }, 'unknown question field'],
    ];
    const actual = [];
    const s = fx.store();
    const c = await serve(fx, s);
    for (const [request] of cases) {
      const r2 = await run(['validate-decision', writeRequest(`vd-${actual.length}.json`, request)]);
      const served = await c.send({ id: 'v', op: 'validateDecision', request });
      c.arrived.length = 0;
      actual.push([r2.code, r2.out, r2.err.trim(), served.error]);
    }
    expect(actual).toEqual(cases.map(([, message]) => [22, '', message, { code: 22, message }]));
    expect(await c.ok({ op: 'validateDecision', request: good })).toEqual(good);
    await c.close();
  });

  test('resolve-decision resolves targets, flags and profiles without credentials or dispatch', async () => {
    const j = jevEnv({ DECISION_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', credential]), ...withCommand });
    const path = writeRequest('resolve.json', { ...noul, provider: 'typesafe', model: 'file-model' });
    const resolve = async (args: string[], extra: Record<string, string> = {}) => run(['resolve-decision', ...args], { env: { ...j.env, ...extra } });
    const typesafe = await resolve([path]);
    expectOut(typesafe.out, [{
      target: { provider: 'typesafe', api: 'system-one', model: 'file-model', endpoint: 'https://api.typesafe.ai/v1/systemone', allowLocal: false, allowGenerated: false },
      credential: { env: 'TYPESAFE_API_KEY', resolved: false }, imageSupport: 'supported', generated: false,
    }], 'std');
    const flagged = await resolve(['--provider', 'openai', '--model', 'flag-model', path]);
    expect(JSON.parse(flagged.out).target).toEqual({ provider: 'openai', api: 'openai-decisions', model: 'flag-model',
      endpoint: 'https://api.openai.com/v1/decisions', allowLocal: false, allowGenerated: false });
    const profiles = JSON.stringify({ version: 1, defaultProfile: 'direct', profiles: { direct: { provider: 'openai', model: 'profile-model' } } });
    const profiled = await resolve([writeRequest('plain.json', noul)], { DECISION_PROFILES: profiles });
    expectOut(profiled.out, [{
      target: { provider: 'openai', api: 'openai-decisions', model: 'profile-model', endpoint: 'https://api.openai.com/v1/decisions', allowLocal: false, allowGenerated: false },
      credential: { env: 'OPENAI_API_KEY', resolved: false }, imageSupport: 'supported', generated: false, profile: 'direct',
    }], 'std');
    const cases: [string[], Record<string, string>, number, string][] = [
      [['--model', 'a', '--model', 'b', path], {}, 22, 'Duplicate decision flag'],
      [['--provider', 'nope', path], {}, 22, 'Unknown decision provider'],
      // Oracle 0.8.1: a profile flag without any profile document reports the missing document field.
      [['--profile', 'missing', path], {}, 22, 'missing wire field'],
      [[writeRequest('conflict.json', { ...noul, profile: 'direct', provider: 'typesafe' })], { DECISION_PROFILES: profiles }, 22, 'Decision profile conflicts with explicit provider'],
      [[path], { DECISION_PROFILES: '{' }, 1, 'unexpected end'],
      [[writeRequest('custom.json', { ...noul, provider: 'custom' })], {}, 22, 'custom requires explicit api, endpoint and model'],
      [[writeRequest('remote-http.json', { ...noul, provider: 'openai', endpoint: 'http://example.com/v1/decisions', allowLocal: true })], {}, 22, ENDPOINT],
      [[writeRequest('localhost.json', { ...noul, provider: 'llama-system-one', endpoint: 'http://localhost:8080/v1/systemone', allowLocal: true })], {}, 22, ENDPOINT],
      [[writeRequest('no-opt-in.json', { ...noul, provider: 'llama-system-one' })], {}, 22, ENDPOINT],
      [[writeRequest('generated.json', { ...noul, provider: 'anthropic' })], {}, 22, 'Generated decisions require allowGenerated:true'],
      [[], {}, 2, 'Decision command requires a request file'],
    ];
    const actual = [];
    for (const [args, extra] of cases) {
      const r = await resolve(args, extra);
      actual.push([args.at(-1), r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, , code, message]) => [args.at(-1), code, '', message]));
    expect([j.credentials(), j.curls().length]).toEqual(['', 0]);
    expect(seen.length).toBeGreaterThanOrEqual(0);
  });

  test('decide validates and preflights before credentials; missing keys and zero budgets never dispatch', async () => {
    const j = jevEnv({ DECISION_CREDENTIAL_COMMAND: JSON.stringify(['/bin/sh', credential]) });
    const cases: [string[], number, string][] = [
      [['decide', writeRequest('d-invalid.json', { state: 'x', questions: {} })], 22, 'invalid question count'],
      [['decide', writeRequest('d-provider.json', { ...noul, provider: 'unregistered' })], 22, 'Unknown decision provider'],
      [['decide', writeRequest('d-image.json', { ...noul, provider: 'openrouter', images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }] })], 22, 'Images are unsupported by this decision transport'],
      [['decide', '--provider', 'typesafe', '--provider', 'typesafe', requestFile], 22, 'Duplicate decision flag'],
      [['decide', requestFile, '0'], 1, 'decision budget exhausted'],
      [['decide', '--timeout-ms', '0', requestFile], 2, 'timeout must be an integer within the operation limit'],
    ];
    const actual = [];
    for (const [args] of cases) {
      const r = await run(args, { env: j.env });
      actual.push([args, r.code, r.out, r.err.trim()]);
    }
    expect(actual).toEqual(cases.map(([args, code, message]) => [args, code, '', message]));
    expect([j.credentials(), j.curls().length]).toEqual(['', 0]);
    const missing = jevEnv();
    const r = await run(['decide', requestFile], { env: missing.env });
    expect([r.code, r.out, r.err]).toEqual([1, '', 'Missing provider key or JEV_CREDENTIAL_COMMAND\n']);
    expect(missing.curls().length).toBe(0);
  });
});

describe.concurrent('decide against a local fake endpoint (http://127.0.0.1, allowLocal)', () => {
  // Real curl reaches only the loopback server above; no other host is reachable from these requests.
  const env = (extra: Record<string, string> = {}) => ({ PATH: '/usr/bin:/bin', JEV_FABRIC_HOME: join(fx.root, `decide-${serial++}`), ...extra });

  test('one CLI decision: the exact lossless result, anonymous on loopback, the request body as sent', async () => {
    const path = writeRequest('local-ok.json', local('/v1/cli-ok'));
    const r = await run(['decide', path], { env: env() });
    expect([r.code, r.err]).toEqual([0, '']);
    expectOut(r.out, [decided({ exhausted: true, reason: '' })], 'std');
    const [request] = hits('/v1/cli-ok');
    expect(request!.method).toBe('POST');
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers.authorization).toBeUndefined();
    expect(JSON.parse(request!.body)).toEqual({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } }, model: 'm' });
    // With DECISION_API_KEY the custom target sends a bearer key.
    const keyed = await run(['decide', writeRequest('local-key.json', local('/v1/cli-key'))], { env: env({ DECISION_API_KEY: KEY }) });
    expect(keyed.code).toBe(0);
    expect(hits('/v1/cli-key')[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(keyed.out).not.toContain(KEY);
  });

  test('budgets: a reported-token overshoot, unknown usage and HTTP errors are results that exhaust the budget', async () => {
    const over = await run(['decide', writeRequest('local-over.json', local('/v1/over')), '3'], { env: env() });
    expect(over.code).toBe(0);
    expectOut(over.out, [decided({ exhausted: true, reason: 'reported-token-limit' })], 'std');
    const unknown = await run(['decide', writeRequest('local-nousage.json', local('/nousage'))], { env: env() });
    expect(unknown.code).toBe(0);
    expect(JSON.parse(unknown.out)).toMatchObject({ status: 'ok', usage: { input_tokens: null, output_tokens: null }, budget: { exhausted: true, reason: 'unknown-usage' } });
    const limited = await run(['decide', writeRequest('local-429.json', local('/status/429'))], { env: env() });
    expect(limited.code).toBe(0);
    const result = JSON.parse(limited.out);
    expect(result).toMatchObject({ status: 'error', httpStatus: 429, budget: { exhausted: true } });
    expect(result.rawJson).toBe('{"error":{"type":"rate_limit","opaque":9007199254740993}}');
    const bad = await run(['decide', writeRequest('local-bad.json', local('/bad'))], { env: env() });
    expect(JSON.parse(bad.out)).toMatchObject({ status: 'error', usage: { input_tokens: 3, output_tokens: 1 } });
    // Never retried, never redirected.
    expect([hits('/status/429').length, hits('/nousage').length, hits('/bad').length]).toEqual([1, 1, 1]);
    const redirected = await run(['decide', writeRequest('local-redirect.json', local('/redirect'))], { env: env() });
    expect(JSON.parse(redirected.out)).toMatchObject({ status: 'error', httpStatus: 302 });
    expect(hits('/target').length).toBe(0);
  });

  test('the decision deadline bounds one attempt', async () => {
    const r = await run(['decide', '--timeout-ms', '400', writeRequest('local-slow.json', local('/slow'))], { env: env() });
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe('Decision transport failed, timed out, was interrupted, or exceeded its output bound\n');
    expect(r.ms).toBeLessThan(2500);
    expect(hits('/slow').length).toBe(1);
  });

  test('serve: decide and jev share one evaluation budget; a per-request credential is sent once', async () => {
    const s = fx.store();
    const c = await serve(fx, s, ['2', '100'], env());
    const first = await c.send({ id: 1, op: 'decide', request: local('/v1/serve-1') });
    expect(first).toEqual({ id: 1, ok: true, result: decided({ exhausted: false, reason: '' }) });
    expect(c.rawById.get(1)).toBe(JSON.stringify({ id: 1, ok: true, result: decided({ exhausted: false, reason: '' }) }));
    // jev has no credential here: it fails before dispatch and spends nothing.
    expect(await c.send({ id: 2, op: 'jev', request: noul }))
      .toEqual({ id: 2, ok: false, error: { code: 1, message: 'Missing provider key or JEV_CREDENTIAL_COMMAND' } });
    const second = await c.send({ id: 3, op: 'decide', request: local('/v1/serve-2'), credential: REQUEST_KEY });
    expect(second.result.budget).toEqual({ exhausted: true, reason: '' });
    expect(hits('/v1/serve-2')[0]!.headers.authorization).toBe(`Bearer ${REQUEST_KEY}`);
    expect(await c.send({ id: 4, op: 'decide', request: local('/v1/serve-3') }))
      .toEqual({ id: 4, ok: false, error: { code: 1, message: 'decision budget exhausted' } });
    expect(await c.send({ id: 5, op: 'jev', request: noul })).toEqual({ id: 5, ok: false, error: { code: 1, message: 'Jev budget exhausted' } });
    expect(hits('/v1/serve-3').length).toBe(0);
    const resolved = await c.ok({ op: 'resolveDecision', request: local('/v1/serve-4') });
    expect(resolved).toEqual({
      target: { provider: 'custom', api: 'system-one', model: 'm', endpoint: `http://127.0.0.1:${server.port}/v1/serve-4`, allowLocal: true, allowGenerated: false },
      credential: { env: 'DECISION_API_KEY', resolved: false }, imageSupport: 'unsupported', generated: false,
    });
    const { code, err } = await c.close();
    expect([code, err]).toEqual([0, '']);
    for (const raw of c.rawById.values()) expect(raw).not.toContain(REQUEST_KEY);
  });
});
