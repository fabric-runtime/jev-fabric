#!/usr/bin/env bun
// A deterministic fake curl. It never opens sockets or runs commands.
import { appendFileSync, readFileSync } from 'node:fs';
const config = await Bun.stdin.text();
const decode = (name: string) => {
  const raw = config.split('\n').find(l => l.startsWith(name + ' = '))!.slice(name.length + 3);
  return raw.startsWith('"') ? JSON.parse(raw) : raw;
};
const url = decode('url');
const path = new URL(url).pathname;
const chunks = config.split('\n').filter(line => line.startsWith('json = ')).map(line => JSON.parse(line.slice(7)));
const body = JSON.parse(chunks.length ? chunks.join('') : decode('data-binary'));
const mode = process.env.LOCAL_MOCK_MODE || 'normal';
const log = process.env.LOCAL_MOCK_LOG!;
appendFileSync(log, JSON.stringify({ path, body, argv: process.argv.slice(2), maxTime: decode('max-time') }) + '\n');
const calls = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
if (mode === 'slow') await Bun.sleep(90);
const token = (s: string) => s === 'Yes' ? 1000 : s === 'No' ? 1001 : 500 + s.charCodeAt(0);
let reply: string;
if (path === '/tokenize') {
  const content = body.content;
  if (content === '\n') reply = '{"tokens":[10]}';
  else {
    const label = content.replace(/^\n/, '');
    let ids = content.startsWith('\n') ? [10, token(label)] : [token(label)];
    if (mode === 'fallback' && content.startsWith('\n')) ids = [99, 99];
    if (mode === 'multi') ids.push(42);
    if (mode === 'collision') ids = content.startsWith('\n') ? [10, 17] : [17];
    reply = JSON.stringify({ tokens: mode === 'token-objects' ? ids.map(id => ({ id })) : ids });
  }
} else if (path === '/apply-template') {
  reply = JSON.stringify({ prompt: mode === 'think' ? '<chat>\n<think>' : '<chat>\n' });
} else if (path === '/completion') {
  const count = calls.filter(c => c.path === '/completion').length;
  if (mode === 'http-fail' || (mode === 'partial-http' && count === 2)) {
    process.stdout.write('{"error":"synthetic failure"}\n500');
    process.exit(0);
  }
  if (mode === 'malformed' || (mode === 'partial-malformed' && count === 2)) {
    process.stdout.write('{"broken":\n200');
    process.exit(0);
  }
  const start = calls.findLastIndex(c => c.path === '/tokenize' && c.body.content === '\n');
  const ids = [...new Set(calls.slice(start).filter(c => c.path === '/tokenize' && c.body.content !== '\n').map(c => token(c.body.content.replace(/^\n/, ''))))] as number[];
  if (mode === 'invalid-utf8') {
    process.stdout.write(Buffer.from([0xff, 0x0a, 0x32, 0x30, 0x30]));
    process.exit(0);
  }
  const lp = (i: number) => mode === 'best-second' ? (i === 1 ? '-1' : '-3') : mode === 'underflow' ? '-3.4028234663852886e+38' : mode === 'nonfinite' ? '1e999' : i === 0 ? '-0.12345678901234567890123456789' : '-2.12345678901234567890123456789';
  let rows = ids.map((id, i) => `{"id":${id},"logprob":${lp(i)},"token":"provider-token-${id}"}`);
  if (mode === 'missing' || (mode === 'deepen' && body.n_probs < 32768)) rows = rows.slice(0, 1);
  if (mode === 'deepen' && body.n_probs === 32768) rows = Array.from({ length: 32768 }, (_, id) => `{"id":${id},"logprob":${ids.includes(id) ? lp(ids.indexOf(id)) : '-15.12345678901234567890'}}`);
  if (mode === 'duplicate') rows.push(rows[0]);
  const usage = mode === 'no-usage' ? '' : mode === 'usage-overflow' ? ',"tokens_evaluated":281474976710655,"tokens_predicted":1' : ',"tokens_evaluated":7,"tokens_predicted":1';
  if (mode === 'partial-shape' && count === 2) reply = `{"completion_probabilities":[]${usage}}`;
  else {
    const padding = mode === 'raw-bound' ? `,"padding":"${'x'.repeat(3 * 1024 * 1024)}"` : '';
    reply = ` {"completion_probabilities":[{"top_logprobs":[${rows.join(',')}]}]${usage},"opaque":9007199254740993,"tiny":1e-1000${padding}} \n`;
  }
} else {
  throw new Error('Unexpected endpoint: ' + path);
}
process.stdout.write(reply + '\n200');
