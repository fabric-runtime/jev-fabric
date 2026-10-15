import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expectFixture, tempRoot } from './helpers.ts';

const root = tempRoot('decision-targets-');
const bin = resolve('build/test-decision-targets');
beforeAll(() => { expectFixture('decision-targets', 300000); expectFixture('decision-target-cli', 300000); }, 610000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const base = { state: { private: 'PRIVATE_STATE_SENTINEL' }, questions: { q: { type: 'boolean', instructions: 'Is this true?' } } };
const profiles = {
  version: 1, defaultProfile: 'router', profiles: {
    router: { provider: 'openrouter', model: 'profile-model', providerOptions: { order: ['x'] } },
    direct: { provider: 'openai', model: 'profile-openai' },
    local: { provider: 'llama.cpp', allowLocal: true, temperature: 0.5 },
    generated: { provider: 'google', allowGenerated: true, temperature: 0.7 },
  },
};
const env = { DECISION_PROFILES: JSON.stringify(profiles) };
function run(args: string[], extra: Record<string, string> = {}) {
  const selected = args[0] === 'resolve' ? bin : resolve('build/test-decision-target-cli');
  const result = Bun.spawnSync([selected, '--', ...args], {
    env: { PATH: process.env.PATH!, BEND_NO_TELEMETRY: '1', ...extra },
    stdout: 'pipe', stderr: 'pipe', timeout: 10000,
  });
  if (result.exitCode === 0 && (args[0] === 'file' || args[0] === 'protocol')) return run(['resolve', result.stdout.toString().trim()], extra);
  return result;
}
function resolution(request: object = {}, extra: Record<string, string> = {}) {
  const r = run(['resolve', JSON.stringify({ ...base, ...request })], extra);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const text = r.stdout.toString();
  expect(text).not.toContain('PRIVATE_STATE_SENTINEL');
  expect(text).not.toContain('"state"');
  expect(text).not.toContain('"questions"');
  expect(text).not.toContain('"images"');
  return JSON.parse(text);
}
function rejected(request: object, extra: Record<string, string> = {}) {
  const r = run(['resolve', JSON.stringify({ ...base, ...request })], extra);
  expect(r.exitCode, r.stdout.toString()).not.toBe(0);
  return r.stderr.toString();
}

test('offline resolution returns the exact stable sanitized contract', () => {
  expect(resolution()).toEqual({
    target: { provider: 'typesafe', api: 'system-one', model: 'jev-latest', endpoint: 'https://api.typesafe.ai/v1/systemone', allowLocal: false, allowGenerated: false },
    credential: { env: 'TYPESAFE_API_KEY', resolved: false }, imageSupport: 'supported', generated: false,
  });
});

test('selected profile and explicit model share the Unicode scalar boundary', () => {
  const model = '😀'.repeat(256);
  const extra = { DECISION_PROFILES: JSON.stringify({ version: 1, defaultProfile: 'scalar', profiles: { scalar: { provider: 'typesafe', model } } }) };
  expect(resolution({ model }).target.model).toBe(model);
  expect(resolution({}, extra).target.model).toBe(model);
  expect(rejected({ model: model + '😀' })).toContain('model');
});

test('explicit provider never inherits another provider ambient model or endpoint', () => {
  const ambient = { DECISION_PROVIDER: 'openrouter', DECISION_MODEL: 'ambient-router', DECISION_ENDPOINT: 'https://ambient.invalid/systemone' };
  expect(resolution({}, ambient).target).toMatchObject({ provider: 'openrouter', model: 'ambient-router', endpoint: ambient.DECISION_ENDPOINT });
  expect(resolution({ provider: 'openai' }, ambient).target).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', endpoint: 'https://api.openai.com/v1/decisions' });
  expect(resolution({ provider: 'openai', model: 'request', endpoint: 'https://request.invalid/decisions' }, ambient).target).toMatchObject({ model: 'request', endpoint: 'https://request.invalid/decisions' });
});

test('profile precedence, aliases and same-provider overrides', () => {
  expect(resolution({}, env)).toMatchObject({ profile: 'router', target: profiles.profiles.router });
  expect(resolution({}, { ...env, DECISION_PROFILE: 'direct' })).toMatchObject({ profile: 'direct', target: { provider: 'openai' } });
  expect(resolution({ profile: 'router', model: 'override' }, { ...env, DECISION_PROFILE: 'direct', DECISION_MODEL: 'ambient', DECISION_ENDPOINT: 'https://bad.invalid' })).toMatchObject({ profile: 'router', target: { model: 'override', endpoint: 'https://openrouter.ai/api/v1/systemone' } });
  expect(resolution({ profile: 'router', provider: 'openrouter' }, env).profile).toBe('router');
  expect(resolution({ profile: 'alias', provider: 'vercel' }, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { alias: { provider: 'vercel-ai-gateway' } } }) }).target.provider).toBe('vercel');
  rejected({ profile: 'router', provider: 'openai' }, env);
});

test('explicit target switches bypass ambient/default profiles and their providerOptions', () => {
  const r = resolution({ provider: 'openai' }, { ...env, DECISION_PROFILE: 'router', DECISION_MODEL: 'ambient', DECISION_ENDPOINT: 'https://bad.invalid' });
  expect(r.profile).toBeUndefined();
  expect(r.target.providerOptions).toBeUndefined();
  expect(r.target.model).toBe('gpt-6-luna');
  expect(resolution({ profile: 'direct' }, env).target.providerOptions).toBeUndefined();
});

test('request providerOptions replace the whole profile object', () => {
  const r = resolution({ profile: 'router', providerOptions: { only: ['y'] } }, env);
  expect(r.target.providerOptions).toEqual({ only: ['y'] });
});

test('all configured documents fail closed, including unused invalid targets', () => {
  const invalid: unknown[] = [null, [], {}, { version: 0, profiles: {} }, { version: 1.1, profiles: {} }, { version: 2, profiles: {} }, { version: '1', profiles: {} },
    { version: 1, profiles: [] }, { version: 1, profiles: {}, extra: true },
    { version: 1, profiles: {}, defaultProfile: 'missing' },
    { version: 1, profiles: {}, defaultProfile: '' },
    { version: 1, profiles: { bad: {} } },
    { version: 1, profiles: { bad: { provider: 'unknown' } } },
    ...['credential', 'apiKey', 'credentialCommand', 'state', 'questions', 'images', 'extra'].map(key => ({ version: 1, profiles: { bad: { provider: 'openai', [key]: 'SECRET_SENTINEL' } } })),
    ...[{ provider: 1 }, { provider: 'openai', model: '' }, { provider: 'openai', allowLocal: 'true' }, { provider: 'openai', providerOptions: [] }, { provider: 'google', temperature: '0.5' }].map(bad => ({ version: 1, profiles: { bad } })),
  ];
  for (const doc of invalid) {
    const err = rejected({ provider: 'openai' }, { DECISION_PROFILES: JSON.stringify(doc) });
    expect(err).not.toContain('SECRET_SENTINEL');
  }
  for (const text of ['', ' ', '{', '{"version":1,"version":1,"profiles":{}}']) rejected({}, { DECISION_PROFILES: text });
});

test('portable structural constraints reject unused targets before credentials or dispatch', () => {
  const tools = join(root, 'structural-tools'); mkdirSync(tools);
  const marker = join(tools, 'effects');
  for (const name of ['curl', 'credential']) {
    writeFileSync(join(tools, name), `#!/bin/sh\nprintf effect >> '${marker}'\nexit 99\n`);
    chmodSync(join(tools, name), 0o700);
  }
  const bad = [
    { api: 'not-an-api' }, { api: null }, { model: 'm'.repeat(257) }, { model: '😀'.repeat(257) },
    { temperature: -0.01 }, { temperature: 2.01 },
    ...['https://example.com/?safe=1', 'https://example.com/?', 'https://example.com/#',
      'https://user@example.com/', 'https://@example.com/', 'https://example.com/\\path',
      'http://example.com/', 'ftp://example.com/', 'http://localhost/', 'http://127.1/',
      'http://2130706433/', 'http://127.0.0.1.evil/', 'https://example.com/café'].map(endpoint => ({ endpoint })),
  ];
  for (const fields of bad) {
    const doc = { version: 1, defaultProfile: 'ok', profiles: { ok: { provider: 'typesafe' }, bad: { provider: 'typesafe', ...fields } } };
    const err = rejected({}, { DECISION_PROFILES: JSON.stringify(doc), PATH: `${tools}:${process.env.PATH}`,
      DECISION_CREDENTIAL_COMMAND: join(tools, 'credential'), JEV_CREDENTIAL_COMMAND: join(tools, 'credential') });
    expect(err).not.toContain('not-an-api');
  }
  expect(existsSync(marker)).toBe(false);
});

test('portable valid APIs and scalar boundaries parse before provider compatibility and local opt-in', () => {
  for (const api of ['system-one', 'cloudflare', 'openai-decisions', 'vercel-evaluate', 'llama-cpp', 'llama-system-one', 'anthropic', 'google']) {
    const extra = { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { other: { provider: 'typesafe', api, model: '😀'.repeat(256) } } }) };
    expect(resolution({}, extra).credential.resolved).toBe(false);
    expect(resolution({ profile: 'other', api: 'system-one', model: 'override' }, extra).target.api).toBe('system-one');
    if (api !== 'system-one') rejected({ profile: 'other', model: 'override' }, extra);
  }
  for (const temperature of [0, 2]) {
    expect(resolution({}, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { unused: { provider: 'typesafe', temperature } } }) }).credential.resolved).toBe(false);
  }
  for (const endpoint of ['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
    const extra = { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { local: { provider: 'typesafe', endpoint, allowLocal: false } } }) };
    resolution({}, extra);
    rejected({ profile: 'local' }, extra);
    expect(resolution({ profile: 'local', allowLocal: true }, extra).target.endpoint).toBe(endpoint);
  }
});

test('profile targets reject nested credentials and credential-bearing endpoints without disclosure', () => {
  for (const key of ['apiKey', 'api_key', 'client-secret', 'PASSWORD', 'credentialCommand', 'authorization', 'headers', 'token', 'access_token', 'private-key']) {
    const doc = { version: 1, profiles: { unused: { provider: 'openrouter', providerOptions: { nested: [{ [key]: 'SECRET_VALUE_SENTINEL' }] } } } };
    expect(rejected({ provider: 'openai' }, { DECISION_PROFILES: JSON.stringify(doc) })).not.toContain('SECRET_VALUE_SENTINEL');
  }
  for (const endpoint of ['https://user:SECRET_VALUE_SENTINEL@example.com/api', 'https://example.com/api?api_key=SECRET_VALUE_SENTINEL', 'https://example.com/api?%74oken=SECRET_VALUE_SENTINEL']) {
    expect(rejected({ provider: 'openai' }, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { unused: { provider: 'openai', endpoint } } }) })).not.toContain('SECRET_VALUE_SENTINEL');
  }
});

test('profile names are portable, bounded and prototype-safe with own-member lookup', () => {
  for (const name of ['', '__proto__', 'prototype', 'constructor', 'two words', 'é', 'x\n', 'x'.repeat(129)]) {
    rejected({ profile: name }, env);
    rejected({}, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { [name]: { provider: 'openai' } } }) });
  }
  for (const name of ['a', 'a-Z_0.9', 'x'.repeat(128)]) {
    expect(resolution({ profile: name }, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { [name]: { provider: 'openai' } } }) }).profile).toBe(name);
  }
  rejected({ profile: 'missing' }, env);
  rejected({}, { ...env, DECISION_PROFILE: 'missing' });
  rejected({ profile: null }, env);
  rejected({}, { DECISION_PROFILE: 'toString' });
});

test('128-profile and 64KiB limits are enforced on the full document', () => {
  const entries = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`p${i}`, { provider: 'openai' }]));
  const doc = JSON.stringify({ version: 1, profiles: entries });
  expect(resolution({ profile: 'p127' }, { DECISION_PROFILES: doc }).profile).toBe('p127');
  rejected({}, { DECISION_PROFILES: JSON.stringify({ version: 1, profiles: { ...entries, overflow: { provider: 'openai' } } }) });
  const small = JSON.stringify({ version: 1, profiles: {} });
  expect(resolution({}, { DECISION_PROFILES: small + ' '.repeat(65536 - small.length) }).target.provider).toBe('typesafe');
  rejected({}, { DECISION_PROFILES: small + ' '.repeat(65537 - small.length) });
});

test('explicit trusted profiles file, inline precedence and no implicit discovery', () => {
  const path = join(root, 'profiles.json');
  writeFileSync(path, JSON.stringify(profiles));
  expect(resolution({}, { DECISION_PROFILES_FILE: path }).profile).toBe('router');
  expect(resolution({}, { ...env, DECISION_PROFILES_FILE: join(root, 'missing.json') }).profile).toBe('router');
  rejected({}, { DECISION_PROFILES_FILE: join(root, 'missing.json') });
  writeFileSync(path, '');
  rejected({}, { DECISION_PROFILES_FILE: path });
  writeFileSync(path, '{');
  rejected({ provider: 'openai' }, { DECISION_PROFILES_FILE: path });
  expect(resolution().profile).toBeUndefined();
});

test('offline resolution never runs a credential resolver or dispatches curl', () => {
  const tools = join(root, 'tools'); mkdirSync(tools);
  const marker = join(root, 'effects');
  const bomb = `#!/bin/sh\nprintf effect >> '${marker}'\nexit 99\n`;
  const command = join(tools, 'credential');
  for (const name of ['curl', 'credential']) { writeFileSync(join(tools, name), bomb); chmodSync(join(tools, name), 0o700); }
  const extra = { PATH: `${tools}:${process.env.PATH}`, DECISION_CREDENTIAL_COMMAND: command, JEV_CREDENTIAL_COMMAND: command, OPENAI_API_KEY: 'SECRET_SENTINEL', TYPESAFE_API_KEY: 'SECRET_SENTINEL' };
  const r = resolution({ provider: 'openai' }, extra);
  expect(r.credential).toEqual({ env: 'OPENAI_API_KEY', resolved: false });
  expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL');
  rejected({ provider: 'openrouter', images: [{ mimeType: 'image/png', data: 'AA==' }] }, extra);
  expect(existsSync(marker)).toBe(false);
});

test('resolved image capabilities reflect Cloudflare models and real adapter constraints', () => {
  const account = '0123456789abcdef0123456789abcdef';
  for (const model of ['clef', 'clef-flash', '@cf/cloudflare/clef']) {
    const r = resolution({ provider: 'cloudflare-workers-ai', model }, { CLOUDFLARE_ACCOUNT_ID: account });
    expect(r.imageSupport).toBe('supported');
    expect(r.target.model).toBe(model.split('/').at(-1));
    expect(r.target.endpoint).toContain('/ai/run/@cf/cloudflare/');
  }
  expect(resolution({ provider: 'cloudflare-workers-ai' }, { CLOUDFLARE_ACCOUNT_ID: account }).imageSupport).toBe('unsupported');
  expect(resolution({ provider: 'llama-system-one', allowLocal: true }).imageSupport).toBe('model-dependent');
  expect(resolution({ provider: 'custom', api: 'openai-decisions', model: 'm', endpoint: 'https://example.com/decisions' }).imageSupport).toBe('supported');
  expect(resolution({ provider: 'custom', api: 'openai-decisions', model: 'm', endpoint: 'https://ai-gateway.vercel.sh/v1/decisions' }).imageSupport).toBe('unsupported');
  const image = { mimeType: 'image/png', data: 'AA==' };
  for (const provider of ['typesafe', 'openrouter', 'vercel-decisions', 'vercel-evaluate']) rejected({ provider, images: [image] });
  rejected({ provider: 'openai', images: ['https://example.com/image.png'] });
  rejected({ provider: 'openai', images: [{ ...image, data: 'bad=' }] });
  expect(resolution({ provider: 'openai', images: [image] }).imageSupport).toBe('supported');
  const subq = resolution({ provider: 'subq', images: [image] });
  expect(subq.imageSupport).toBe('supported');
  expect(subq.target).toMatchObject({ provider: 'subq', api: 'system-one', model: 'subq-snap-preview', endpoint: 'https://api.subq.ai/v1/systemone' });
  expect(subq.credential).toEqual({ env: 'SUBQ_API_KEY', resolved: false });
  rejected({ provider: 'subq', images: Array(5).fill(image) });
});

test('Local preflight and generated adapter opt-ins run offline', () => {
  expect(resolution({ profile: 'local' }, env)).toMatchObject({ target: { api: 'llama-cpp', allowLocal: true, temperature: 0.5 }, generated: false });
  expect(resolution({ profile: 'generated' }, env)).toMatchObject({ target: { api: 'google', allowGenerated: true, temperature: 0.7 }, generated: true });
  rejected({ provider: 'google' });
  rejected({ provider: 'llama.cpp' });
  rejected({ provider: 'llama.cpp', allowLocal: true, temperature: 0 });
  rejected({ provider: 'llama.cpp', allowLocal: true, questions: { q: { type: 'choice', instructions: 'Pick', criteria: Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`k${i}`, 'x'])) } } });
  rejected({ provider: 'google', allowGenerated: true, providerOptions: { unknown: true } });
  rejected({ provider: 'openai', providerOptions: { model: 'override' } });
});

test('validateDecision accepts structural profile names without consulting configuration', () => {
  const request = { ...base, profile: 'not-configured' };
  const r = run(['validate', JSON.stringify({ id: 1, op: 'validateDecision', request })], { DECISION_PROFILES: '{' });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(JSON.parse(r.stdout.toString())).toEqual(request);
  for (const profile of ['', '__proto__', 'prototype', 'constructor', 'x'.repeat(129), null]) {
    expect(run(['validate', JSON.stringify({ id: 1, op: 'validateDecision', request: { ...base, profile } })]).exitCode).not.toBe(0);
  }
});

test('resolveDecision protocol is advertised and accepts only request', () => {
  const features = run(['features']);
  expect(features.exitCode).toBe(0);
  expect(JSON.parse(features.stdout.toString())).toContain('decision-targets');
  const r = run(['protocol', JSON.stringify({ id: 1, op: 'resolveDecision', request: base })]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(JSON.parse(r.stdout.toString()).credential.resolved).toBe(false);
  for (const extra of [{ credential: 'secret' }, { provider: 'openai' }, { timeoutMs: 100 }]) {
    expect(run(['protocol', JSON.stringify({ id: 1, op: 'resolveDecision', request: base, ...extra })]).exitCode).not.toBe(0);
  }
});

test('decide and resolve-decision share duplicate-free flag and timeout parsing', () => {
  for (const command of ['decide', 'resolve-decision']) {
    const r = run(['cli', command, '--model', 'm', '--provider', 'openai', '--profile', 'direct', '--api', 'openai-decisions', '--endpoint', 'https://x.test', '--timeout-ms', '123', 'request.json']);
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const parsed = JSON.parse(r.stdout.toString());
    expect(parsed).toMatchObject({ command, path: 'request.json', tokens: '100000', timeoutMs: 123 });
    expect(JSON.parse(parsed.overrides)).toEqual({ provider: 'openai', model: 'm', profile: 'direct', api: 'openai-decisions', endpoint: 'https://x.test' });
    for (const flag of ['--provider', '--model', '--profile', '--api', '--endpoint', '--timeout-ms']) {
      const value = flag === '--timeout-ms' ? '123' : 'x';
      expect(run(['cli', command, flag, value, flag, value, 'request.json']).exitCode).not.toBe(0);
      expect(run(['cli', command, flag]).exitCode).not.toBe(0);
    }
    expect(run(['cli', command, '--unknown', 'x', 'request.json']).exitCode).not.toBe(0);
  }
  const old = run(['cli', 'decide', '123', 'request.json', '100']);
  expect(old.exitCode, old.stderr.toString()).toBe(0);
  expect(JSON.parse(old.stdout.toString())).toMatchObject({ timeoutMs: 123, tokens: '100' });
  expect(run(['cli', 'decide', '--timeout-ms', '123', '456', 'request.json']).exitCode).not.toBe(0);
});

test('CLI flags override request-file values and preserve profile conflicts', () => {
  const path = join(root, 'request.json');
  writeFileSync(path, JSON.stringify({ ...base, provider: 'typesafe', model: 'file-model' }));
  const r = run(['file', 'resolve-decision', '--provider', 'openai', '--model', 'flag-model', path]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(JSON.parse(r.stdout.toString()).target).toMatchObject({ provider: 'openai', model: 'flag-model' });
  expect(run(['file', 'resolve-decision', '--profile', 'router', '--provider', 'openai', path], env).exitCode).not.toBe(0);
  const allowed = run(['file', 'resolve-decision', '--profile', 'router', '--provider', 'openrouter', path], env);
  expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
  expect(JSON.parse(allowed.stdout.toString()).target.model).toBe('file-model');
  writeFileSync(path, JSON.stringify({ ...base, provider: 'openrouter', providerOptions: { order: ['x'] } }));
  const switched = run(['file', 'resolve-decision', '--provider', 'openai', path]);
  expect(switched.exitCode, switched.stderr.toString()).toBe(0);
  expect(JSON.parse(switched.stdout.toString()).target.providerOptions).toBeUndefined();
});
