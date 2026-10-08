import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Fabric, FabricError, type DecisionTarget, type DecisionProfiles,
  type DecisionResolution, type DecisionEvidence, type DecisionTargetView,
} from '../../clients/typescript/jev-fabric.ts';

// The built worker may not have decision-targets yet. This peer verifies framing,
// shared sessions and budgets only; it never makes provider calls or builds native code.
const root = mkdtempSync(join(tmpdir(), 'decision-target-clients-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const binary = join(root, 'peer');
const setup = Bun.spawnSync(['python3', '-c',
  'import runpy,sys; d=runpy.run_path(sys.argv[1]); open(sys.argv[2], "w").write("#!"+sys.executable+"\\n"+d["FAKE_DECISION_PEER"])',
  resolve('clients/python/test_jev_fabric.py'), binary,
], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (setup.exitCode !== 0) throw new Error(setup.stderr.toString());
chmodSync(binary, 0o700);
const evidence: DecisionEvidence = { state: { evidence: 'offline' }, questions: { ok: { type: 'boolean', instructions: 'Is this offline?' } } };
const fakeTarget: DecisionResolution['target'] = {
  provider: 'fixture', api: 'system-one', model: 'fixture', endpoint: 'https://fixture.invalid',
  allowLocal: false, allowGenerated: false,
};
const fullTarget: DecisionResolution['target'] = {
  ...fakeTarget, model: 'initial', endpoint: 'http://127.0.0.1:1234/decisions',
  allowLocal: true, allowGenerated: true, temperature: 0.5,
  providerOptions: { gateway: { models: ['initial'] } },
};
const open = (options: Parameters<typeof Fabric.open>[0] = {}) => Fabric.open({ binary, ...options });
// Diagnostic fields belong only to the fake peer, not the public resolution contract.
const probe = (value: unknown): any => value;

test('python target/profile protocol tests (no native build or paid calls)', async () => {
  const p = Bun.spawn(['python3', 'clients/python/test_jev_fabric.py', 'DecisionTargetTest', '-v'], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(code, out + err).toBe(0);
  expect(err).toContain('Ran 10 tests');
}, 30000);

test('resolveDecision sends exactly {request} and returns public resolution, without spending budget', async () => {
  const f = await open({ maxEvaluations: 0 });
  try {
    const request = { ...evidence, profile: 'work' };
    const r: DecisionResolution = await f.resolveDecision(request);
    expect(probe(r).wire).toEqual({ id: 1, op: 'resolveDecision', request });
    expect(r.credential).toEqual({ env: 'FIXTURE_API_KEY', resolved: false });
    expect(r.profile).toBe('work');
    expect(probe(await f.validateDecision(request)).wire.request).toEqual(request);
    await expect(f.decide(request)).rejects.toThrow('shared budget exhausted');
  } finally { await f.close(); }
});

test('immutable bound targets share the exact parent session, IDs, deadline and budget', async () => {
  const f = await open({ timeoutMs: 60000, maxEvaluations: 2, maxTokens: 50 });
  const target: DecisionTarget = { provider: 'fixture', providerOptions: { gateway: { models: ['original'] } } };
  const view: DecisionTargetView = f.withDecisionTarget(target);
  const profile = f.withDecisionTarget('team.v1');
  try {
    probe(target.providerOptions).gateway.models[0] = 'mutated';
    target.provider = 'mutated';
    expect(Object.isFrozen(view)).toBe(true);
    const snapshot = probe(view.target);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.providerOptions.gateway.models)).toBe(true);
    expect(() => { snapshot.providerOptions.gateway.models[0] = 'mutated'; }).toThrow();
    expect(() => { probe(view).target = 'mutated'; }).toThrow();
    expect(view.target).not.toBe(view.target);
    expect(probe(view).close).toBeUndefined();
    expect(probe(view).open).toBeUndefined();
    expect(profile.target).toBe('team.v1');
    const resolved = probe(await view.resolveDecision(evidence));
    const [one, two] = await Promise.all([
      view.decide(evidence, { timeoutMs: 321, credential: 'one-shot-sentinel' }),
      profile.decide(evidence),
    ]).then(rs => rs.map(probe));
    expect(one.wire).toEqual({ id: 2, op: 'decide', request: { ...evidence, provider: 'fixture', providerOptions: { gateway: { models: ['original'] } } }, timeoutMs: 321, credential: 'one-shot-sentinel' });
    expect(two.wire).toEqual({ id: 4, op: 'decide', request: { ...evidence, ...fakeTarget } });
    expect([resolved.pid, two.pid]).toEqual([one.pid, one.pid]);
    expect(two.remaining).toBe(0);
    expect(JSON.stringify(view.target)).not.toContain('one-shot-sentinel');
    await expect(f.jev(evidence)).rejects.toThrow('shared budget exhausted');
    expect(probe(await view.resolveDecision(evidence)).pid).toBe(one.pid);
    expect(probe(await f.capabilities()).pid).toBe(one.pid);
  } finally { await f.close(); }
  await expect(view.decide(evidence)).rejects.toBeInstanceOf(FabricError);
});

test('named resolution binds lazily, snapshots all routing, and never retains evidence or call options', async () => {
  const path = join(root, 'profiles.json');
  const save = (target: DecisionTarget) => Bun.write(path, JSON.stringify({ version: 1, profiles: { vision: target } }));
  await save(fullTarget);
  const f = await open({ env: { DECISION_PROFILES_FILE: path }, maxEvaluations: 2 });
  try {
    const view = f.withDecisionTarget('vision');
    expect(probe(await f.capabilities()).counts).toEqual({ profileResolves: 0, resolves: 0, dispatches: 0 });
    const first = await view.resolveDecision(evidence);
    expect(first.target).toEqual(fullTarget);
    expect(first.profile).toBe('vision');
    probe(first.target.providerOptions).gateway.models[0] = 'caller-mutated';
    first.target.model = 'caller-mutated';
    await save({ ...fakeTarget, provider: 'changed', model: 'changed' });
    const nextEvidence = { ...evidence, state: 'fresh-evidence', images: [{ data: 'fixture-image', mimeType: 'image/png' as const }] };
    const second = probe(await view.resolveDecision(nextEvidence));
    expect(second.wire.request).toEqual({ ...nextEvidence, ...fullTarget });
    expect(second.target).toEqual(fullTarget);
    const one = probe(await view.decide(nextEvidence, { timeoutMs: 321, credential: 'ephemeral-secret' }));
    const two = probe(await view.decide(evidence));
    expect(one.wire).toMatchObject({ request: { ...nextEvidence, ...fullTarget }, timeoutMs: 321, credential: 'ephemeral-secret' });
    expect(two.wire.request).toEqual({ ...evidence, ...fullTarget });
    expect(two.wire).not.toHaveProperty('credential');
    expect(two.wire).not.toHaveProperty('timeoutMs');
    expect(view.target).toBe('vision');
    const c = probe(await f.capabilities());
    expect(c.counts).toEqual({ profileResolves: 1, resolves: 2, dispatches: 2 });
    expect(c.preflight.request).toEqual({ ...evidence, profile: 'vision' });
    expect(c.preflight).not.toHaveProperty('credential');
    expect([one.pid, two.pid, second.pid]).toEqual([c.pid, c.pid, c.pid]);
    expect(c.remaining).toBe(0);
    await expect(f.jev(evidence)).rejects.toThrow('shared budget exhausted');
  } finally { await f.close(); }
});

test('concurrent named first use shares one in-flight binding and the parent budget', async () => {
  const f = await open({ env: { ROTATE_PROFILE: '1' }, maxEvaluations: 4 });
  try {
    const view = f.withDecisionTarget('vision');
    const inputs = Array.from({ length: 4 }, (_, i) => ({ ...evidence, state: `evidence-${i}` }));
    const results = (await Promise.all(inputs.map(input => view.decide(input)))).map(probe);
    results.forEach((result, i) => expect(result.wire.request).toEqual({ ...inputs[i], ...fakeTarget, model: 'revision-1' }));
    const c = probe(await f.capabilities());
    expect(c.counts).toEqual({ profileResolves: 1, resolves: 1, dispatches: 4 });
    expect(c.preflight.request).toEqual({ ...inputs[0], profile: 'vision' });
    expect(results.every(result => result.pid === c.pid)).toBe(true);
    expect(c.remaining).toBe(0);
    await expect(view.decide(evidence)).rejects.toThrow('shared budget exhausted');
  } finally { await f.close(); }
});

test('failed evidence or malformed resolved targets leave named views retryable without dispatch', async () => {
  const invalidTargets = [null, { provider: 'fixture' }, { ...fakeTarget, api: '' },
    { ...fakeTarget, api: 'unknown' }, { ...fakeTarget, allowLocal: 1 },
    { ...fakeTarget, providerOptions: { nested: { api_key: 'DO_NOT_CACHE' } } },
    { ...fakeTarget, endpoint: 'https://user:DO_NOT_CACHE@fixture.invalid' }];
  for (const bad of ['evidence', ...invalidTargets]) {
    const f = await open({ env: { ROTATE_PROFILE: '1', ...(bad === 'evidence' ? {} : { BAD_TARGET_ONCE: JSON.stringify(bad) }) }, maxEvaluations: 1 });
    try {
      const view = f.withDecisionTarget('vision');
      await expect(view.decide(bad === 'evidence' ? { ...evidence, questions: {} } : evidence, { credential: 'not-for-preflight' })).rejects.toThrow();
      const before = probe(await f.capabilities());
      expect(before.counts).toEqual({ profileResolves: 1, resolves: 1, dispatches: 0 });
      expect(before.remaining).toBe(1);
      expect(before.preflight).not.toHaveProperty('credential');
      const success = probe(await view.decide(evidence));
      expect(success.wire.request).toEqual({ ...evidence, ...fakeTarget, model: 'revision-2' });
      expect(success.wire).not.toHaveProperty('credential');
      expect(probe(await f.capabilities()).counts).toEqual({ profileResolves: 2, resolves: 2, dispatches: 1 });
    } finally { await f.close(); }
  }
});

test('failed model dispatch never rebinds a successfully resolved named view', async () => {
  for (const failure of ['throw', 'status']) {
    const f = await open({ env: { ROTATE_PROFILE: '1', FAIL_DISPATCH_ONCE: failure }, maxEvaluations: 2 });
    try {
      const view = f.withDecisionTarget('vision');
      const first = view.decide(evidence, { credential: 'failed-call-only' });
      if (failure === 'throw') await expect(first).rejects.toThrow('model dispatch failed');
      else expect((await first).status).toBe('error');
      const second = probe(await view.decide({ ...evidence, state: 'retry' }));
      expect(second.wire.request).toEqual({ ...evidence, state: 'retry', ...fakeTarget, model: 'revision-1' });
      expect(second.wire).not.toHaveProperty('credential');
      expect(second.remaining).toBe(0);
      expect(probe(await f.capabilities()).counts).toEqual({ profileResolves: 1, resolves: 1, dispatches: 2 });
    } finally { await f.close(); }
  }
});

test('bound views reject every routing field and extra evidence before writing', async () => {
  const f = await open();
  try {
    const view = f.withDecisionTarget('work');
    for (const key of ['profile', 'provider', 'api', 'model', 'endpoint', 'allowLocal', 'allowGenerated', 'providerOptions', 'temperature', 'credential', 'extra']) {
      const bad = { ...evidence, [key]: undefined };
      await expect(view.decide(bad)).rejects.toThrow();
      await expect(view.resolveDecision(bad)).rejects.toThrow();
      await expect(view.resolveDecision({ ...evidence, [key]: null })).rejects.toThrow();
    }
    expect(probe(await f.resolveDecision(evidence)).wire.id).toBe(1);
  } finally { await f.close(); }
});

test('startup profiles snapshot JSON in env, override JSON but preserve file and replacement semantics', async () => {
  const doc: DecisionProfiles = { version: 1, defaultProfile: 'work', profiles: { work: { provider: 'fixture' } } };
  const env = { ONLY_CHILD: 'yes', DECISION_PROFILES: 'overridden', DECISION_PROFILES_FILE: 'untouched' };
  const before = process.env.ENV_SENTINEL;
  process.env.ENV_SENTINEL = 'ambient';
  try {
    const opening = open({ decisionProfiles: doc, env, maxEvaluations: 0 });
    doc.profiles.work.provider = 'mutated';
    const f = await opening;
    try {
      const c = probe(await f.capabilities());
      expect(JSON.parse(c.env.DECISION_PROFILES).profiles.work.provider).toBe('fixture');
      expect(c.env).toMatchObject({ ENV_SENTINEL: null, ONLY_CHILD: 'yes', DECISION_PROFILES_FILE: 'untouched' });
      expect(c.argv.join(' ')).not.toContain('DECISION_PROFILES');
      expect(env.DECISION_PROFILES).toBe('overridden');
    } finally { await f.close(); }
    for (const [options, sentinel] of [[{ env: { ONLY_CHILD: 'yes' } }, null], [{}, 'ambient'], [{ decisionProfiles: doc }, 'ambient']] as const) {
      const f = await open(options);
      try { expect(probe(await f.capabilities()).env.ENV_SENTINEL).toBe(sentinel); }
      finally { await f.close(); }
    }
    const f2 = await open({ env: { DECISION_PROFILES: 'existing' } });
    try { expect(probe(await f2.capabilities()).env.DECISION_PROFILES).toBe('existing'); }
    finally { await f2.close(); }
  } finally {
    if (before === undefined) delete process.env.ENV_SENTINEL;
    else process.env.ENV_SENTINEL = before;
  }
});

test('strict targets/profiles reject lossy or secret config before spawn, accept safe name/count limits', async () => {
  const badTargets: any[] = [null, {}, { provider: '' }, { provider: 'x', allowLocal: 1 },
    { provider: 'x', temperature: NaN }, { provider: 'x', temperature: true },
    { provider: 'x', providerOptions: [] }, { provider: 'x', providerOptions: { n: Infinity } },
    { provider: 'x', providerOptions: { nested: { api_key: 'DO_NOT_ECHO' } } },
    { provider: 'x', endpoint: 'https://user:DO_NOT_ECHO@fixture.invalid' },
    { provider: 'x', endpoint: 'https://fixture.invalid?token=DO_NOT_ECHO' },
    ...['extra', 'state', 'questions', 'images', 'credential', 'profile'].map(k => ({ provider: 'x', [k]: 'DO_NOT_ECHO' })),
    { provider: 'x', model: undefined }, { provider: 'x', providerOptions: { x: BigInt(1) } },
    { provider: 'x', providerOptions: { x: new Date() } },
    { provider: 'x', providerOptions: { x: new Array(2) } },
    { provider: 'x', get model() { throw new Error('getter must not run'); } },
    { provider: 'x', toJSON() { return { provider: 'bypass' }; } },
  ];
  const badDocs: any[] = [{}, { version: true, profiles: {} }, { version: 2, profiles: {} },
    { version: 1, profiles: {}, extra: 1 }, { version: 1, profiles: [] },
    { version: 1, profiles: {}, defaultProfile: 'missing' },
    { version: 1, profiles: {}, defaultProfile: 'toString' },
    ...['__proto__', 'prototype', 'constructor'].map(defaultProfile => ({ version: 1, profiles: {}, defaultProfile })),
    { version: 1, profiles: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i, { provider: 'x' }])) },
    { version: 1, profiles: { x: { provider: 'x', model: 'é'.repeat(40000) } } },
    ...['', 'a/b', 'é', 'x\n', 'x'.repeat(129), '__proto__', 'prototype', 'constructor'].map(name => ({ version: 1, profiles: { [name]: { provider: 'x' } } })),
    ...badTargets.map(target => ({ version: 1, profiles: { x: target } })),
  ];
  for (const decisionProfiles of badDocs) {
    const error = await Fabric.open({ binary: '/nonexistent/no-spawn', decisionProfiles }).catch(e => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toContain('DO_NOT_ECHO');
  }
  const f = await open();
  try {
    for (const target of [...badTargets, '', 'é', 'x'.repeat(129)]) expect(() => f.withDecisionTarget(target)).toThrow(TypeError);
    for (const name of ['__proto__', 'prototype', 'constructor']) {
      expect(() => f.withDecisionTarget(name)).toThrow(TypeError);
      await expect(f.decide({ ...evidence, profile: name })).rejects.toThrow(TypeError);
      await expect(f.validateDecision({ ...evidence, profile: name })).rejects.toThrow(TypeError);
      await expect(f.resolveDecision({ ...evidence, profile: name })).rejects.toThrow(TypeError);
    }
    await expect(f.resolveDecision(Object.assign(Object.create({ profile: 'work' }), evidence))).rejects.toThrow(TypeError);
    const cyclic: any = { provider: 'x', providerOptions: {} };
    cyclic.providerOptions.loop = cyclic;
    expect(() => f.withDecisionTarget(cyclic)).toThrow(TypeError);
  } finally { await f.close(); }
  const profiles = Object.fromEntries(Array.from({ length: 126 }, (_, i) => [i, { provider: 'x' }]));
  profiles.secret = { provider: 'x' };
  profiles['x'.repeat(128)] = { provider: 'x' };
  const good = await open({ decisionProfiles: { version: 1, profiles } });
  await good.close();
  const boundary: DecisionProfiles = { version: 1, profiles: { x: { provider: 'x', providerOptions: { padding: '' } } } };
  boundary.profiles.x!.providerOptions!.padding = 'm'.repeat(65536 - Buffer.byteLength(JSON.stringify(boundary)));
  const exact = await open({ decisionProfiles: boundary });
  await exact.close();
  boundary.profiles.x!.providerOptions!.padding += 'm';
  await expect(Fabric.open({ binary: '/nonexistent/no-spawn', decisionProfiles: boundary })).rejects.toThrow(TypeError);
});

test('portable structural constraints agree across TypeScript and Python before spawn or dispatch', async () => {
  const bad = [
    { api: 'not-an-api' }, { api: null }, { model: 'm'.repeat(257) }, { model: '😀'.repeat(257) },
    { temperature: -0.01 }, { temperature: 2.01 },
    ...['https://example.com/?safe=1', 'https://example.com/?', 'https://example.com/#',
      'https://user@example.com/', 'https://@example.com/', String.raw`https://example.com/\path`,
      'http://example.com/', 'ftp://example.com/', 'http://localhost/', 'http://127.1/',
      'http://2130706433/', 'http://127.0.0.1.evil/', 'https://example.com/café', 'https://example.com:0/', 'https://example.com:65536/'].map(endpoint => ({ endpoint })),
  ].map(fields => ({ provider: 'typesafe', ...fields }));
  const good = [
    ...['system-one', 'cloudflare', 'openai-decisions', 'vercel-evaluate', 'llama-cpp', 'llama-system-one', 'anthropic', 'google'].map(api => ({ api })),
    { model: 'm'.repeat(256) }, { model: '😀'.repeat(256) }, { temperature: 0 }, { temperature: 2 },
    { providerOptions: { futureOption: { values: [null, true, 1, 'safe'] } } },
    ...['https://example.com/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1'].map(endpoint => ({ endpoint, allowLocal: false })),
  ].map(fields => ({ provider: 'typesafe', ...fields }));
  const doc = (target: any): DecisionProfiles => ({ version: 1, defaultProfile: 'ok', profiles: { ok: { provider: 'typesafe' }, unused: target } });
  for (const target of bad) await expect(Fabric.open({ binary: '/nonexistent/no-spawn', decisionProfiles: doc(target) })).rejects.toThrow(TypeError);
  const f = await open({ maxEvaluations: 0 });
  try {
    for (const target of bad) expect(() => f.withDecisionTarget(target as any)).toThrow(TypeError);
    for (const target of good) {
      expect(f.withDecisionTarget(target as DecisionTarget).target).toEqual(target);
      const peer = await open({ decisionProfiles: doc(target) }); await peer.close();
    }
    expect(probe(await f.capabilities()).counts).toEqual({ profileResolves: 0, resolves: 0, dispatches: 0 });
  } finally { await f.close(); }
  const python = Bun.spawnSync(['python3', '-c', `
import json, sys
from unittest.mock import patch
sys.path.insert(0, 'clients/python')
from jev_fabric import Fabric, _serialize_profiles, _validate_target
bad, good = json.loads(sys.argv[1])
def doc(target):
    return dict(version=1, defaultProfile='ok', profiles=dict(ok=dict(provider='typesafe'), unused=target))
with patch('subprocess.Popen', side_effect=AssertionError('must not spawn')):
    for target in bad:
        for action in (lambda: Fabric(binary='/nonexistent/no-spawn', decision_profiles=doc(target)), lambda: _validate_target(target)):
            try: action()
            except ValueError: pass
            else: raise AssertionError('invalid target accepted: ' + repr(target))
for target in good:
    assert _validate_target(target) == target
    assert json.loads(_serialize_profiles(doc(target))) == doc(target)
for options in ({'x': (1, 2)}, {1: 'coerced'}, {'x': float('nan')}, {'x': object()}):
    try: _validate_target(dict(provider='typesafe', providerOptions=options))
    except ValueError: pass
    else: raise AssertionError('lossy options accepted')
boundary = doc(dict(provider='typesafe', providerOptions=dict(padding='')))
options = boundary['profiles']['unused']['providerOptions']
options['padding'] = 'm' * (65536 - len(json.dumps(boundary, separators=(',', ':')).encode()))
assert len(_serialize_profiles(boundary).encode()) == 65536
options['padding'] += 'm'
try: _serialize_profiles(boundary)
except ValueError: pass
else: raise AssertionError('oversized document accepted')
print('portable cross-client checks passed')
`, JSON.stringify([bad, good])], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  expect(python.exitCode, python.stderr.toString()).toBe(0);
  expect(python.stdout.toString()).toContain('portable cross-client checks passed');
});

test('older decisions workers retain simple calls; only new usage demands decision-targets', async () => {
  const f = await open({ env: { OLD_PEER: '1' }, maxEvaluations: 2 });
  try {
    await f.decide({ ...evidence, provider: 'openai' });
    await f.validateDecision(evidence);
    await expect(f.resolveDecision(evidence)).rejects.toThrow(/decision-targets.*update/);
    expect(() => f.withDecisionTarget('work')).toThrow(/decision-targets.*update/);
    expect(() => f.withDecisionTarget({ provider: 'openai' })).toThrow(/decision-targets.*update/);
    await expect(f.decide({ ...evidence, profile: 'work' })).rejects.toThrow(/decision-targets.*update/);
    await expect(f.validateDecision({ ...evidence, profile: 'work' })).rejects.toThrow(/decision-targets.*update/);
    expect(probe(await f.capabilities()).wire.id).toBe(3);
  } finally { await f.close(); }
  await expect(open({ env: { OLD_PEER: '1' }, decisionProfiles: { version: 1, profiles: {} } })).rejects.toThrow(/decision-targets.*update/);
});
