// `run` end to end: the examples/native/*.ts programs and the library they
// import, run through runMain from source (src/run/run.test-main.ts, which is
// what src/main.ts does for `run`), through that stand-in compiled with
// `bun build --compile` (BUN_BE_BUN and the embedded library), and through
// the shipped binary (JEV_FABRIC_BIN or build/jev-fabric) when built. No
// network: Jev goes through the documented exec transport to a fake curl, and
// the Wikipedia fetch of the wikirace example is answered by the same fake.

import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import {show} from '../proc/report.ts'

const repo = resolve(import.meta.dir, '../..')
mkdirSync(join(repo, '.tmp'), {recursive: true})
const root = mkdtempSync(join(repo, '.tmp', 'run-test-'))
const fakeBin = join(root, 'bin')
const bun = process.execPath
const jq = Bun.which('jq')
let serial = 0

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// The exec transport's curl, and Wikipedia's: a Jev answer picks FAKE_CHOICE
// (else the first criterion) for each choice question and 0.9 for each Noul.
const curl = `
const args = process.argv.slice(2)
if (args.includes('https://en.wikipedia.org/w/api.php')) {
  const page = args.find((a) => a.startsWith('page='))!.slice(5)
  const links = (JSON.parse(process.env.FAKE_WIKI ?? '{}')[page] ?? []).map((title: string) => ({ns: 0, exists: true, title}))
  process.stdout.write(JSON.stringify({parse: {title: page, links}}))
  process.exit(0)
}
const config = await Bun.stdin.text()
const line = config.split('\\n').find((l) => l.startsWith('data-binary = '))!
const request = JSON.parse(JSON.parse(line.slice('data-binary = '.length)))
const answers: Record<string, unknown> = {}
for (const [name, q] of Object.entries<any>(request.questions)) {
  if (q.type === 'noul') answers[name] = {type: 'noul', noul: 0.9}
  else {
    const keys = Object.keys(q.criteria)
    const choice = keys.includes(process.env.FAKE_CHOICE ?? '') ? process.env.FAKE_CHOICE! : keys[0]!
    const rest = keys.length > 1 ? 0.1 / (keys.length - 1) : 0
    answers[name] = {type: 'choice', choice, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? (keys.length > 1 ? 0.9 : 1) : rest]))}
  }
}
process.stdout.write(JSON.stringify({model: 'jev-test', answers, usage: {input_tokens: 4, output_tokens: 2}}) + '\\n200')
`

// A bridge for doom.ts and browse.ts: one request, then `done` with what came back.
const bridge = `
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\\n')
const browse = process.env.FAKE_BRIDGE === 'browse'
const question = {type: 'choice', instructions: 'What next?', criteria: browse ? {click: null, type: null} : {forward: null, turn: null}}
out(browse
  ? {step: 1, log: 'page loaded', request: {state: 'a page', questions: {operation: question}}}
  : {tick: 1, request: {state: 'a corridor', questions: {action: question}}})
let text = ''
for await (const chunk of Bun.stdin.stream()) {
  text += new TextDecoder().decode(chunk)
  if (text.includes('\\n')) break
}
const reply = text.slice(0, text.indexOf('\\n'))
out({done: browse ? {operation: JSON.parse(reply).answers.operation.choice} : {action: reply}})
`

beforeAll(() => {
  mkdirSync(fakeBin)
  writeFileSync(join(root, 'curl.ts'), curl)
  writeFileSync(join(root, 'bridge.ts'), bridge)
  script(join(fakeBin, 'curl'), `exec '${bun}' '${join(root, 'curl.ts')}' "$@"`)
})

afterAll(() => rmSync(root, {recursive: true, force: true}))

type Ran = {code: number; out: string; err: string; receipt: Record<string, any> | null}

/** A fresh storage home and an environment built from scratch (no provider keys). */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: [fakeBin, '/usr/bin', '/bin', ...(jq ? [dirname(jq)] : [])].join(':'),
    HOME: process.env.HOME ?? '/',
    JEV_FABRIC_HOME: join(root, `home-${serial++}`),
    JEV_FABRIC_HTTP: 'exec',
    TYPESAFE_API_KEY: 'SYNTHETIC_KEY_FOR_RUN_TESTS',
    ...extra,
  }
}

async function launch(cli: string[], args: string[], extra: Record<string, string> = {}, stdin = ''): Promise<Ran> {
  const p = Bun.spawn([...cli, '--', 'run', ...args], {cwd: repo, env: env(extra), stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe'})
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  let receipt = null
  try {
    receipt = JSON.parse(out)
  } catch {}
  return {code, out, err, receipt}
}

const receiptOf = (stdout: string, stderr = '', code = 0) => ({
  schemaVersion: 1,
  state: code === 0 ? 'exited' : 'failed',
  exitCode: code,
  timedOut: false,
  cancelled: false,
  stdout,
  stderr,
  truncated: {stdout: false, stderr: false},
})
// What exec prints inside the program: every control character escaped as \u00XX.
const shown = (stdout: string) => show({code: 0, timedOut: false, cancelled: false, stdoutCut: false, stderrCut: false, stdout, stderr: ''})

function program(name: string, text: string): string {
  const path = join(root, name)
  writeFileSync(path, text)
  return path
}

const ms = /\d+ms/g

// The same behaviour from source and from each binary.
function suite(name: string, cli: () => string[]) {
  describe.concurrent(name, () => {
    const run = (args: string[], extra?: Record<string, string>, stdin?: string) => launch(cli(), args, extra, stdin)

    test('pipeline.ts: one receipt, wrapped in the run receipt', async () => {
      const r = await run(['examples/native/pipeline.ts'])
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      expect(r.receipt).toEqual(receiptOf(shown('HELLO JEV-FABRIC\n') + '\n'))
    })

    test('scoped.ts: two concurrent calls on one budget', async () => {
      const r = await run(['--timeout-ms', '20000', 'examples/native/scoped.ts'])
      expect(r.receipt).toEqual(receiptOf(shown('first\n') + '\n' + shown('second\n') + '\n'))
    })

    test('persistent.ts: one child keeps state across three requests', async () => {
      const r = await run(['examples/native/persistent.ts'])
      const lines = '{"count":1,"value":10}\n{"count":2,"value":20}\n{"count":3,"value":30}\n'
      expect(r.receipt).toEqual(receiptOf(shown(lines) + '\n'))
    })

    test('judge.ts: one Jev evaluation through the exec transport', async () => {
      const r = await run(['examples/native/judge.ts'])
      expect(r.err).toBe('')
      expect(JSON.parse(r.receipt!.stdout)).toEqual({model: 'jev-test', answers: {healthy: {type: 'noul', noul: 0.9}}, usage: {input_tokens: 4, output_tokens: 2}})
    })

    test('judge.ts without a key fails inside the program, never dispatching', async () => {
      const r = await run(['examples/native/judge.ts'], {TYPESAFE_API_KEY: ''})
      expect(r.code).toBe(1)
      expect(r.err).toBe('native program did not complete successfully\n')
      expect(r.receipt!.state).toBe('failed')
      expect(r.receipt!.stderr).toContain('FabricError')
    })

    test('doom.ts: a decision per bridge request, the action written back', async () => {
      const r = await run(['examples/native/doom.ts'], {DOOM_PYTHON: bun, DOOM_BRIDGE: join(root, 'bridge.ts'), FAKE_CHOICE: 'turn'})
      const text = r.receipt!.stdout.replace(ms, 'Nms').replace(/(mean|max)_ms=\d+/g, '$1_ms=N')
      expect(text).toBe('tick 1 -> turn confidence=0.9 Nms\ndone {"action":"turn"}\njev decisions=1 mean_ms=N max_ms=N\nbridge exited\n')
    })

    test('browse.ts: the whole validated evaluation goes back to the bridge', async () => {
      const r = await run(['examples/native/browse.ts'], {BROWSE_NODE: bun, BROWSE_BRIDGE: join(root, 'bridge.ts'), FAKE_BRIDGE: 'browse', FAKE_CHOICE: 'type'})
      const text = r.receipt!.stdout.replace(ms, 'Nms').replace(/(mean|max)_ms=\d+/g, '$1_ms=N')
      expect(text).toBe('  "page loaded"\nstep 1 -> type confidence=0.9 Nms\ndone {"operation":"type"}\njev decisions=1 mean_ms=N max_ms=N\nbridge exited\n')
    })

    test.skipIf(!jq)('wikirace.ts: a capture per article and a Jev choice per step', async () => {
      const wiki = JSON.stringify({Start: ['Beta', 'Alpha'], Beta: ['Goal', 'Start'], Alpha: []})
      const r = await run(['examples/native/wikirace.ts', 'Start', 'Goal'], {FAKE_WIKI: wiki, FAKE_CHOICE: 'Beta'})
      expect(r.err).toBe('')
      expect(r.receipt!.stdout.replace(ms, 'Nms')).toBe(
        'race: Start -> Goal\n  Start: 2 unvisited links\n    jev: "Beta" of 2 (confidence 0.9, Nms)\nreached in 2 clicks, Nms\nStart -> Beta -> Goal\n',
      )
      const usage = await run(['examples/native/wikirace.ts'])
      expect([usage.code, usage.receipt!.stderr]).toEqual([2, 'usage: wikirace -- <start article> <target article>\n'])
    })

    test('arguments reach the program verbatim; stdin is inherited', async () => {
      const path = program(`args-${serial++}.ts`, 'console.log(JSON.stringify(process.argv.slice(2)), await Bun.stdin.text())')
      const r = await run(['--timeout-ms', '20000', '--', path, '--timeout-ms', '1', '--', '-x', ''], {}, 'piped')
      expect(r.receipt!.stdout).toBe('["--timeout-ms","1","--","-x",""] piped\n')
    })

    test('the program sees a clean environment and the library as `jev-fabric`', async () => {
      const path = program(
        `env-${serial++}.ts`,
        `import * as lib from 'jev-fabric'
const child = await lib.exec(['/usr/bin/env'])
console.log(JSON.stringify([process.env.BUN_BE_BUN ?? null, child.stdout.includes('BUN_BE_BUN'), typeof lib.Job, typeof lib.Codec.read, import.meta.main]))`,
      )
      const r = await run([path])
      expect(r.receipt!.stdout).toBe('[null,false,"function","function",true]\n')
    })

    test('durable jobs from a program: start re-enters the CLI as the worker', async () => {
      const path = program(
        `jobs-${serial++}.ts`,
        `import {Job} from 'jev-fabric'
const batch = await Job.start(['/bin/sh', '-c', 'echo out; echo err >&2'], {label: 'from-a-program'})
const done = await batch.wait({timeoutMs: 20000})
const read = await batch.read('stdout')
const events = await batch.events()
const followed = []
for await (const record of batch.follow({timeoutMs: 5000})) followed.push(record.type)
const pipe = await Job.start(['/bin/cat'], {input: 'pipe'})
const written = await pipe.write('hello\\n')
await pipe.closeInput()
const echoed = await pipe.read('stdout', {waitMs: 10000})
const final = await pipe.wait({timeoutMs: 20000})
const listed = await Job.list()
let refused = null
try { await new Job('0'.repeat(32)).status() } catch (e) { refused = [e.name, e.code] }
console.log(JSON.stringify({
  state: done.state, label: done.label, stdout: done.stdout, stderr: done.stderr,
  read: read.text, events: events.map((e) => e.type), followed: followed.at(-1),
  written: written.written, echoed: echoed.text, final: final.state, listed: listed.jobs.length, refused,
}))`,
      )
      const r = await run(['--timeout-ms', '60000', path])
      expect(r.err).toBe('')
      expect(JSON.parse(r.receipt!.stdout)).toEqual({
        state: 'exited',
        label: 'from-a-program',
        stdout: 'out\n',
        stderr: 'err\n',
        read: 'out\n',
        events: expect.arrayContaining(['job.started', 'job.finished']),
        followed: 'follow.end',
        written: 6,
        echoed: 'hello\n',
        final: 'exited',
        listed: 2,
        refused: ['FabricError', expect.any(Number)],
      })
    })

    test('the deadline ends the program and its children (124)', async () => {
      const path = program(`slow-${serial++}.ts`, "import {exec} from 'jev-fabric'\nconsole.log('started')\nawait exec(['/bin/sleep', '30'])")
      const started = performance.now()
      const r = await run(['--timeout-ms', '1500', path])
      expect(performance.now() - started).toBeLessThan(10000)
      expect([r.code, r.err]).toEqual([124, 'native program did not complete successfully\n'])
      expect(r.receipt).toMatchObject({state: 'timed_out', exitCode: 124, timedOut: true, stdout: 'started\n'})
    })

    test('a failing program: its receipt, its exit code', async () => {
      const path = program(`fail-${serial++}.js`, "console.log('hi'); console.error('boom'); process.exit(3)")
      const r = await run([path])
      expect([r.code, r.err]).toEqual([3, 'native program did not complete successfully\n'])
      expect(r.receipt).toEqual(receiptOf('hi\n', 'boom\n', 3))
    })

    test('argument errors print nothing on stdout', async () => {
      for (const [args, message] of [
        [['x.bend'], 'run executes TypeScript or JavaScript programs; Bend programs are no longer supported (see docs/bend-to-typescript.md)'],
        [['2000', 'file.txt'], 'run requires 1..3600000 ms and a .ts or .js program path (not an option)'],
        [['--label', 'x', 'x.ts'], '--label is supported for start only'],
      ] as [string[], string][]) {
        const r = await run(args)
        expect([r.code, r.out, r.err]).toEqual([2, '', message + '\n'])
      }
    })
  })
}

suite('run from source', () => [bun, join(repo, 'src/run/run.test-main.ts')])

const compiled = join(root, 'jev-fabric-run')
beforeAll(() => {
  const r = Bun.spawnSync([bun, 'build', '--compile', '--minify', join(repo, 'src/run/run.test-main.ts'), '--outfile', compiled], {cwd: repo, stdout: 'pipe', stderr: 'pipe'})
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}, 60000)
suite('run from a compiled binary (BUN_BE_BUN, embedded library)', () => [compiled])

// The shipped binary: JEV_FABRIC_BIN (as the conformance suite takes it), or
// `bun run build`'s build/jev-fabric once built. A 0.8.1 Bend build there
// (its --version names Bend) compiles Bend instead and is skipped.
const shipped = process.env.JEV_FABRIC_BIN ? resolve(repo, process.env.JEV_FABRIC_BIN) : join(repo, 'build/jev-fabric')
const bunBuilt = existsSync(shipped) && !Bun.spawnSync([shipped, '--version'], {env: {}}).stdout.toString().includes('Bend')
if (bunBuilt) suite(`run from ${relative(repo, shipped)}`, () => [shipped])
