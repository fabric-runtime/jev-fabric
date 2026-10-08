import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'decision-local-'));
const bin = process.env.JEV_NATIVE_PREBUILT === '1' ? resolve('build/test-decision-local') : join(root, 'probe');
const fake = join(root, 'bin');
let sequence = 0;
beforeAll(() => {
  mkdirSync(fake);
  // Invoke the checked-in fake with the current Bun, never a live curl.
  writeFileSync(join(fake, 'curl'), `#!${process.execPath}\n` + readFileSync('native/tests/decision-local-curl.ts', 'utf8').replace(/^#![^\n]*\n/, ''), { mode: 0o700 });
  if (process.env.JEV_NATIVE_PREBUILT === '1') return;
  const build = Bun.spawnSync(['bend', 'native/tests/decision-local.bend', '-o', bin], { stdout: 'pipe', stderr: 'pipe', timeout: 120000 });
  expect(build.exitCode, build.stdout.toString() + build.stderr.toString()).toBe(0);
}, 125000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const binary = (type = 'noul') => ({ type, instructions: { test: ['a structured instruction', { exact: 'keep strings' }] }, criteria: { true: 'supported', false: 'unsupported' } });
const request = (questions: any = { q: binary() }, extra: any = {}) => ({ state: { note: 'not executable; "\\\n $(touch /nope)' }, questions, allowLocal: true, api: 'llama-cpp', ...extra });
async function run(req: any = request(), mode = 'normal', timeout = 60000) {
  const log = join(root, `log-${++sequence}`);
  writeFileSync(log, '');
  const child = Bun.spawn([bin, '--', 'eval', typeof req === 'string' ? req : JSON.stringify(req), String(timeout)], {
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, LOCAL_MOCK_LOG: log, LOCAL_MOCK_MODE: mode }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  return { value: JSON.parse(out), out, calls };
}
function preflight(req: any) {
  const p = Bun.spawnSync([bin, '--', 'preflight', typeof req === 'string' ? req : JSON.stringify(req)]);
  expect(p.exitCode, p.stderr.toString()).toBe(0);
  return p.stdout.toString().trim();
}
function math(t: string, logs: string) {
  return Bun.spawnSync([bin, '--', 'math', t, logs]);
}

test('all binary aliases use Yes/No, normalized boolean, derived provenance, and exact raw readouts', async () => {
  for (const alias of ['noul', 'bool', 'boolean', 'predicate']) {
    const { value, out, calls } = await run(request({ q: binary(alias) }));
    expect(value.status).toBe('ok');
    expect(value.api).toBe('llama-cpp');
    expect(value.provider).toBe('local-test');
    expect(value.model).toBe('mock-model');
    expect(value.answers.q.type).toBe('boolean');
    expect(value.answers.q.probability).toBeCloseTo(1 / (1 + Math.exp(-2)), 14);
    expect(value.provenance).toMatchObject({ kind: 'token-logprobs', nativeProbabilities: false });
    expect(value.answers.q.provenance).toMatchObject({ kind: 'token-logprobs', method: 'label-softmax', nativeProbabilities: false });
    expect(value.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
    expect(calls.map(c => c.path)).toEqual(['/tokenize', '/tokenize', '/tokenize', '/apply-template', '/completion']);
    expect(calls.slice(0, 3).map(c => c.body.content)).toEqual(['\n', '\nYes', '\nNo']);
    expect(calls.every(c => c.body.model === 'mock-model')).toBe(true);
    expect(calls.at(-1).body).toMatchObject({ n_predict: 1, n_probs: 256, temperature: 0, post_sampling_probs: false });
    expect(value.raw.length).toBe(5);
    expect(value.rawComplete).toBe(true);
    expect(value.answers.q.provenance.labels.map((l: any) => l.token_id)).toEqual([1000, 1001]);
    expect(value.raw.at(-1).text).toContain('"opaque":9007199254740993');
    expect(value.rawJson).toContain('"opaque":9007199254740993');
    expect(value.rawJson).toContain('-0.12345678901234567890123456789');
    expect(value.rawJson).toContain('"tiny":1e-1000');
    expect(out).toContain('"opaque":9007199254740993');
    expect(JSON.parse(value.rawJson)).toEqual(value.raw);
    const content = calls.find(c => c.path === '/apply-template').body.messages[1].content;
    expect(content).toContain(JSON.stringify(binary(alias).instructions));
  }
}, 30000);

test('choice and score statistics and labels are complete', async () => {
  const questions = {
    choice: { type: 'choice', instructions: 'pick', criteria: { a: 'first', b: { second: [1, 2] }, c: null } },
    score: { type: 'score', instructions: ['rank'], criteria: ['low', { meaning: ['medium', { rank: 1 }] }, 'high'] },
  };
  const { value } = await run(request(questions));
  expect(value.status).toBe('ok');
  expect(value.answers.choice.choice).toBe('a');
  expect(Object.keys(value.answers.choice.probabilities)).toEqual(['a', 'b', 'c']);
  const probabilities = Object.values(value.answers.choice.probabilities) as number[];
  expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
  expect(value.answers.score.score).toBeCloseTo(probabilities[1] + 2 * probabilities[2], 14);
  expect(value.answers.score.probabilities).toEqual({ '0': probabilities[0], '1': probabilities[1], '2': probabilities[2] });
  expect(value.answers.score.legend).toEqual({ '0': 'low', '1': { meaning: ['medium', { rank: 1 }] }, '2': 'high' });
  expect(value.usage).toEqual({ input_tokens: 14, output_tokens: 2 });
}, 15000);

test('structured instruction numeric lexemes reach the chat template losslessly', async () => {
  const text = JSON.stringify(request()).replace('"keep strings"', '9007199254740993').replace('"a structured instruction"', '1e-1000');
  const { value, calls } = await run(text);
  expect(value.status).toBe('ok');
  const content = calls.find(c => c.path === '/apply-template').body.messages[1].content;
  expect(content).toContain('"exact":9007199254740993');
  expect(content).toContain('"test":[1e-1000,');
});

test('ten score levels use every single digit label', async () => {
  const { value, calls } = await run(request({ q: { type: 'score', instructions: 'rank', criteria: Array.from({ length: 10 }, (_, i) => `level ${i}`) } }));
  expect(value.status).toBe('ok');
  expect(Array.isArray(value.answers.q.probabilities)).toBe(false);
  expect(Object.keys(value.answers.q.probabilities)).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
  expect(value.answers.q.legend).toEqual(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i), `level ${i}`])));
  expect(calls.filter(c => c.path === '/tokenize').slice(1).map(c => c.body.content.slice(1)).join('')).toBe('0123456789');
  expect(value.answers.q.score).toBeGreaterThanOrEqual(0);
  expect(value.answers.q.score).toBeLessThanOrEqual(9);
});

test('all questions validated before even tokenization', async () => {
  const invalid = { type: 'choice', instructions: 'bad', criteria: { one: 'only' } };
  const { value, calls } = await run(request({ valid: binary(), invalid }));
  expect(value.dispatchError).toContain('2..62');
  expect(calls).toEqual([]);
  for (const n of [1, 63]) {
    expect(preflight(request({ q: { type: 'choice', instructions: 'pick', criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => ['k' + i, 'desc'])) } }))).toStartWith('error:');
  }
  for (const n of [1, 11]) expect(preflight(request({ q: { type: 'score', instructions: 'rank', criteria: Array(n).fill('level') } }))).toStartWith('error:');
});

test('62 choices use unique A..Z a..z 0..9 and depth992', async () => {
  const { value, calls } = await run(request({ q: { type: 'choice', instructions: 'pick', criteria: Object.fromEntries(Array.from({ length: 62 }, (_, i) => ['k' + i, 'desc'])) } }));
  expect(value.status).toBe('ok');
  expect(calls.filter(c => c.path === '/tokenize').slice(1).map(c => c.body.content.slice(1)).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  expect(calls.at(-1).body.n_probs).toBe(992);
}, 30000);

test('images and opt-in are rejected predispatch', async () => {
  for (const extra of [{ images: ['file.png'] }, { images: null }, { allowLocal: false }, { api: 'typesafe' }]) {
    const { value, calls } = await run(request(undefined, extra));
    expect(value.dispatchError).toBeString();
    expect(calls.length).toBe(0);
  }
});

test('pure temperature preflight checks finite-double boundaries with exact decimals', () => {
  for (const lex of ['1', '0.1', '5e-324', '1.7976931348623157e308', '1e-300']) {
    const req = JSON.stringify(request()).slice(0, -1) + `,"temperature":${lex}}`;
    expect(preflight(req), lex).toBe('ok');
  }
  for (const lex of ['0', '-0', '-1', '1e-1000', '1e309', '1.7976931348623159e308', '2e-324']) {
    const req = JSON.stringify(request()).slice(0, -1) + `,"temperature":${lex}}`;
    expect(preflight(req), lex).toStartWith('error:');
  }
});

test('temperature scales only derived statistics; tiny temperatures stay stable', async () => {
  const { value, calls } = await run(request(undefined, { temperature: 2 }));
  expect(value.answers.q.probability).toBeCloseTo(1 / (1 + Math.exp(-1)), 14);
  expect(calls.at(-1).body.temperature).toBe(0);
  const tiny = math('5e-324', '-1000\n-1001');
  expect(tiny.exitCode, tiny.stderr.toString()).toBe(0);
  expect(JSON.parse(tiny.stdout.toString()).probabilities).toEqual([1, 0]);
  const tie = math('1', '-10\n-10');
  expect(JSON.parse(tie.stdout.toString())).toMatchObject({ probabilities: [0.5, 0.5], best: 0, confidence: 0 });
  for (const pair of [['NaN', '-1\n-2'], ['1', 'NaN\n-1'], ['1', '0.1\n-1'], ['1', '1e-1000\n-1'], ['1', '-1e31\n-1e32']]) expect(math(pair[0], pair[1]).exitCode).not.toBe(0);
});

test('single-token fallback and token object shapes work; think blocks close', async () => {
  for (const mode of ['fallback', 'token-objects', 'think']) {
    const { value, calls } = await run(request(), mode);
    expect(value.status, value.error?.message).toBe('ok');
    if (mode === 'think') expect(calls.at(-1).body.prompt).toEndWith('<think></think>');
    if (mode === 'fallback') expect(calls.filter(c => c.path === '/tokenize').length).toBe(5);
  }
}, 20000);

test('multi-token/colliding labels fail without completion and preserve tokenizer raw', async () => {
  for (const mode of ['multi', 'collision']) {
    const { value, calls } = await run(request(), mode);
    expect(value.status).toBe('error');
    expect(value.raw.length).toBeGreaterThan(0);
    expect(value.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(calls.some(c => c.path === '/completion')).toBe(false);
  }
});

test('deepen to full32768 readout retains all attempts, precise raw and billed usage', async () => {
  const { value, calls } = await run(request(), 'deepen');
  expect(value.status, value.error?.message).toBe('ok');
  expect(calls.filter(c => c.path === '/completion').map(c => c.body.n_probs)).toEqual([256, 4096, 32768]);
  expect(value.raw.at(-1).body.completion_probabilities[0].top_logprobs.length).toBe(32768);
  expect(value.rawJson).toContain('-15.12345678901234567890');
  expect(value.usage).toEqual({ input_tokens: 21, output_tokens: 3 });
}, 120000);

test('missing, duplicate, nonfinite and all-underflow logs return retained error envelopes', async () => {
  for (const mode of ['missing', 'duplicate', 'nonfinite', 'underflow']) {
    const { value, calls } = await run(request(), mode);
    expect(value.status, mode).toBe('error');
    expect(value.raw.at(-1).path).toBe('/completion');
    expect(value.usage.input_tokens).toBe(mode === 'missing' ? 21 : 7);
    expect(calls.filter(c => c.path === '/completion').length).toBe(mode === 'missing' ? 3 : 1);
  }
}, 20000);

test('unknown usage stays null; partial failures retain readouts and never retry HTTP', async () => {
  expect((await run(request(), 'no-usage')).value.usage).toEqual({ input_tokens: null, output_tokens: null });
  for (const mode of ['partial-http', 'partial-malformed']) {
    const { value, calls } = await run(request({ a: binary(), b: binary() }), mode);
    expect(value.status).toBe('error');
    expect(value.raw.some((r: any) => r.path === '/completion' && r.body?.tokens_evaluated === 7)).toBe(true);
    expect(value.rawJson).toContain('9007199254740993');
    expect(value.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(calls.filter(c => c.path === '/completion').length).toBe(2);
    if (mode === 'partial-malformed') expect(value.raw.at(-1).text).toBe('{"broken":');
    if (mode === 'partial-http') {
      expect(value.raw.at(-1).httpStatus).toBe(500);
      expect(value.raw.at(-1).body).toEqual({ error: 'synthetic failure' });
    }
  }
}, 20000);

test('a nonzero winning index maps to the correct key', async () => {
  const { value } = await run(request({ q: { type: 'choice', instructions: 'pick', criteria: { first: 'A', second: 'B', third: 'C' } } }), 'best-second');
  expect(value.status).toBe('ok');
  expect(value.answers.q.choice).toBe('second');
});

test('completed inference failure preserves captured aggregate usage', async () => {
  const { value, calls } = await run(request({ a: binary(), b: binary() }), 'partial-shape');
  expect(value.status).toBe('error');
  expect(value.usage).toEqual({ input_tokens: 14, output_tokens: 2 });
  expect(value.raw.filter((r: any) => r.path === '/completion').length).toBe(2);
  expect(calls.filter(c => c.path === '/completion').length).toBe(2);
});

test('usage aggregation overflow is unknown, never wraps or invents a count', async () => {
  const { value } = await run(request({ a: binary(), b: binary() }), 'usage-overflow');
  expect(value.status).toBe('ok');
  expect(value.usage).toEqual({ input_tokens: null, output_tokens: 2 });
});

test('invalid UTF-8 is retained byte-exactly as base64 in error envelope', async () => {
  const { value } = await run(request(), 'invalid-utf8');
  expect(value.status).toBe('error');
  expect(value.raw.at(-1).body).toEqual({ encoding: 'base64', data: '/w==' });
  expect(value.usage).toEqual({ input_tokens: null, output_tokens: null });
});

test('aggregate raw byte cap stops explicitly without silently truncating or dropping prior captures', async () => {
  const { value, out, calls } = await run(request(), 'raw-bound');
  expect(value.status).toBe('error');
  expect(value.rawComplete).toBe(false);
  expect(value.error.message).toContain('raw retention byte/work limit');
  expect(value.raw.map((r: any) => r.path)).toEqual(['/tokenize', '/tokenize', '/tokenize', '/apply-template']);
  expect(value.usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  expect(Buffer.byteLength(out)).toBeLessThan(16 * 1024 * 1024);
  expect(calls.filter(c => c.path === '/completion').length).toBe(1);
}, 120000);

test('one deadline covers all calls instead of refreshing per request', async () => {
  const start = performance.now();
  const { value, calls } = await run(request(), 'slow', 230);
  expect(value.status).toBe('error');
  expect(calls.length).toBeLessThan(5);
  expect(performance.now() - start).toBeLessThan(1500);
  expect(value.raw.length).toBeGreaterThan(0);
}, 5000);
