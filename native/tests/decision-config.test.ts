import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'jev-decision-config-'));
const bin = process.env.JEV_NATIVE_PREBUILT === '1' ? pathResolve('build/test-decision-config') : join(root, 'config');
beforeAll(() => {
  if (process.env.JEV_NATIVE_PREBUILT === '1') return;
  const r = Bun.spawnSync(['bend', pathResolve('native/tests/decision-config.bend'), '-o', bin], {
    env: { ...process.env, BEND_NO_TELEMETRY: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  });
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0);
}, 35000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]): string {
  const r = Bun.spawnSync([bin, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 3000 });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().trim();
}
function config(request: object | string = {}, provider = '', model = '', endpoint = '', account = ''): any {
  const out = run([typeof request === 'string' ? request : JSON.stringify(request), provider, model, endpoint, account]);
  return out.startsWith('error:') ? out : JSON.parse(out);
}
const account = '0123456789abcdef0123456789abcdef';

test('canonical presets, verified defaults and pure 14-provider discovery', () => {
  const providers = JSON.parse(run(['providers']));
  expect(providers).toHaveLength(14);
  expect(new Set(providers.map((p: any) => p.provider)).size).toBe(14);
  expect(providers.some((p: any) => p.provider === 'vercel-ai-gateway')).toBe(false);
  for (const p of providers) {
    expect(Object.keys(p).sort()).toEqual(['api', 'credentialEnv', 'defaultModel', 'endpoint', 'generated', 'imageSupport', 'provider'].sort());
    expect(['supported', 'model-dependent', 'unsupported']).toContain(p.imageSupport);
    expect(typeof p.generated).toBe('boolean');
    if (p.provider === 'custom') continue;
    const settings = config({ allowLocal: true, allowGenerated: true }, p.provider, '', '', account);
    expect(settings.api).toBe(p.api);
    expect(settings.model).toBe(p.defaultModel);
    expect(settings.key_env).toBe(p.credentialEnv);
  }
  expect(config()).toMatchObject({ provider: 'typesafe', model: 'jev-latest', auth: 'bearer' });
  expect(config({}, 'openrouter').endpoint).toBe('https://openrouter.ai/api/v1/systemone');
  expect(config({}, 'vercel-evaluate').endpoint).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
  expect(config({}, 'vercel-decisions').model).toBe('openai/gpt-6-luna-decisions');
  expect(config({}, 'openai').model).toBe('gpt-6-luna');
  expect(config({}, 'opencode').model).toBe('jev-1.13');
  expect(config({}, 'openrouter').model).toBe('~typesafe/jev-latest');
  expect(config({}, 'subq')).toMatchObject({ api: 'system-one', endpoint: 'https://api.subq.ai/v1/systemone', model: 'subq-snap-preview', key_env: 'SUBQ_API_KEY', auth: 'bearer' });
  expect(providers.find((p: any) => p.provider === 'subq').imageSupport).toBe('supported');
  expect(providers.find((p: any) => p.provider === 'typesafe').imageSupport).toBe('supported');
  expect(config({ images: [{ data: 'AA==', mimeType: 'image/png' }] }, 'subq').provider).toBe('subq');
  expect(config({ allowLocal: true }, 'llama.cpp').endpoint).toBe('http://127.0.0.1:8080');
  expect(config({ allowLocal: true }, 'llama-system-one').endpoint).toBe('http://127.0.0.1:8080/v1/systemone');
  expect(config({ provider: 'vercel-ai-gateway' }).provider).toBe('vercel');
  expect(config({ allowGenerated: true }, 'anthropic')).toMatchObject({ auth: 'anthropic', model: 'claude-haiku-4-5-20251001' });
  expect(config({ allowGenerated: true }, 'google', 'gemini-test')).toMatchObject({ auth: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent' });
});

test('request/env precedence, explicit custom and overridable model IDs', () => {
  expect(config({ model: 'request' }, '', 'env').model).toBe('request');
  expect(config({}, '', 'env').model).toBe('env');
  expect(config({ endpoint: 'https://example.com/request' }, '', '', 'https://example.com/env').endpoint).toBe('https://example.com/request');
  expect(config({}, '', '', 'https://example.com/env').endpoint).toBe('https://example.com/env');
  expect(config({ provider: 'anthropic', model: 'deployment-specific-model', allowGenerated: true }).model).toBe('deployment-specific-model');
  expect(config({ provider: 'custom', api: 'openai-decisions', endpoint: 'https://example.com/v1/decisions', model: 'example' })).toMatchObject({ key_env: 'DECISION_API_KEY', auth: 'bearer' });
  expect(config({ provider: 'custom', api: 'system-one' }, '', 'env-model', 'https://example.com')).toMatch(/^error:/);
});

test('model names count Unicode scalars without using the HTTP header character policy', () => {
  const model = '😀'.repeat(256);
  expect(config({ model }).model).toBe(model);
  expect(config({}, '', model).model).toBe(model);
  for (const invalid of [model + '😀', 'line\nfeed', 'bad\u007fmodel']) {
    expect(config({ model: invalid })).toMatch(/^error:/);
  }
});

test('invalid config fails purely rather than falling back or discarding capability fields', () => {
  const invalid = [
    [], { provider: 'custom' }, { provider: 'nope' }, { provider: 'anthropropic' },
    { api: 'openai-decisions' }, { api: 'bogus' }, { provider: null }, { model: '' }, { endpoint: '' },
    { allowLocal: 1 }, { allowGenerated: 'true' }, { provider: 'llama.cpp' }, { provider: 'llama-system-one' },
    { provider: 'anthropic' }, { provider: 'google' }, { provider: 'cloudflare-workers-ai' },
    { provider: 'openrouter', model: 'vision-model', images: ['x'] }, { provider: 'opencode', images: ['x'] },
    { provider: 'vercel-decisions', images: ['x'] }, { provider: 'vercel-evaluate', images: ['x'] },
    { provider: 'llama.cpp', allowLocal: true, images: ['x'] }, { images: null }, { temperature: 0.5 },
    { provider: 'llama.cpp', allowLocal: true, temperature: '0.5' }, { provider: 'subq', providerOptions: {} },
    { provider: 'vercel-evaluate', providerOptions: [] },
    { provider: 'anthropic', allowGenerated: true, temperature: 0.5 },
    { endpoint: 'http://example.com', allowLocal: true },
    { provider: 'custom', api: 'openai-decisions', endpoint: 'https://AI-GATEWAY.VERCEL.SH/v1/decisions', model: 'vision', images: ['x'] },
    '{"provider":"typesafe","provider":"openai"}',
  ];
  for (const input of invalid) expect(config(input), JSON.stringify(input)).toMatch(/^error:/);
});

test('implemented image and optional-field capabilities are accepted', () => {
  const valid = [
    { images: [] }, { provider: 'openai', images: ['x'] }, { images: ['x'] }, { providerOptions: { longContext: true } },
    { provider: 'anthropic', allowGenerated: true, images: ['x'], providerOptions: {} },
    { provider: 'google', allowGenerated: true, images: ['x'], providerOptions: {} },
    { provider: 'llama-system-one', allowLocal: true, images: ['x'] },
    { provider: 'llama.cpp', allowLocal: true, temperature: 0.5 },
    { provider: 'openrouter', providerOptions: {} }, { provider: 'vercel-evaluate', providerOptions: {} },
    { provider: 'openai', providerOptions: { safety_identifier: 'test' } },
    { endpoint: 'http://127.0.0.1:8080/path', allowLocal: true },
  ];
  for (const input of valid) expect(typeof config(input), JSON.stringify(input)).toBe('object');
});

test('Cloudflare wrapper compatibility, direct Clef aliases, account guard and model-specific images', () => {
  expect(config({}, 'cloudflare-workers-ai', '', '', account)).toMatchObject({ model: 'typesafe/jev', endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run` });
  for (const model of ['clef', 'clef-flash', '@cf/cloudflare/clef', '@cf/cloudflare/clef-flash']) {
    const canonical = model.split('/').at(-1);
    expect(config({ model, images: ['x'] }, 'cloudflare-workers-ai', '', '', account)).toMatchObject({ model: canonical, endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${canonical}` });
  }
  expect(config({}, 'cloudflare-workers-ai', '', '', 'foo/path')).toMatch(/^error:/);
  expect(config({}, 'cloudflare-workers-ai', '', 'https://example.com/cloudflare').endpoint).toBe('https://example.com/cloudflare');
  for (const model of ['typesafe/jev', 'unknown']) {
    expect(config({ provider: 'custom', api: 'cloudflare', endpoint: 'https://example.com', model, images: ['x'] })).toMatch(/^error:/);
  }
});
