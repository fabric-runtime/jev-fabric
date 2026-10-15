import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Fabric, FabricError, type DecisionRequest } from '../../clients/typescript/jev-fabric.ts';
import { capture, nativeBin, tempRoot } from './helpers.ts';

const root = tempRoot('decisions-');
const bin = join(root, 'bin');
mkdirSync(bin);
const key = 'SYNTHETIC_DECISION_KEY';
const image = { data: 'aW1hZ2U=', mimeType: 'image/png' as const };
const questions = { q: { type: 'boolean' as const, instructions: 'Is this correct?' } };
const request: DecisionRequest = { provider: 'openai', state: { text: 'evidence' }, questions };
const usage = { input_tokens: 4, output_tokens: 2 };
const openaiReply = (answers: unknown[] = [{ name: 'q', type: 'predicate', probability: 0.8 }], counts: unknown = usage) => JSON.stringify({ model: 'actual-model', answers, usage: counts, provider_metadata: { trace: 'retained' } });
let serial = 0;

beforeAll(async () => {
  await Bun.write(join(root, 'curl.ts'), `
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const config = await Bun.stdin.text();
if (process.argv.some(x => x.includes('${key}'))) process.exit(9);
const value = (prefix) => JSON.parse(config.split('\\n').find(l => l.startsWith(prefix)).slice(prefix.length));
const chunks = config.split('\\n').filter(l => l.startsWith('json = ')).map(l => JSON.parse(l.slice('json = '.length)));
const body = JSON.parse(chunks.length ? chunks.join('') : value('data-binary = '));
const url = value('url = ');
const record = process.env.DECISION_RECORD;
const n = existsSync(record) ? readFileSync(record,'utf8').trim().split('\\n').length : 0;
const headers = config.split('\\n').filter(l => l.startsWith('header = ') && !l.includes('${key}')).map(l => JSON.parse(l.slice('header = '.length)));
appendFileSync(record, JSON.stringify({url,body,headers,hasKey:config.includes('${key}'),args:process.argv.slice(2)})+'\\n');
const replies = JSON.parse(process.env.DECISION_REPLIES);
const reply = replies[Math.min(n,replies.length-1)];
process.stdout.write(reply + '\\n' + (process.env.DECISION_HTTP_STATUS || '200'));
`);
  await Bun.write(join(bin, 'curl'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'curl.ts')}' "$@"\n`);
  chmodSync(join(bin, 'curl'), 0o700);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function session(replies = [openaiReply()], extra: Record<string, string> = {}, maxEvaluations = 4, maxTokens = 100) {
  const record = join(root, `record-${serial++}`);
  const env = { DECISION_PROVIDER: '', DECISION_MODEL: '', DECISION_ENDPOINT: '', DECISION_CREDENTIAL_COMMAND: '', CLOUDFLARE_ACCOUNT_ID: '', PATH: `${bin}:/usr/bin:/bin`, JEV_FABRIC_HOME: join(root, 'jobs'), JEV_PROVIDER: 'typesafe', OPENAI_API_KEY: key, TYPESAFE_API_KEY: key, OPENCODE_API_KEY: key, CLOUDFLARE_API_TOKEN: key, AI_GATEWAY_API_KEY: key, DECISION_RECORD: record, DECISION_REPLIES: JSON.stringify(replies), ...extra };
  const fabric = await Fabric.open({ binary: nativeBin, env, maxEvaluations, maxTokens });
  const rows = () => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { fabric, rows, env };
}

async function closed<T>(s: Awaited<ReturnType<typeof session>>, run: () => Promise<T>) {
  try { return await run(); } finally { await s.fabric.close(); }
}

test('decision feature, offline validation and provider validation do not dispatch', async () => {
  const s = await session();
  await closed(s, async () => {
    expect(s.fabric.ready.features).toContain('decisions');
    expect(await s.fabric.validateDecision(request)).toEqual(request);
    const error = await s.fabric.decide({ ...request, provider: 'unregistered' }).catch(e => e);
    expect(error).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(0);
  });
});

test('OpenAI image body and score distribution preserve raw numeric lexemes and provider metadata', async () => {
  const raw = '{"model":"actual-model","answers":[{"name":"s","type":"score","score":0.8,"confidence":0.123456789012345678901,"probabilities":[{"value":0,"probability":0.2},{"value":1,"probability":0.8}]}],"usage":{"input_tokens":4,"output_tokens":2},"provider_metadata":{"trace":"retained"}}';
  const s = await session([raw]);
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, images: [image], questions: { s: { type: 'score', instructions: 'severity', criteria: ['low', 'high'] } } });
    expect(result.status).toBe('ok');
    expect(result.model).toBe('actual-model');
    expect(result.answers.s).toMatchObject({ type: 'score', score: 0.8, probabilities: { '0': 0.2, '1': 0.8 } });
    expect(result.rawJson).toBe(raw);
    expect(result.raw).toHaveProperty('provider_metadata.trace', 'retained');
    expect(result.provenance?.kind).toBe('native');
    expect(s.rows()[0].body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' });
    expect(s.rows()[0].hasKey).toBe(true);
  });
});

test('per-question refusal preserves siblings and reported usage', async () => {
  const s = await session([openaiReply([{ name: 'q', type: 'predicate', probability: 0.8 }, { name: 'r', type: 'refusal' }])]);
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, questions: { ...questions, r: questions.q } });
    expect(result.status).toBe('ok');
    expect(result.answers.q).toEqual({ type: 'boolean', probability: 0.8 });
    expect(result.answers.r.type).toBe('refusal');
    expect(result.usage).toEqual(usage);
  });
});

test('unknown usage stays unknown and blocks later evaluations without another dispatch', async () => {
  const s = await session([openaiReply(undefined, undefined).replace(',"usage":{"input_tokens":4,"output_tokens":2}', '')]);
  await closed(s, async () => {
    const result = await s.fabric.decide(request);
    expect(result.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(result.budget).toEqual({ exhausted: true, reason: 'unknown-usage' });
    expect(await s.fabric.decide(request).catch(e => e)).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(1);
  });
});

test('malformed answers retain raw evidence and account usage before ending budget', async () => {
  const raw = openaiReply([{ name: 'wrong', type: 'predicate', probability: 0.8 }]);
  const s = await session([raw], {}, 4, 5);
  await closed(s, async () => {
    const result = await s.fabric.decide(request);
    expect(result.status).toBe('error');
    expect(result.usage).toEqual(usage);
    expect(result.rawJson).toBe(raw);
    expect(result.budget.reason).toBe('reported-token-limit');
    expect(await s.fabric.decide(request).catch(e => e)).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(1);
  });
});

test('unsupported images, generated opt-in and remote HTTP are rejected before effects', async () => {
  const s = await session();
  await closed(s, async () => {
    const invalid: DecisionRequest[] = [
      { ...request, provider: 'typesafe', images: [image] },
      { ...request, provider: 'vercel-decisions', images: [image] },
      { ...request, provider: 'anthropic' },
      { ...request, endpoint: 'http://example.com/v1/decisions', allowLocal: true },
      { ...request, images: [{ ...image, data: 'not base64!' }] },
    ];
    for (const req of invalid) expect(await s.fabric.decide(req).catch(e => e)).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(0);
    expect((await s.fabric.decide(request)).status).toBe('ok');
  });
});

test('gateway evaluate normalizes camel-case usage and keeps full routing metadata', async () => {
  const raw = JSON.stringify({ model: 'gateway-actual', answers: { q: { type: 'boolean', probability: 0.7 } }, usage: { inputTokens: 5, outputTokens: 0 }, providerMetadata: { gateway: { cost: '0.0001', routing: { finalProvider: 'typesafe-ai' } } } });
  const s = await session([raw]);
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, provider: 'vercel-evaluate' });
    expect(result.status).toBe('ok');
    expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 0 });
    expect(result.rawJson).toBe(raw);
    expect(s.rows()[0].url).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(s.rows()[0].body.questions.q.type).toBe('boolean');
  });
});

test('Cloudflare nested response permits absent nested model without losing wrapper', async () => {
  const raw = JSON.stringify({ success: true, result: { state: 'Completed', result: { answers: { q: { type: 'noul', noul: 0.9 } }, usage } } });
  const s = await session([raw], { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' });
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, provider: 'cloudflare-workers-ai', model: 'typesafe/jev' });
    expect(result.status).toBe('ok');
    expect(result.answers.q).toEqual({ type: 'boolean', probability: 0.9 });
    expect(result.rawJson).toBe(raw);
    expect(s.rows()[0].body.input.questions.q.type).toBe('noul');
  });
});

test('explicit credential stays request-scoped and HTTP failures never retry', async () => {
  const raw = '{"error":{"type":"rate_limit","opaque":9007199254740993}}';
  const s = await session([raw], { OPENAI_API_KEY: '', DECISION_HTTP_STATUS: '429' });
  await closed(s, async () => {
    const failed = await s.fabric.decide(request, { credential: key });
    expect(failed.status).toBe('error');
    expect(failed.httpStatus).toBe(429);
    expect(failed.rawJson).toBe(raw);
    expect(failed.budget.exhausted).toBe(true);
    expect(await s.fabric.decide(request, { credential: key }).catch(e => e)).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(1);
  });
});

test('offline preset discovery includes all implemented protocol families', async () => {
  const s = await session();
  await closed(s, async () => {
    const entries = await s.fabric.decisionProviders();
    expect(new Set(entries.map(p => p.api))).toEqual(new Set(['system-one', 'cloudflare', 'openai-decisions', 'vercel-evaluate', 'llama-cpp', 'llama-system-one', 'anthropic', 'google', '']));
    expect(entries.find(p => p.provider === 'openai')?.imageSupport).toBe('supported');
    expect(s.rows()).toHaveLength(0);
  });
});

test('Cloudflare Clef receives the documented direct inline-image schema', async () => {
  const raw = JSON.stringify({ success: true, result: { model: 'clef', answers: { q: { type: 'noul', noul: 0.8 } }, usage } });
  const s = await session([raw], { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' });
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, provider: 'cloudflare-workers-ai', model: 'clef', images: [image] });
    expect(result.status).toBe('ok');
    expect(s.rows()[0].url).toEndWith('/ai/run/@cf/cloudflare/clef');
    expect(s.rows()[0].body).toMatchObject({ model: 'clef', images: [{ content_type: 'image/png', base64: image.data }] });
    expect(s.rows()[0].body.input).toBeUndefined();
  });
});

test('TypeSafe images go as referenced assets behind its opt-in headers, with Box answers', async () => {
  const raw = JSON.stringify({ model: 'jev-1.14.0', answers: { b: { type: 'box', box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 }, q: { type: 'noul', noul: 0.8 } }, usage });
  const s = await session([raw, JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.8 } }, usage })]);
  await closed(s, async () => {
    const result = await s.fabric.decide({
      provider: 'typesafe', model: 'jev-preview', state: { photo: 'pic-1' }, images: [{ ...image, ref: 'pic-1' }],
      questions: { b: { type: 'box', instructions: 'the mug in pic-1' }, q: { type: 'noul', instructions: 'Is there a mug in pic-1?' } },
      providerOptions: { longContext: true },
    });
    expect(result.status).toBe('ok');
    expect(result.answers.b).toEqual({ type: 'box', box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 });
    const [row] = s.rows();
    expect(row.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(row.body.assets).toEqual({ 'pic-1': { type: 'image', format: 'png', data_base64: image.data } });
    expect(row.body.providerOptions).toBeUndefined();
    expect(row.headers).toContain('TypeSafe-Danger-Zone-Images: true');
    expect(row.headers).toContain('TypeSafe-Danger-Zone-Long-Context: true');
    // Text only: no opt-in.
    expect((await s.fabric.decide({ ...request, provider: 'typesafe' })).status).toBe('ok');
    expect(s.rows()[1].headers.filter((h: string) => h.startsWith('TypeSafe-'))).toEqual([]);
  });
});

test('local native System One accepts inline images without inventing remote credentials', async () => {
  const raw = JSON.stringify({ model: 'local', answers: { q: { type: 'noul', noul: 0.8 } }, usage });
  const s = await session([raw]);
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, provider: 'llama-system-one', allowLocal: true, images: [image] });
    expect(result.status).toBe('ok');
    expect(s.rows()[0].url).toBe('http://127.0.0.1:8080/v1/systemone');
    expect(s.rows()[0].body.images).toEqual(['data:image/png;base64,' + image.data]);
    expect(s.rows()[0].hasKey).toBe(false);
  });
});

test('generated image decisions remain explicitly generated with no invented distributions', async () => {
  const raw = JSON.stringify({ model: 'generated-model', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answers: { q: { type: 'boolean', probability: 0.75 } } }) }], usage });
  const s = await session([raw], { ANTHROPIC_API_KEY: key });
  await closed(s, async () => {
    const result = await s.fabric.decide({ ...request, provider: 'anthropic', allowGenerated: true, images: [image] });
    expect(result.status).toBe('ok');
    expect(result.provenance?.kind).toBe('generated');
    expect(result.answers.q).toEqual({ type: 'boolean', probability: 0.75 });
    const parts = s.rows()[0].body.messages[0].content;
    expect(parts).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } });
  });
});

test('environment-resolved OpenRouter preserves provider routing options', async () => {
  const raw = JSON.stringify({ model: 'routed', answers: { q: { type: 'noul', noul: 0.8 } }, usage });
  const s = await session([raw], { DECISION_PROVIDER: 'openrouter', OPENROUTER_API_KEY: key });
  await closed(s, async () => {
    const result = await s.fabric.decide({ state: request.state, questions, providerOptions: { allow_fallbacks: false } });
    expect(result.status).toBe('ok');
    expect(s.rows()[0].body.provider).toEqual({ allow_fallbacks: false });
    expect(s.rows()[0].url).toBe('https://openrouter.ai/api/v1/systemone');
  });
});

test('inline images larger than legacy 1 MiB reach the new API without truncation', async () => {
  const s = await session();
  await closed(s, async () => {
    const largeImage = { ...image, data: 'AAAA'.repeat(270000) };
    const result = await s.fabric.decide({ ...request, images: [largeImage] }, { timeoutMs: 60000 });
    expect(result.status).toBe('ok');
    const sent = s.rows()[0].body.input[0].content[1].image_url;
    expect(sent).toBe('data:image/png;base64,' + largeImage.data);
  });
}, 90000);

test('missing non-bearer loopback credentials do not spend the dispatch budget', async () => {
  const raw = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ answers: { q: { type: 'boolean', probability: 0.75 } } }) }], stop_reason: 'end_turn', usage });
  const s = await session([raw], { ANTHROPIC_API_KEY: '', DECISION_CREDENTIAL_COMMAND: '' }, 1);
  await closed(s, async () => {
    const local: DecisionRequest = { ...request, provider: 'anthropic', allowGenerated: true, allowLocal: true, endpoint: 'http://127.0.0.1:8080/v1/messages' };
    expect(await s.fabric.decide(local).catch(e => e)).toBeInstanceOf(FabricError);
    expect(s.rows()).toHaveLength(0);
    expect((await s.fabric.decide(local, { credential: key })).status).toBe('ok');
    expect(s.rows()).toHaveLength(1);
  });
});

test('reasoning and cache input tokens count toward the shared budget', async () => {
  const answers = JSON.stringify({ answers: { q: { type: 'boolean', probability: 0.75 } } });
  const fixtures = [
    { provider: 'google', raw: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: answers }] } }], usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 9, thoughtsTokenCount: 8, totalTokenCount: 34 } }, expected: { input_tokens: 17, output_tokens: 17 } },
    { provider: 'anthropic', raw: { content: [{ type: 'text', text: answers }], stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } }, expected: { input_tokens: 122, output_tokens: 9 } },
  ];
  for (const fixture of fixtures) {
    const raw = JSON.stringify(fixture.raw);
    const s = await session([raw], { GEMINI_API_KEY: key, ANTHROPIC_API_KEY: key }, 2, 30);
    await closed(s, async () => {
      const req: DecisionRequest = { ...request, provider: fixture.provider, allowGenerated: true };
      const result = await s.fabric.decide(req);
      expect(result.status).toBe('ok');
      expect(result.usage).toEqual(fixture.expected);
      expect(result.rawJson).toBe(raw);
      expect(result.budget).toEqual({ exhausted: true, reason: 'reported-token-limit' });
      expect(await s.fabric.decide(req).catch(e => e)).toBeInstanceOf(FabricError);
      expect(s.rows()).toHaveLength(1);
    });
  }
});

test('CLI validates and evaluates the additive request format', async () => {
  const s = await session();
  await s.fabric.close();
  const path = join(root, 'request.json');
  await Bun.write(path, JSON.stringify(request));
  const checked = await capture([nativeBin, '--', 'validate-decision', path], { env: s.env });
  expect(checked.code, checked.err).toBe(0);
  const result = await capture([nativeBin, '--', 'decide', '--timeout-ms', '30000', path], { env: s.env });
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out).status).toBe('ok');
});
