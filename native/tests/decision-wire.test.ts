import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const binary = resolve(root, 'build/test-decision-wire-probe');

// Compile only this probe: never invoke build-native.sh during parallel work.
beforeAll(() => {
  if (process.env.JEV_NATIVE_PREBUILT === '1') return;
  mkdirSync(resolve(root, 'build'), { recursive: true });
  const p = spawnSync('bend', ['native/tests/decision-wire-probe.bend', '-o', binary], {
    cwd: root, env: { ...process.env, BEND_NO_TELEMETRY: '1' }, encoding: 'utf8', timeout: 360000,
  });
  if (p.error) throw p.error;
  expect(p.status, p.stdout + p.stderr).toBe(0);
}, 370000);

function run(mode: string, ...args: string[]) {
  const p = spawnSync(binary, ['--', mode, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 2 ** 25,
  });
  if (p.error) throw p.error;
  return { code: p.status, out: p.stdout.trim(), error: p.stderr.trim() };
}
function accepted(mode: string, ...args: string[]) {
  const p = run(mode, ...args);
  expect(p.code, p.error).toBe(0);
  return p.out;
}
function rejected(mode: string, ...args: string[]) {
  const p = run(mode, ...args);
  expect(p.code, p.out + p.error).toBe(1);
  expect(p.error).toContain('rejected:');
}
const q = (type = 'boolean', criteria?: unknown) => ({ type, instructions: 'judge 🙂', ...(criteria === undefined ? {} : { criteria }) });
const req = (questions: unknown = { q: q() }, extra: object = {}) => JSON.stringify({ state: {}, questions, ...extra });
const response = (answers: unknown, usage?: unknown, extra: object = {}) => JSON.stringify({ answers, ...(usage === undefined ? {} : { usage }), ...extra });
const boolean = (probability: unknown = 0.5) => ({ type: 'boolean', probability });
const reply = (request: string, raw: string, api = 'system-one', model = 'requested') =>
  JSON.parse(accepted('reply', request, raw, api, model));
const body = (request: string, api = 'system-one', model = 'resolved') =>
  JSON.parse(accepted('body', request, api, model));
const rejectReply = (request: string, raw: string, api = 'system-one') => rejected('reply', request, raw, api, 'requested');
const choiceReq = req({ q: q('choice', { a: null, b: { meaning: 'B🙂' } }) });
const scoreReq = req({ q: q('score', ['low', { high: true }]) });
const nativeUsage = { input_tokens: 1, output_tokens: 2 };

describe('pure Bend decision requests', () => {
  test('request, resolved and echoed model names share the Unicode scalar boundary', () => {
    const model = '😀'.repeat(256);
    expect(body(req(undefined, { model }), 'system-one', model).model).toBe(model);
    expect(reply(req(), response({ q: boolean() }, nativeUsage, { model })).model).toBe(model);
    expect(reply(req(), response({ q: boolean() }, nativeUsage), 'system-one', model).model).toBe(model);
    rejected('body', req(), 'system-one', model + '😀');
    rejectReply(req(), response({ q: boolean() }, nativeUsage, { model: model + '😀' }));
  });

  test('structured inputs and all boolean aliases remain lossless', () => {
    for (const type of ['boolean', 'bool', 'noul', 'predicate']) {
      const r = req({ '日本🙂': { ...q(type, { true: [], false: {} }), instructions: { rule: ['é', '🙂'] } } }, { state: ['é', { nested: [] }] });
      expect(JSON.parse(accepted('request', r))).toEqual(JSON.parse(r));
      expect(body(r).questions['日本🙂'].type).toBe('noul');
      expect(body(r, 'vercel-evaluate').questions['日本🙂'].type).toBe('boolean');
    }
    const raw = '{"state":{"n":9007199254740993,"e":1E+004},"questions":{"q":{"type":"boolean","instructions":"x"}}}';
    expect(accepted('body', raw, 'system-one', 'resolved')).toContain('9007199254740993');
    expect(accepted('body', raw, 'openai-decisions', 'resolved')).toContain('1E+004');
  });
  test('strict unknown fields, IDs, options and question bounds', () => {
    for (const extra of [{ extra: 1 }, { allowLocal: 'true' }, { allowGenerated: 1 }, { model: '' }, { model: 'x\n' }, { providerOptions: [] }, { providerOptions: null }, { temperature: -0.1 }, { temperature: 2.1 }, { temperature: '1' }]) rejected('request', req(undefined, extra));
    for (const questions of [{}, { '': q() }, { ['🙂'.repeat(65)]: q() }, { 'bad\n': q() }, { q: { ...q(), extra: true } }, { q: q('text') }, { q: q('choice', {}) }, { q: q('score', ['one']) }, { q: q('boolean', { true: null }) }]) rejected('request', req(questions));
    rejected('request', req({ q: q() }, { state: null }));
    rejected('request', '{"state":{},"questions":{"q":{"type":"boolean","instructions":"x"},"q":{"type":"boolean","instructions":"y"}}}');
    rejected('request', req(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), q()]))));
    accepted('request', req(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [String(i), q()]))));
    rejected('body', req(), 'unknown', 'm');
    rejected('body', req(), 'system-one', '');
  });
  test('protocol bodies strip routing and auth-adjacent fields; resolved model wins', () => {
    const r = req(undefined, { model: 'request-model', provider: 'fixture', api: 'system-one', endpoint: 'https://fixture.invalid', allowLocal: false, allowGenerated: true });
    expect(Object.keys(body(r)).sort()).toEqual(['model', 'questions', 'state']);
    expect(body(r).model).toBe('resolved');
    expect(body(r, 'cloudflare', '@cf/cloudflare/clef')).toEqual({ model: 'clef', state: {}, questions: { q: { ...q(), type: 'noul' } } });
    expect(body(req(undefined, { providerOptions: { gateway: { models: ['fallback'] } } }), 'vercel-evaluate').providerOptions).toEqual({ gateway: { models: ['fallback'] } });
    for (const api of ['system-one', 'cloudflare', 'openai-decisions']) {
      rejected('body', req(undefined, { providerOptions: { arbitrary: 1 } }), api, 'm');
      rejected('body', req(undefined, { temperature: 1 }), api, 'm');
    }
  });
  test('OpenAI ordered named questions preserve structured descriptions', () => {
    // Primary schema: github.com/openai/openai-node/blob/master/src/resources/decisions.ts
    const got = body(req({ c: q('choice', { a: null, b: { meaning: 7 } }), s: q('score', ['low', ['high']]), n: { type: 'noul', instructions: ['test'], criteria: { true: { good: true } } } }), 'openai-decisions');
    expect(got.questions.map((x: any) => [x.name, x.type])).toEqual([['c', 'choice'], ['s', 'score'], ['n', 'predicate']]);
    expect(got.questions[0].choices).toEqual([{ value: 'a' }, { value: 'b', description: '{"meaning":7}' }]);
    expect(got.questions[1].levels).toEqual([{ label: '0', description: 'low' }, { label: '1', description: '["high"]' }]);
    expect(JSON.parse(got.questions[2].instructions)).toEqual({ instructions: ['test'], criteria: { true: { good: true } } });
  });
  test('OpenAI uses inline data URLs, never downloads or external URLs', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      const image = { type: 'image', data: 'AA==', mimeType };
      const got = body(req(undefined, { state: ['🙂'], images: [image] }), 'openai-decisions');
      expect(got.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: '["🙂"]' }, { type: 'input_image', image_url: `data:${mimeType};base64,AA==` }] }]);
    }
    const r = req(undefined, { images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    for (const api of ['system-one', 'vercel-evaluate']) rejected('body', r, api, 'm');
    for (const image of [{ data: '', mimeType: 'image/png' }, { data: 'https://x.invalid/x.png', mimeType: 'image/png' }, { data: 'AA==', mimeType: 'image/svg+xml' }, { data: 'AB==', mimeType: 'image/png' }, { data: 'AAA', mimeType: 'image/png' }, { data: 'AA==\n', mimeType: 'image/png' }, { data: 'AA==', mimeType: 'image/png', url: 'https://x.invalid' }, { data: 'AA==', mimeType: 'image/png', type: 'file' }]) rejected('request', req(undefined, { images: [image] }));
    rejected('request', req(undefined, { images: Array(129).fill({ data: 'AA==', mimeType: 'image/png' }) }));
  });
  test('llama native System One images and generic Cloudflare wrapper are explicit', () => {
    const image = { data: 'AA==', mimeType: 'image/jpeg' };
    const got = body(req(undefined, { images: [image] }), 'llama-system-one');
    expect(got.images).toEqual(['data:image/jpeg;base64,AA==']);
    expect(got.questions.q.type).toBe('noul');
    const raw = response({ q: { type: 'noul', noul: 0.7 } }, nativeUsage);
    expect(reply(req(), raw, 'llama-system-one').answers.q).toEqual(boolean(0.7));
    expect(accepted('raw_usage', raw, 'llama-system-one')).toBe('[1,2]');
    const wrapped = body(req(), 'cloudflare', 'typesafe/jev');
    expect(wrapped).toEqual({ model: 'typesafe/jev', input: { state: {}, questions: { q: { ...q(), type: 'noul' } } } });
    rejected('body', req(undefined, { images: [image] }), 'cloudflare', 'typesafe/jev');
  });
  test('TypeSafe takes images as referenced assets, Box questions and long context', () => {
    // https://docs.typesafe.ai/go/images and https://docs.typesafe.ai/go/box
    const image = { ref: 'pic-1', data: 'AA==', mimeType: 'image/png' };
    const box = { type: 'box', instructions: 'the mug in pic-1' };
    const r = (extra: object = {}, questions: unknown = { q: q() }) => req(questions, { provider: 'typesafe', state: { photo: 'pic-1' }, ...extra });
    expect(body(r({ images: [image, { ...image, ref: 'pic 2 🙂', mimeType: 'image/jpeg' }] }), 'system-one', 'jev-preview')).toEqual({
      state: { photo: 'pic-1' }, questions: { q: { ...q(), type: 'noul' } }, model: 'jev-preview',
      assets: { 'pic-1': { type: 'image', format: 'png', data_base64: 'AA==' }, 'pic 2 🙂': { type: 'image', format: 'jpg', data_base64: 'AA==' } },
    });
    expect(body(r(), 'system-one', 'jev-latest').assets).toBeUndefined();
    expect(body(r({ images: [] }), 'system-one', 'jev-latest').assets).toBeUndefined();
    expect(body(r({ images: [image] }, { b: box, q: q() }), 'system-one', 'jev-preview').questions.b).toEqual(box);
    expect(body(r({ providerOptions: { longContext: true } }), 'system-one', 'jev-latest').providerOptions).toBeUndefined();
    body(r({ providerOptions: { longContext: false } }), 'system-one', 'jev-latest');
    for (const extra of [{ images: [{ ...image, ref: undefined }] }, { images: [image, image] }, { images: [{ ...image, mimeType: 'image/webp' }] },
      { images: [{ ...image, mimeType: 'image/gif' }] }, { images: Array.from({ length: 65 }, (_, i) => ({ ...image, ref: String(i).padEnd(1024, 'x') })) },
      { providerOptions: { longContext: 1 } }, { providerOptions: { other: true } }]) rejected('body', r(extra), 'system-one', 'jev-latest');
    for (const ref of ['', ' \n\t', 'x'.repeat(1025), 7]) rejected('request', req(undefined, { images: [{ ...image, ref }] }));
    accepted('request', req(undefined, { images: [{ ...image, ref: '🙂'.repeat(256) }] }));
    rejected('body', r({}, { b: box }), 'system-one', 'jev-preview');
    rejected('request', req({ b: { ...box, criteria: {} } }));
    for (const provider of ['subq', 'openrouter', 'opencode']) rejected('body', req({ b: box }, { provider, images: [image] }), 'system-one', 'm');
    for (const api of ['openai-decisions', 'vercel-evaluate', 'cloudflare', 'llama-system-one']) rejected('body', req({ b: box }, { provider: 'typesafe', images: [image] }), api, 'm');
    // Other adapters attach images whole and ignore the ref.
    expect(body(req(undefined, { provider: 'subq', images: [image] }), 'system-one', 'subq-snap-preview').images).toEqual([{ mediaType: 'image/png', base64: 'AA==' }]);
  });

  test('TypeSafe opt-in headers follow the request, and only on TypeSafe', () => {
    const image = { ref: 'pic-1', data: 'AA==', mimeType: 'image/png' };
    const headers = (request: object, provider = 'typesafe', api = 'system-one') => JSON.parse(accepted('headers', JSON.stringify({ state: 'pic-1', questions: { q: q() }, ...request }), provider, api));
    expect(headers({})).toEqual([]);
    expect(headers({ images: [] })).toEqual([]);
    expect(headers({ images: [image] })).toEqual(['TypeSafe-Danger-Zone-Images: true']);
    expect(headers({ providerOptions: { longContext: true } })).toEqual(['TypeSafe-Danger-Zone-Long-Context: true']);
    expect(headers({ providerOptions: { longContext: false } })).toEqual([]);
    expect(headers({ images: [image], providerOptions: { longContext: true } })).toEqual(['TypeSafe-Danger-Zone-Images: true', 'TypeSafe-Danger-Zone-Long-Context: true']);
    expect(headers({ images: [image] }, 'subq')).toEqual([]);
    expect(headers({ images: [image] }, 'typesafe', 'vercel-evaluate')).toEqual([]);
  });

  test('Box answers keep their edge lexemes and must be a real box', () => {
    const image = { ref: 'pic-1', data: 'AA==', mimeType: 'image/png' };
    const r = req({ b: { type: 'box', instructions: 'the mug in pic-1' } }, { provider: 'typesafe', images: [image] });
    const edges = { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 };
    expect(reply(r, response({ b: { type: 'box', box: edges, confidence: 0.92 } }, nativeUsage)).answers.b).toEqual({ type: 'box', box: edges, confidence: 0.92 });
    expect(accepted('reply', r, '{"answers":{"b":{"type":"box","box":{"left":0,"right":1.0,"top":0E0,"bottom":1}}}}', 'system-one', 'm')).toContain('"box":{"top":0E0,"bottom":1,"left":0,"right":1.0}');
    for (const box of [{ ...edges, top: 0.9 }, { ...edges, right: 0.44 }, { ...edges, bottom: 1.01 }, { ...edges, left: -0.1 }, { ...edges, extra: 0 }, { top: 0.1, bottom: 0.2, left: 0.3 }, [0, 1, 0, 1], { ...edges, top: '0.1' }])
      rejectReply(r, response({ b: { type: 'box', box } }));
    rejectReply(r, response({ b: { type: 'box', box: edges, confidence: 1.5 } }));
    rejectReply(r, response({ b: { type: 'choice', choice: 'a' } }));
    expect(reply(r, response({ b: { type: 'refusal', reason: 'no' } })).answers.b.type).toBe('refusal');
  });

  test('SubQ SystemOne takes inline images; the other SystemOne routes take none', () => {
    // https://docs.subq.ai/endpoints/decisions-api/#images
    const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
    const r = (extra: object = {}) => req(undefined, { provider: 'subq', ...extra });
    const got = body(r({ images: [image] }), 'system-one', 'subq-snap-preview');
    expect(got).toEqual({ state: {}, questions: { q: { ...q(), type: 'noul' } }, model: 'subq-snap-preview', images: [{ mediaType: 'image/png', base64: 'AA==' }] });
    expect(body(r(), 'system-one', 'subq-snap-preview').images).toBeUndefined();
    body(r({ images: Array(4).fill(image) }), 'system-one', 'subq-snap-preview');
    rejected('body', r({ images: Array(5).fill(image) }), 'system-one', 'subq-snap-preview');
    rejected('body', r({ images: [{ ...image, mimeType: 'image/gif' }] }), 'system-one', 'subq-snap-preview');
    rejected('body', r({ providerOptions: {} }), 'system-one', 'subq-snap-preview');
    for (const provider of [undefined, 'typesafe', 'openrouter', 'opencode']) {
      // TypeSafe takes images only with a ref (see above).
      rejected('body', req(undefined, { ...(provider ? { provider } : {}), images: [image] }), 'system-one', 'jev-latest');
    }
    rejected('body', r({ images: [image] }), 'vercel-evaluate', 'typesafe-ai/jev');
  });
  test('Cloudflare follows the flat Clef image schema and tighter question limits', () => {
    // https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json
    const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
    const r = req(undefined, { images: [image] });
    const got = body(r, 'cloudflare', '@cf/cloudflare/clef');
    expect(got.model).toBe('clef');
    expect(got.input).toBeUndefined();
    expect(got.images).toEqual([{ content_type: 'image/png', base64: 'AA==' }]);
    expect(body(r, 'cloudflare', '@cf/cloudflare/clef-flash').model).toBe('clef-flash');
    rejected('body', r, 'cloudflare', 'unverified');
    rejected('body', req(undefined, { images: [{ ...image, mimeType: 'image/gif' }] }), 'cloudflare', 'clef');
    rejected('body', req(undefined, { images: Array(5).fill(image) }), 'cloudflare', 'clef');
    body(req(undefined, { images: Array(4).fill(image) }), 'cloudflare', 'clef');
    for (const questions of [{ '日本': q() }, { ['x'.repeat(101)]: q() }, { q: q('choice', { a: null }) }, { q: { ...q(), instructions: '' } }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, q()]))]) rejected('body', req(questions), 'cloudflare', 'clef');
    for (const [value, bytes] of [['AA==', '1'], ['AAA=', '2'], ['AAAA', '3'], ['AAAAAA==', '4']]) expect(accepted('base64-size', value!)).toBe(bytes!);
    const opts = { order: ['provider-a'], allow_fallbacks: false };
    expect(body(req(undefined, { provider: 'openrouter', providerOptions: opts })).provider).toEqual(opts);
    for (const provider of ['vercel', 'vercel-evaluate']) expect(body(req(undefined, { provider, providerOptions: opts })).providerOptions).toEqual(opts);
    expect(body(req(undefined, { provider: 'vercel-decisions', providerOptions: opts }), 'openai-decisions').providerOptions).toEqual(opts);
    expect(body(req(undefined, { providerOptions: { safety_identifier: 'user-🙂' } }), 'openai-decisions').safety_identifier).toBe('user-🙂');
    rejected('body', req(undefined, { providerOptions: { safety_identifier: false } }), 'openai-decisions', 'm');
    rejected('body', req(undefined, { providerOptions: { safety_identifier: 'x'.repeat(65) } }), 'openai-decisions', 'm');
    rejected('body', req(undefined, { provider: 'typesafe', providerOptions: opts }), 'system-one', 'm');
  });
  test('Cloudflare enforces decoded image byte caps exactly', () => {
    expect(accepted('cloudflare-size', '1398101', 'AA==', '2')).toBe('accepted');
    rejected('cloudflare-size', '1398102', '', '1');
    rejected('cloudflare-size', '1048576', '', '3');
  }, 180000);
  test('decision byte cap is larger than legacy cap, but remains bounded', () => {
    expect(accepted('size', '1048576')).toBe('accepted');
    rejected('size', '16777216');
    rejected('reply-size', '9000000');
  }, 120000);
});

describe('lossless decision replies', () => {
  test('canonical boolean aliases and original metadata, numbers, whitespace', () => {
    for (const type of ['boolean', 'bool', 'predicate', 'noul']) {
      const key = type === 'noul' ? 'noul' : 'probability';
      const raw = ` { "model":"actual", "answers":{"q":{"type":"${type}","${key}":0.123456789012345678901}},"usage":{"input_tokens":16777217.000,"output_tokens":2E+0},"metadata":{"big":9007199254740993,"tiny":1e-1000,"unicode":"🙂"} } `;
      const encoded = accepted('reply', req(), raw, 'system-one', 'requested');
      const got = JSON.parse(encoded);
      expect(got.answers.q.type).toBe('boolean');
      expect(got.model).toBe('actual');
      expect(got.rawJson).toBe(raw);
      expect(got.provenance).toEqual({ kind: 'native' });
      expect(got.provider).toBe('fixture');
      expect(encoded).toContain('"probability":0.123456789012345678901');
      expect(encoded).toContain('"big":9007199254740993');
      expect(encoded).toContain('"input_tokens":16777217.000');
    }
  });
  test('optional distributions, confidence and usage are not fabricated', () => {
    const c = reply(choiceReq, response({ q: { type: 'choice', choice: 'a' } }));
    expect(c.answers.q).toEqual({ type: 'choice', choice: 'a' });
    expect(c.usage).toEqual({ input_tokens: null, output_tokens: null });
    const s = reply(scoreReq, response({ q: { type: 'score', score: 0.75 } }));
    expect(s.answers.q).toEqual({ type: 'score', score: 0.75, legend: { '0': 'low', '1': { high: true } } });
    const p = reply(req(), response({ q: boolean() }, { input_tokens: 2 }));
    expect(p.usage).toEqual({ input_tokens: 2, output_tokens: null });
  });
  test('OpenAI maps shuffled distribution values, not positions or score labels', () => {
    const c = reply(choiceReq, response([{ name: 'q', type: 'choice', choice: 'b', confidence: 0.8, probabilities: [{ value: 'b', probability: 0.7 }, { value: 'a', probability: 0.3 }] }], nativeUsage), 'openai-decisions');
    expect(c.answers.q).toEqual({ type: 'choice', choice: 'b', confidence: 0.8, probabilities: { a: 0.3, b: 0.7 } });
    const raw = '{"answers":[{"name":"q","type":"score","score":0.9,"probabilities":[{"value":1.0,"label":"not an index","probability":0.90000000000000000001},{"value":0e0,"label":"also not","probability":0.09999999999999999999}]}]}';
    const encoded = accepted('reply', scoreReq, raw, 'openai-decisions', 'requested');
    expect(encoded).toContain('"probabilities":{"0":0.09999999999999999999,"1":0.90000000000000000001}');
    expect(JSON.parse(encoded).answers.q.legend).toEqual({ '0': 'low', '1': { high: true } });
  });
  test('question refusals preserve valid siblings and refusal metadata', () => {
    const r = req({ n: q(), c: q('choice', { a: null }) });
    const raw = response([{ name: 'c', type: 'refusal', detail: { why: 'safety🙂' } }, { name: 'n', type: 'predicate', probability: 0.7 }]);
    const got = reply(r, raw, 'openai-decisions');
    expect(got.answers.n).toEqual({ type: 'boolean', probability: 0.7 });
    expect(got.answers.c).toEqual({ name: 'c', type: 'refusal', detail: { why: 'safety🙂' } });
    expect(got.raw.answers).toHaveLength(2);
  });
  test('Cloudflare direct and Completed envelopes preserve full raw', () => {
    const inner = { answers: { q: { type: 'noul', noul: 0.2 } }, usage: nativeUsage };
    for (const result of [inner, { state: 'Completed', result: inner }]) {
      const raw = JSON.stringify({ success: true, result, errors: [], messages: ['extra'] });
      const got = reply(req(), raw, 'cloudflare');
      expect(got.model).toBe('requested');
      expect(got.answers.q).toEqual(boolean(0.2));
      expect(got.raw).toEqual(JSON.parse(raw));
      expect(accepted('raw_usage', raw, 'cloudflare')).toBe('[1,2]');
    }
    expect(reply(req(), JSON.stringify({ success: true, result: { ...inner, model: 'returned' } }), 'cloudflare').model).toBe('returned');
    rejectReply(req(), JSON.stringify({ success: false, result: inner }), 'cloudflare');
    rejectReply(req(), JSON.stringify({ success: true, result: { state: 'Running', result: inner } }), 'cloudflare');
  });
  test('Vercel evaluate camelcase usage and optional answer confidence', () => {
    const raw = response({ q: { ...boolean(0.8), confidence: 0.9 } }, { inputTokens: 11, outputTokens: 12 }, { warnings: [{ message: 'retained' }], model: 'fallback' });
    const got = reply(req(), raw, 'vercel-evaluate');
    expect(got.usage).toEqual({ input_tokens: 11, output_tokens: 12 });
    expect(got.model).toBe('fallback');
    expect(got.raw.warnings).toEqual([{ message: 'retained' }]);
    expect(accepted('raw_usage', raw, 'vercel-evaluate')).toBe('[11,12]');
  });
  test('available probability range checks use exact decimal arithmetic', () => {
    for (const p of ['-1e-1000', '1.000000000000000000001', 'null', 'true', '"0.5"', '1e999']) rejectReply(req(), `{"answers":{"q":{"type":"boolean","probability":${p}}}}`);
    for (const p of ['0', '-0', '1e-1000', '0.99999999999999999999', '1']) expect(accepted('reply', req(), `{"answers":{"q":{"type":"boolean","probability":${p}}}}`, 'system-one', 'm')).toContain(`"probability":${p}`);
    rejectReply(choiceReq, response({ q: { type: 'choice', choice: 'a', confidence: 1.01 } }));
    rejectReply(scoreReq, response({ q: { type: 'score', score: 1.01 } }));
    rejectReply(scoreReq, response({ q: { type: 'score', score: -0.1 } }));
  });
  test('coverage, sums, duplicates, missing IDs and selected values are checked', () => {
    for (const probabilities of [{ a: 1 }, { a: 0.5, c: 0.5 }, { a: 0.1, b: 0.1 }, { a: 0.6, b: 0.6 }, { a: -0.1, b: 1.1 }, { a: '0.5', b: 0.5 }]) rejectReply(choiceReq, response({ q: { type: 'choice', choice: 'a', probabilities } }));
    for (const probabilities of [{ a: 0.48, b: 0.5 }, { a: 0.52, b: 0.5 }]) reply(choiceReq, response({ q: { type: 'choice', choice: 'a', probabilities } }));
    rejectReply(choiceReq, '{"answers":{"q":{"type":"choice","choice":"a","probabilities":{"a":0.479999999999999999999,"b":0.5}}}}');
    rejectReply(choiceReq, response({ q: { type: 'choice', choice: 'unknown' } }));
    rejectReply(req(), response({ other: boolean() }));
    rejectReply(req(), response({ q: boolean(), extra: boolean() }));
    rejectReply(req(), response({ q: { type: 'score', score: 0 } }));
    rejectReply(req(), response([{ name: 'q', type: 'predicate', probability: 0.5 }, { name: 'q', type: 'predicate', probability: 0.5 }]), 'openai-decisions');
    rejectReply(choiceReq, response([{ name: 'q', type: 'choice', choice: 'a', probabilities: [{ value: 'a', probability: 0.5 }, { value: 'a', probability: 0.5 }] }]), 'openai-decisions');
    rejectReply(req(), '{"answers":{"q":{"type":"boolean","probability":0.5,"probability":0.5}}}');
  });
});

describe('usage is accounted independently of answers', () => {
  test('bounded exact integers; absence and null are unknown, never invented zero', () => {
    for (const input of ['0', '-0', '16777217.000', '167772170e-1', '281474976710655']) {
      const raw = `{"usage":{"input_tokens":${input},"output_tokens":2}}`;
      expect(accepted('raw_usage', raw, 'system-one')).toBe(`[${Number(input)},2]`);
      expect(accepted('reported_usage', raw)).toBe(`[${Number(input)},2]`);
    }
    for (const raw of ['{}', '{"usage":null}', '{"usage":{}}', '{"usage":{"input_tokens":0}}', '{"usage":{"input_tokens":null,"output_tokens":2}}']) {
      expect(accepted('raw_usage', raw, 'system-one')).toBe('null');
      expect(accepted('reported_usage', raw)).toBe('null');
    }
    for (const input of ['-1', '1.000000000000000001', '281474976710656', 'true', '"1"']) {
      const raw = `{"usage":{"input_tokens":${input}}}`;
      rejected('raw_usage', raw, 'system-one');
      rejected('reported_usage', raw);
    }
    for (const usage of ['[]', '4', 'false']) rejected('raw_usage', `{"usage":${usage}}`, 'system-one');
  });
  test('malformed answers and refusals do not hide provider billing', () => {
    const raw = response({ q: boolean(17) }, nativeUsage);
    rejectReply(req(), raw);
    expect(accepted('raw_usage', raw, 'system-one')).toBe('[1,2]');
    expect(accepted('raw_usage', '{"answers":17,"usage":{"inputTokens":7,"outputTokens":8}}', 'vercel-evaluate')).toBe('[7,8]');
    expect(accepted('raw_usage', '{"content":[{"type":"text","text":"not JSON"}],"usage":{"input_tokens":3,"output_tokens":4}}', 'anthropic')).toBe('[3,4]');
    expect(accepted('raw_usage', '{"candidates":[],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":6}}', 'google')).toBe('[5,6]');
  });
});

describe('generated protocol delegation', () => {
  test('projection removes routing, resolved model wins, supported options retained', () => {
    const r = req(undefined, { model: 'request-model', provider: 'fixture', api: 'anthropic', endpoint: 'https://fixture.invalid', allowGenerated: true, allowLocal: false, providerOptions: { max_tokens: 128 } });
    const got = body(r, 'anthropic', 'resolved');
    expect(got.model).toBe('resolved');
    expect(got.max_tokens).toBe(128);
    for (const name of ['provider', 'api', 'endpoint', 'allowGenerated', 'allowLocal']) expect(got[name]).toBeUndefined();
    const google = body(req(undefined, { temperature: 0.7, providerOptions: { maxOutputTokens: 128 } }), 'google');
    expect(google.generationConfig.temperature).toBe(0.7);
    expect(google.generationConfig.maxOutputTokens).toBe(128);
    rejected('body', req(undefined, { providerOptions: { headers: {} } }), 'anthropic', 'm');
    rejected('body', req(undefined, { temperature: 0.7 }), 'anthropic', 'm');
  });
  test('generated response provenance, raw, actual model and global refusal', () => {
    const raw = JSON.stringify({ model: 'actual', content: [{ type: 'text', text: response({ q: boolean(0.75) }) }], stop_reason: 'end_turn', usage: nativeUsage });
    const got = reply(req(), raw, 'anthropic');
    expect(got.model).toBe('actual');
    expect(got.provenance).toEqual({ kind: 'generated' });
    expect(got.answers.q).toEqual(boolean(0.75));
    expect(got.rawJson).toBe(raw);
    const r = req({ n: q(), c: q('choice', { a: null }) });
    const refusal = reply(r, JSON.stringify({ model: 'actual', stop_reason: 'refusal', content: [], usage: nativeUsage }), 'anthropic');
    expect(refusal.answers.n.type).toBe('refusal');
    expect(refusal.answers.c.type).toBe('refusal');
    expect(refusal.usage).toEqual(nativeUsage);
  });
});
