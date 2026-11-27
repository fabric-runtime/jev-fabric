// Shared harness for the black-box conformance suite. Every test drives the
// binary named by JEV_FABRIC_BIN (default: the 0.8.1 oracle) through its CLI or
// its `serve` JSONL protocol, with a private store under `.tmp/conformance-*`.
import { expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dir, '../..');
export const BIN = resolve(REPO, process.env.JEV_FABRIC_BIN ?? '.tmp/oracle-0.8.1/jev-fabric');
export const OTHER_BIN = process.env.JEV_FABRIC_OTHER_BIN ? resolve(REPO, process.env.JEV_FABRIC_OTHER_BIN) : undefined;
/**
 * Whether the binary under test is the 0.8.1 Bend build (its `--version` names
 * Bend), whose `run` compiled Bend programs. Later builds run TypeScript or
 * JavaScript with their embedded Bun, so the `run` rows differ by this.
 */
export const BEND_RUN = Bun.spawnSync([BIN, '--version'], { env: {}, stdin: 'ignore' }).stdout.toString().includes('Bend');
export const ID = /^[0-9a-f]{32}$/;
export const SESSION_ID = /^s-[0-9a-f]{32}$/;
export const SPOOL = 1048576;
export const TAIL = 32768;
/** The features 0.8.1 advertises, in its order; later releases may only append. */
export const FEATURES = [
  'follow', 'list', 'label', 'start-24h', 'serve-24h', 'serve-concurrent', 'sessions', 'cwd',
  'durable-input', 'read', 'jev-request-credential', 'decisions', 'decision-targets',
];
/** The CLI's usage line for the job verbs, printed on stderr for malformed job commands. */
export const JOB_USAGE = 'usage: start <timeout-ms> <command> [args...] | status <id> | events <id> [after-sequence] | '
  + 'wait <id> <wait-timeout-ms> | stop <id> | follow <timeout-ms> <id> [after-sequence] | list | '
  + 'write <id> (--stdin | -- text...) | close-input <id> | read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]';

export type Env = Record<string, string>;

/**
 * Unsafe-store refusals exit with the errno of the failing check (0.8.1), which
 * differs by platform: these are the values for this one.
 */
export const ERRNO = process.platform === 'darwin'
  ? { EPERM: 1, ENOTDIR: 20, EFBIG: 27, ELOOP: 62 }
  : { EPERM: 1, ENOTDIR: 20, EFBIG: 27, ELOOP: 40 };

// ---------------------------------------------------------------------------
// Temporary roots. One per test file under .tmp/conformance-*, removed after.

/** A fresh private directory `.tmp/conformance-<name>-XXXXXX` in the repository. */
export function tempRoot(name: string): string {
  mkdirSync(join(REPO, '.tmp'), { recursive: true });
  return mkdtempSync(join(REPO, '.tmp', `conformance-${name}-`));
}

/**
 * A directory of fake tools put first on PATH. Its `curl` is a guard: any
 * attempt to reach the network through curl is recorded and fails, so a test
 * that forgets to install its own fake cannot leave the machine.
 */
export function guardBin(root: string): string {
  const bin = join(root, 'guard-bin');
  mkdirSync(bin, { recursive: true });
  script(join(bin, 'curl'), `printf '%s\\n' "$*" >> '${join(root, 'network-attempts')}'`, 'exit 7');
  return bin;
}

/** Writes an executable /bin/sh script. */
export function script(path: string, ...lines: string[]) {
  writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n');
  chmodSync(path, 0o700);
}

export const readIf = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

// ---------------------------------------------------------------------------
// Running the binary.

export interface Captured { out: string; err: string; code: number; ms: number }
export interface RunOptions {
  env?: Env;
  /** Written to a piped stdin, which is then closed; otherwise stdin is /dev/null. */
  input?: string | Uint8Array;
  cwd?: string;
  bin?: string;
  /** Omit the leading `--` (the bare spelling). */
  bare?: boolean;
}

/** Runs one CLI invocation to completion. The environment is exactly `env`: nothing leaks in. */
export async function run(args: string[], options: RunOptions = {}): Promise<Captured> {
  const argv = [options.bin ?? BIN, ...(options.bare ? [] : ['--']), ...args];
  const begin = performance.now();
  const child = Bun.spawn(argv, {
    env: options.env ?? {},
    cwd: options.cwd,
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.input !== undefined) {
    child.stdin!.write(options.input);
    child.stdin!.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code, ms: performance.now() - begin };
}

/** Parses newline-delimited JSON, ignoring blank lines. */
export function jsonLines(text: string): any[] {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** True once no process with this PID exists. */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: any) {
    return error.code === 'ESRCH';
  }
}

/** Polls `check` every 10 ms until it holds or `ms` pass. */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await Bun.sleep(10);
  }
}

/** One storage home with the job ids started in it, so they can all be stopped. */
export class Store {
  readonly home: string;
  readonly env: Env;
  readonly bin: string;
  readonly started = new Set<string>();

  constructor(home: string, env: Env, bin = BIN) {
    this.home = home;
    this.env = env;
    this.bin = bin;
  }

  run(args: string[], options: RunOptions = {}) {
    return run(args, { bin: this.bin, ...options, env: { ...this.env, ...options.env } });
  }

  /** Runs and expects exit 0, returning stdout. */
  async ok(args: string[], options: RunOptions = {}): Promise<string> {
    const r = await this.run(args, options);
    expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
    return r.out;
  }

  async json(args: string[], options: RunOptions = {}): Promise<any> {
    return JSON.parse(await this.ok(args, options));
  }

  async start(args: string[], options: RunOptions = {}): Promise<string> {
    const out = await this.ok(['start', ...args], options);
    const { id } = JSON.parse(out);
    expect(out).toBe(`{"id":"${id}"}\n`);
    expect(id).toMatch(ID);
    this.started.add(id);
    return id as string;
  }

  async events(id: string, after?: number): Promise<any[]> {
    return jsonLines(await this.ok(['events', id, ...(after === undefined ? [] : [String(after)])]));
  }

  async wait(id: string, ms = 10000): Promise<any> {
    return this.json(['wait', '--timeout-ms', String(ms), id]);
  }

  async stopAll() {
    await Promise.all([...this.started].map(id => this.run(['stop', id])));
  }
}

/** A per-file fixture: a root under .tmp, a network guard, and homes for each test. */
export class Fixture {
  readonly root: string;
  readonly guard: string;
  private serial = 0;
  private readonly stores: Store[] = [];
  private readonly children = new Set<{ kill(signal?: number | NodeJS.Signals): void; exitCode: number | null }>();

  constructor(name: string) {
    this.root = tempRoot(name);
    this.guard = guardBin(this.root);
  }

  /** The base environment: no inherited variables, a guarded PATH, the exec HTTP transport. */
  env(home: string, extra: Env = {}): Env {
    return { PATH: `${this.guard}:/usr/bin:/bin`, JEV_FABRIC_HOME: home, JEV_FABRIC_HTTP: 'exec', ...extra };
  }

  /** A fresh, not yet created, storage home path. */
  homePath(name = 'home'): string {
    return join(this.root, `${name}-${this.serial++}`);
  }

  store(extra: Env = {}, bin = BIN, home = this.homePath()): Store {
    const s = new Store(home, this.env(home, extra), bin);
    this.stores.push(s);
    return s;
  }

  track<T extends { kill(signal?: number | NodeJS.Signals): void; exitCode: number | null }>(child: T): T {
    this.children.add(child);
    return child;
  }

  /** Network attempts recorded by the guard curl. */
  networkAttempts(): string {
    return readIf(join(this.root, 'network-attempts'));
  }

  async cleanup() {
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(this.stores.map(s => s.stopAll()));
    const attempts = this.networkAttempts();
    rmSync(this.root, { recursive: true, force: true });
    expect(attempts, 'a test reached for the network through curl').toBe('');
  }
}

// ---------------------------------------------------------------------------
// Live line readers: `follow`, `watch` and `serve` print as they go.

export class Lines {
  private buffered = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  readonly raw: string[] = [];

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** The next whole line (without its newline), or undefined at end of stream. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const at = this.buffered.indexOf('\n');
      if (at >= 0) {
        const line = this.buffered.slice(0, at);
        this.buffered = this.buffered.slice(at + 1);
        this.raw.push(line);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) return undefined;
      this.buffered += this.decoder.decode(value, { stream: true });
    }
  }

  async json(): Promise<any> {
    const line = await this.next();
    return line === undefined ? undefined : JSON.parse(line);
  }

  async until(check: (value: any) => boolean): Promise<any> {
    for (let value = await this.json(); value !== undefined; value = await this.json()) {
      if (check(value)) return value;
    }
    return undefined;
  }
}

/** A streaming CLI child (`follow`, `watch`) with a line reader. */
export function stream(store: Store, args: string[]) {
  const child = Bun.spawn([store.bin, '--', ...args], { env: store.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return { child, lines: new Lines(child.stdout) };
}

/** A `serve` connection that matches responses by id, so requests may overlap. */
export class Serve {
  readonly child;
  readonly lines: Lines;
  readonly arrived: any[] = [];
  /** The raw response line for each id. */
  readonly rawById = new Map<unknown, string>();
  banner: any;
  bannerRaw = '';
  private nextId = 1;
  private readonly waiting = new Map<unknown, (value: any) => void>();
  private pumping: Promise<void> | undefined;

  constructor(args: string[], env: Env, options: { bin?: string; bare?: boolean } = {}) {
    this.child = Bun.spawn([options.bin ?? BIN, ...(options.bare ? [] : ['--']), 'serve', ...args], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    this.lines = new Lines(this.child.stdout);
  }

  /** Reads the banner, then routes every later line to its waiting request. */
  async open() {
    const raw = await this.lines.next();
    if (raw === undefined) return undefined;
    this.bannerRaw = raw;
    this.banner = JSON.parse(raw);
    this.pumping = this.pump();
    return this.banner;
  }

  private async pump() {
    for (let raw = await this.lines.next(); raw !== undefined; raw = await this.lines.next()) {
      const line = JSON.parse(raw);
      this.arrived.push(line);
      this.rawById.set(line.id, raw);
      const resolve = this.waiting.get(line.id);
      if (resolve) {
        this.waiting.delete(line.id);
        resolve(line);
      }
    }
    for (const resolve of this.waiting.values()) resolve(undefined);
    this.waiting.clear();
  }

  /** Writes raw text to serve's stdin. */
  write(text: string) {
    this.child.stdin.write(text);
    this.child.stdin.flush();
  }

  /** Waits for the response carrying `id` (already arrived or yet to come). */
  response(id: unknown): Promise<any> {
    const seen = this.arrived.find(line => line.id === id);
    if (seen) return Promise.resolve(seen);
    return new Promise(resolve => this.waiting.set(id, resolve));
  }

  /** Sends one request with a fresh numeric id (unless it has one) and resolves with its response. */
  send(request: Record<string, unknown>): Promise<any> {
    let id = request.id;
    if (!('id' in request)) {
      // Never reuse an id that is still waiting or was given explicitly.
      do id = this.nextId++; while (this.waiting.has(id) || this.rawById.has(id));
    }
    const response = new Promise<any>(resolve => this.waiting.set(id, resolve));
    this.write(JSON.stringify({ id, ...request }) + '\n');
    return response;
  }

  async ok(request: Record<string, unknown>): Promise<any> {
    const response = await this.send(request);
    expect(response?.ok, JSON.stringify(response)).toBe(true);
    return response.result;
  }

  /** Ends stdin and waits for exit. */
  async close() {
    this.child.stdin.end();
    const [code, err] = await Promise.all([this.child.exited, new Response(this.child.stderr).text()]);
    await this.pumping;
    return { code, err };
  }
}

export async function serve(fx: Fixture, store: Store, args: string[] = [], extra: Env = {}, options: { bin?: string; bare?: boolean } = {}) {
  const connection = new Serve(args, { ...store.env, ...extra }, { bin: options.bin ?? store.bin, bare: options.bare });
  fx.track(connection.child);
  const banner = await connection.open();
  expect(banner?.ready, 'serve banner').toBeDefined();
  return connection;
}

// ---------------------------------------------------------------------------
// Exact output. The CLI prints JSON with every control character escaped as
// \u00XX (lowercase hex); `serve` lines and the offline decision/validation
// verbs print it as JSON.stringify does. Everything else (key order, other
// characters, number spelling) must match byte for byte. Only the values that
// truly vary are taken from the actual output, through these placeholders.

const VARIES = Symbol('varies');
interface Varies { [VARIES]: string; check: (value: unknown) => boolean }
const varies = (kind: string, check: (value: unknown) => boolean): any => ({ [VARIES]: kind, check });
const isVaries = (value: unknown): value is Varies => typeof value === 'object' && value !== null && VARIES in value;

/** Placeholders for what truly varies between runs. */
export const vary = {
  /** Epoch milliseconds within a minute of now. */
  time: () => varies('time', v => typeof v === 'number' && Number.isInteger(v) && Math.abs(v - Date.now()) < 300000),
  /** A non-negative integer (elapsed milliseconds, pids, sizes that depend on scheduling). */
  count: () => varies('count', v => typeof v === 'number' && Number.isInteger(v) && v >= 0),
  /** A string matching the pattern. */
  text: (pattern: RegExp) => varies(`text ${pattern}`, v => typeof v === 'string' && pattern.test(v)),
  /** Anything satisfying the predicate. */
  where: (label: string, check: (value: unknown) => boolean) => varies(label, check),
};

/** Replaces placeholders in `expected` with the actual values they accept; keeps everything else as expected. */
export function fill(expected: unknown, actual: unknown): unknown {
  if (isVaries(expected)) return expected.check(actual) ? actual : `<expected ${expected[VARIES]}, got ${JSON.stringify(actual)}>`;
  if (Array.isArray(expected)) return expected.map((item, i) => fill(item, Array.isArray(actual) ? actual[i] : undefined));
  if (typeof expected === 'object' && expected !== null) {
    const out: Record<string, unknown> = {};
    const source = typeof actual === 'object' && actual !== null ? (actual as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(expected)) out[key] = fill(value, source[key]);
    return out;
  }
  return expected;
}

/** JSON as the CLI prints it: control characters as \u00XX, nothing else escaped beyond `"` and `\`. */
export function cliJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    let out = '"';
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    }
    return out + '"';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(cliJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => cliJson(k) + ':' + cliJson(v)).join(',') + '}';
  }
  throw new Error(`cannot encode ${typeof value}`);
}

export type Style = 'cli' | 'std';
const encode = (value: unknown, style: Style) => (style === 'cli' ? cliJson(value) : JSON.stringify(value));

/** Expects one raw line (no newline) to be exactly `expected`, placeholders filled from the line itself. */
export function expectLine(raw: string | undefined, expected: unknown, style: Style = 'cli') {
  expect(raw, 'missing line').toBeDefined();
  let actual: unknown;
  try {
    actual = JSON.parse(raw!);
  } catch {
    actual = undefined;
  }
  expect(raw).toBe(encode(fill(expected, actual), style));
}

/** Expects a whole stdout to be exactly these JSON lines, each ending in a newline. */
export function expectOut(out: string, expected: unknown[], style: Style = 'cli') {
  const lines = out.split('\n');
  const actual = lines.slice(0, -1).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  });
  const want = expected.map((item, i) => encode(fill(item, actual[i]), style)).join('\n') + (expected.length ? '\n' : '');
  expect(out).toBe(want);
}

// ---------------------------------------------------------------------------
// Expected records.

export const running = (id: string, extra: { label?: string; lifetime?: string } = {}) => ({
  schemaVersion: 1, id, ...(extra.label === undefined ? {} : { label: extra.label }),
  lifetime: extra.lifetime ?? 'durable', state: 'running', spoolLimitBytes: SPOOL,
});

export interface ReceiptFields {
  state: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: { stdout: boolean; stderr: boolean };
}

/** A process receipt as `exec` prints it. */
export const processReceipt = (r: ReceiptFields) => ({
  schemaVersion: 1, state: r.state, exitCode: r.exitCode,
  timedOut: r.state === 'timed_out', cancelled: r.state === 'cancelled',
  stdout: r.stdout ?? '', stderr: r.stderr ?? '', truncated: r.truncated ?? { stdout: false, stderr: false },
});

/** A job's final receipt as `status`, `wait`, `stop` and `follow.end` print it. */
export const jobReceipt = (id: string, r: ReceiptFields & { label?: string; lifetime?: string }) => ({
  id, ...(r.label === undefined ? {} : { label: r.label }), lifetime: r.lifetime ?? 'durable', spoolLimitBytes: SPOOL,
  ...processReceipt(r),
});

/** A receipt for a job whose command never launched or whose worker died. */
export const failedJob = (id: string, error: string, extra: { label?: string; lifetime?: string } = {}) => ({
  id, ...(extra.label === undefined ? {} : { label: extra.label }), lifetime: extra.lifetime ?? 'durable', spoolLimitBytes: SPOOL,
  schemaVersion: 1, state: 'failed', exitCode: null, error,
});

export const started = (sequence: number, id: string) => ({ sequence, type: 'job.started', data: { id } });
export const output = (sequence: number, stream: string, offset: number, text: string, omittedBytes = 0) => ({
  sequence, type: 'process.output', data: { stream, offset, bytes: Buffer.byteLength(text), omittedBytes, text },
});
export const finished = (sequence: number) => ({ sequence, type: 'job.finished', data: { receiptAvailable: true } });

/** Concatenated `text` of a stream's `process.output` events. */
export function streamText(events: any[], stream = 'stdout') {
  return events.filter(e => e.type === 'process.output' && e.data.stream === stream).map(e => e.data.text).join('');
}
