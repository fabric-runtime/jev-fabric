/**
 * A thin client for `jev-fabric -- serve`, the JSONL session protocol.
 *
 * One file, Node built-ins only, erasable TypeScript: Bun, Deno, Node 22.6+
 * (type stripping) or any bundler.
 * Copy it next to your code, or import it from
 * `~/.local/share/jev-fabric/current/clients/typescript`.
 *
 * The client starts one `serve` child, writes one request line per call and
 * resolves each promise with the response that carries the same id. Requests
 * may overlap: serve answers them concurrently, in any order. Budgets,
 * deadlines, credentials and Jev validation all live in the executable; this
 * module only frames JSON.
 *
 * ```ts
 * import { Fabric } from './jev-fabric.ts';
 *
 * const fabric = await Fabric.open({ maxEvaluations: 10 });
 * const job = await fabric.start(['/bin/sh', '-c', 'npm run dev']);
 * await fabric.watch(job, 'ready', { timeoutMs: 30000 });
 *
 * const repl = await fabric.spawn(['python3', '-i']);   // a session child
 * await fabric.write(repl.id, 'print(6 * 7)\n');
 * const out = await fabric.read(repl.id, 'stdout', { waitMs: 5000 });
 * await fabric.close();                                   // stops repl
 * ```
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** The protocol major this client speaks; features are only added within it. */
export const PROTOCOL = 2;

export interface FabricOptions {
  /** Defaults to `$JEV_FABRIC_BIN` or `jev-fabric` on PATH. */
  binary?: string;
  /** Bounds the whole session; defaults to the CLI work default (one hour). */
  timeoutMs?: number;
  /** Jev evaluations for the whole session; defaults to 1, as for `jev`. */
  maxEvaluations?: number;
  /** Reported Jev tokens for the whole session; defaults to 100000. */
  maxTokens?: number;
  /** Non-secret routing profiles, snapshotted into DECISION_PROFILES at startup. */
  decisionProfiles?: DecisionProfiles;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface Ready {
  protocol: number;
  version: string;
  timeoutMs: number;
  maxEvaluations: number;
  maxTokens: number;
  /** The storage format this binary reads and writes. */
  store: number;
  /** For example `darwin-arm64` or `linux-x64`. */
  platform: string;
  /** Implemented features, such as `sessions` or `serve-concurrent`. */
  features: string[];
}

/** What `jev-fabric -- capabilities` prints. */
export interface Capabilities {
  version: string;
  protocol: number;
  store: number;
  platform: string;
  features: string[];
}

export interface Receipt {
  schemaVersion: number;
  state: 'exited' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
}

/** `durable` for `start` jobs, `session` for children of this connection (`s-` ids). */
export type Lifetime = 'durable' | 'session';

/** `label` is present only when the job was started with one. */
export type JobState =
  | (Receipt & { id: string; label?: string; lifetime: Lifetime; spoolLimitBytes: number })
  | { schemaVersion: number; id: string; label?: string; lifetime: Lifetime; state: 'running'; spoolLimitBytes: number }
  | {
      schemaVersion: number;
      id: string;
      label?: string;
      lifetime: Lifetime;
      state: 'failed';
      exitCode: null;
      error: string;
      spoolLimitBytes: number;
    };

/**
 * Raw bytes of one stream from a byte offset. Offsets count every byte the
 * child wrote and never reset; `omittedBytes` discloses bytes that fell out of
 * the retained window before this read. `text` holds decoded UTF-8 (a partial
 * character at the end waits for the next read); with `encoding: 'base64'`,
 * `data` holds the exact bytes instead.
 */
export interface ReadRecord {
  id: string;
  stream: 'stdout' | 'stderr';
  offset: number;
  bytes: number;
  omittedBytes: number;
  text?: string;
  data?: string;
  next: number;
  eof: boolean;
  state: string;
}

/** `written` counts UTF-8 bytes; `closed` is true once stdin has ended. */
export interface WriteRecord {
  id: string;
  written: number;
  closed: boolean;
}

/**
 * One retained job event. Known types: `job.started`, `process.output`
 * (`stream`, `offset`, `bytes`, `omittedBytes`, `text`), `process.spool_limit`
 * and, last, `job.finished`.
 */
export interface JobEvent {
  sequence: number;
  type: string;
  data: unknown;
}

/** One job directory under the storage root, as `list` reports it. */
export interface JobSummary {
  id: string;
  /** `running`, `starting` (worker not yet announced) or a receipt state. */
  state: 'running' | 'starting' | Receipt['state'];
  label?: string;
  /** Present, as `session`, only in a `scope: 'session'` listing. */
  lifetime?: 'session';
  /** Wall-clock start, epoch milliseconds; absent for jobs from before 0.4. */
  startedAt?: number;
  exitCode?: number | null;
}

export interface JobList {
  /** Newest first, at most 1024. */
  jobs: JobSummary[];
  truncated: boolean;
}

export interface MonitorRecord {
  type: 'monitor.batch' | 'monitor.loss' | 'monitor.end';
  [field: string]: unknown;
}

export type DecisionJSON = null | boolean | number | string | DecisionJSON[] | { [key: string]: DecisionJSON };
export type DecisionDescription = string | DecisionJSON[] | { [key: string]: DecisionJSON };
export type DecisionQuestion =
  | { type: 'choice'; instructions: DecisionDescription; criteria: Record<string, DecisionDescription | null> }
  | { type: 'score'; instructions: DecisionDescription; criteria: DecisionDescription[] }
  | { type: 'boolean' | 'bool' | 'noul' | 'predicate'; instructions: DecisionDescription; criteria?: { true?: DecisionDescription; false?: DecisionDescription } }
  /** TypeSafe only (Jev 1.14): one bounding box around what the instructions name, in an image of the request. */
  | { type: 'box'; instructions: DecisionDescription };
export type DecisionAPI = 'system-one' | 'cloudflare' | 'openai-decisions' | 'vercel-evaluate' | 'llama-cpp' | 'llama-system-one' | 'anthropic' | 'google';
export interface DecisionProvider {
  provider: string;
  api: DecisionAPI | '';
  defaultModel: string;
  endpoint: string;
  credentialEnv: string;
  imageSupport: 'supported' | 'model-dependent' | 'unsupported';
  generated: boolean;
}
export interface DecisionTarget {
  provider: string;
  api?: DecisionAPI;
  model?: string;
  endpoint?: string;
  allowLocal?: boolean;
  allowGenerated?: boolean;
  providerOptions?: Record<string, DecisionJSON>;
  temperature?: number;
}
export interface DecisionProfiles {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, DecisionTarget>;
}
export interface DecisionResolution {
  target: {
    provider: string;
    api: DecisionAPI;
    model: string;
    endpoint: string;
    allowLocal: boolean;
    allowGenerated: boolean;
    providerOptions?: Record<string, DecisionJSON>;
    temperature?: number;
  };
  credential: { env: string; resolved: false };
  imageSupport: 'supported' | 'unsupported' | 'model-dependent';
  generated: boolean;
  profile?: string;
}
export type DecisionEvidence = Pick<DecisionRequest, 'state' | 'questions' | 'images'>;
export interface DecisionCallOptions { timeoutMs?: number; credential?: string }
type FrozenDecisionJSON = null | boolean | number | string | readonly FrozenDecisionJSON[] | { readonly [key: string]: FrozenDecisionJSON };
export type DecisionTargetSnapshot = Readonly<Omit<DecisionTarget, 'providerOptions'>> & {
  readonly providerOptions?: { readonly [key: string]: FrozenDecisionJSON };
};
/** A non-owning view: no close/open, no credentials retained, one parent budget. */
export interface DecisionTargetView {
  readonly target: DecisionTargetSnapshot | string;
  decide(evidence: DecisionEvidence, options?: DecisionCallOptions): Promise<DecisionResult>;
  resolveDecision(evidence: DecisionEvidence): Promise<DecisionResolution>;
}
export interface DecisionRequest {
  profile?: string;
  state: string | DecisionJSON[] | { [key: string]: DecisionJSON };
  questions: Record<string, DecisionQuestion>;
  provider?: string;
  api?: DecisionAPI;
  model?: string;
  /** Explicit endpoint override. Hosted endpoints require HTTPS. */
  endpoint?: string;
  /** `ref` places the image for TypeSafe (which requires it): the image goes wherever that text appears in the state, instructions or criteria. */
  images?: { type?: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; ref?: string }[];
  /** Permit plain HTTP only to literal loopback addresses. */
  allowLocal?: boolean;
  /** Required for prompted Anthropic/Gemini estimates, not native decision probabilities. */
  allowGenerated?: boolean;
  providerOptions?: Record<string, DecisionJSON>;
  temperature?: number;
}
export type DecisionAnswer =
  | { type: 'boolean'; probability: number }
  | { type: 'choice'; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, DecisionDescription> }
  /** Edges are fractions of the image's height (top, bottom) and width (left, right) from its top-left corner. */
  | { type: 'box'; box: { top: number; bottom: number; left: number; right: number }; confidence?: number }
  | { type: 'refusal'; [field: string]: unknown };
export interface DecisionResult {
  status: 'ok' | 'error';
  provider: string;
  api: DecisionAPI;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number | null; output_tokens: number | null };
  provenance?: { kind: 'native' | 'generated' | 'token-logprobs'; [field: string]: unknown };
  /** Original values. JavaScript numbers have normal JSON.parse precision limits. */
  raw?: DecisionJSON;
  /** Original provider JSON; use an exact-number parser when precision matters. */
  rawJson?: string;
  rawText?: string;
  rawComplete?: boolean;
  /** HTTP status of a direct exchange; local adapters retain it per raw entry. */
  httpStatus?: number;
  error?: { code: number; message: string } | null;
  budget: { exhausted: boolean; reason: string };
}

export type JevRequest = Record<string, unknown>;
export type JevAnswer = {
  model?: string;
  answers: Record<string, Record<string, unknown>>;
  usage?: { input_tokens: number; output_tokens: number };
};

/**
 * A request the session refused or could not complete. `code` follows the
 * CLI's exit codes: 2 for a malformed request, 22 for a rejected value, 124 for
 * an expired deadline, 1 otherwise.
 */
export class FabricError extends Error {
  readonly code: number;
  readonly op?: string;

  constructor(code: number, message: string, op?: string) {
    super(op ? `${op}: ${message}` : message);
    this.name = 'FabricError';
    this.code = code;
    this.op = op;
  }
}

const decisionAPIs: readonly DecisionAPI[] = ['system-one', 'cloudflare', 'openai-decisions', 'vercel-evaluate', 'llama-cpp', 'llama-system-one', 'anthropic', 'google'];
const targetFields = ['provider', 'api', 'model', 'endpoint', 'allowLocal', 'allowGenerated', 'providerOptions', 'temperature'];
const secretField = (key: string): boolean => /secret|password|credential|apikey|authorization/.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')) || ['auth', 'headers', 'token', 'accesstoken', 'refreshtoken', 'privatekey'].includes(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
function invalidConfig(): never { throw new TypeError('Invalid decision target/profile: expected non-secret, finite JSON with only supported fields'); }
function objectFields(value: unknown, allowed?: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidConfig();
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) invalidConfig();
}
/** Descriptor-based copy rejects getters, toJSON, exotic objects, cycles and lossy JSON. */
function cloneJSON(value: unknown, seen = new Set<object>(), depth = 0, rejectSecrets = false): DecisionJSON {
  if (depth > 64) invalidConfig();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) invalidConfig();
  seen.add(value);
  const array = Array.isArray(value);
  if (!array) objectFields(value);
  const result: any = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || (rejectSecrets && secretField(key))) invalidConfig();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (value as unknown[]).length))) invalidConfig();
    Object.defineProperty(result, key, { value: cloneJSON(descriptor.value, seen, depth + 1, rejectSecrets), enumerable: true, writable: true, configurable: true });
  }
  if (array && Object.keys(result).length !== (value as unknown[]).length) invalidConfig();
  seen.delete(value);
  return result;
}
function freezeJSON<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJSON(item);
    Object.freeze(value);
  }
  return value;
}
function profileName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) invalidConfig();
  return value;
}
function validateTarget(value: unknown): DecisionTarget {
  const target: unknown = cloneJSON(value, new Set(), 0, true);
  objectFields(target, targetFields);
  if (!Object.hasOwn(target, 'provider') || typeof target.provider !== 'string' || !target.provider.trim()) invalidConfig();
  for (const key of ['provider', 'api', 'model', 'endpoint']) {
    if (Object.hasOwn(target, key) && (typeof target[key] !== 'string' || !target[key] || /[\x00-\x1f\x7f]/.test(target[key]))) invalidConfig();
  }
  if (Object.hasOwn(target, 'api') && !decisionAPIs.includes(target.api)) invalidConfig();
  if (typeof target.model === 'string' && (Array.from(target.model).length > 256 || /[\uD800-\uDFFF]/u.test(target.model))) invalidConfig();
  for (const key of ['allowLocal', 'allowGenerated']) if (Object.hasOwn(target, key) && typeof target[key] !== 'boolean') invalidConfig();
  if (Object.hasOwn(target, 'temperature') && (typeof target.temperature !== 'number' || target.temperature < 0 || target.temperature > 2)) invalidConfig();
  if (Object.hasOwn(target, 'providerOptions')) objectFields(target.providerOptions);
  if (Object.hasOwn(target, 'endpoint')) {
    // Match native structural policy on the raw URL, before any URL normalization.
    // Exact loopback HTTP is a valid shape; selected preflight requires allowLocal.
    const endpoint = target.endpoint as string;
    const match = /^(https?):\/\/([A-Za-z0-9.-]+|\[::1\])(?::([0-9]+))?(?:\/[^]*)?$/.exec(endpoint);
    if (!match || /[^\x21-\x7e]|[?#\\]/.test(endpoint) || Array.from(endpoint).length > 4096 ||
      (match[3] !== undefined && (+match[3] < 1 || +match[3] > 65535)) ||
      (match[1] !== 'https' && !['127.0.0.1', '[::1]'].includes(match[2]!))) invalidConfig();
  }
  return target as unknown as DecisionTarget;
}
function validateResolvedTarget(value: unknown): DecisionResolution['target'] {
  const target = validateTarget(value);
  for (const key of ['provider', 'api', 'model', 'endpoint', 'allowLocal', 'allowGenerated']) {
    if (!Object.hasOwn(target, key)) invalidConfig();
  }
  if (!decisionAPIs.includes(target.api!)) invalidConfig();
  return target as DecisionResolution['target'];
}
function serializeProfiles(value: DecisionProfiles): string {
  const doc: unknown = cloneJSON(value);
  objectFields(doc, ['version', 'defaultProfile', 'profiles']);
  if (!Object.hasOwn(doc, 'version') || doc.version !== 1 || !Object.hasOwn(doc, 'profiles')) invalidConfig();
  objectFields(doc.profiles);
  if (Object.keys(doc.profiles).length > 128) invalidConfig();
  for (const [name, target] of Object.entries(doc.profiles)) { profileName(name); validateTarget(target); }
  if (Object.hasOwn(doc, 'defaultProfile') && !Object.hasOwn(doc.profiles, profileName(doc.defaultProfile))) invalidConfig();
  const text = JSON.stringify(doc);
  if (Buffer.byteLength(text, 'utf8') > 65536) invalidConfig();
  return text;
}

interface Pending {
  op: string;
  resolve(value: any): void;
  reject(error: FabricError): void;
}

/**
 * One `jev-fabric -- serve` session. Requests may be issued concurrently and
 * are answered as they complete, matched by id. Writes, closes and stops of
 * one session child apply in the order they were sent; `jev` requests run one
 * at a time. Closing the session stops its session children.
 */
export class Fabric {
  readonly ready: Ready;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly exited: Promise<number | null>;
  private readonly log: { text: string };
  private ended?: FabricError;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    ready: Ready,
    lines: AsyncIterator<string>,
    exited: Promise<number | null>,
    log: { text: string },
  ) {
    this.child = child;
    this.ready = ready;
    this.exited = exited;
    this.log = log;
    void this.pump(lines);
  }

  static async open(options: FabricOptions = {}): Promise<Fabric> {
    const profiles = options.decisionProfiles === undefined ? undefined : serializeProfiles(options.decisionProfiles);
    const env = profiles === undefined ? options.env : { ...(options.env ?? process.env), DECISION_PROFILES: profiles };
    const binary = options.binary ?? process.env.JEV_FABRIC_BIN ?? 'jev-fabric';
    const argv = ['--', 'serve'];
    if (options.timeoutMs !== undefined) argv.push('--timeout-ms', String(options.timeoutMs));
    const maxEvaluations = options.maxEvaluations ?? (options.maxTokens !== undefined ? 1 : undefined);
    if (maxEvaluations !== undefined) argv.push(String(maxEvaluations));
    if (options.maxTokens !== undefined) argv.push(String(options.maxTokens));
    const child = spawn(binary, argv, { env, cwd: options.cwd, stdio: 'pipe' });
    // serve writes to stderr only when it exits abnormally; keep it for the error.
    const log = { text: '' };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => (log.text += chunk));
    const exited = new Promise<number | null>(done => child.once('close', code => done(code)));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => reject(new FabricError(1, `could not start ${binary}: ${error.message}`)));
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done) {
      const code = await exited;
      throw new FabricError(code || 1, log.text.trim() || `serve exited with code ${code}`);
    }
    const banner = JSON.parse(first.value);
    if (banner?.ready?.protocol !== PROTOCOL) {
      child.stdin.end();
      throw new FabricError(1, `unsupported serve protocol: ${first.value}`);
    }
    const fabric = new Fabric(child, banner.ready, lines, exited, log);
    if (profiles !== undefined) {
      try { fabric.requireDecisionTargets(); } catch (error) {
        await fabric.close();
        throw error;
      }
    }
    return fabric;
  }

  // -- processes -------------------------------------------------------------

  /**
   * Runs literal argv to completion. A nonzero exit is a receipt, not an error.
   * `cwd` is an absolute directory the command starts in.
   */
  exec(argv: string[], options: { stdin?: string; timeoutMs?: number; cwd?: string } = {}): Promise<Receipt> {
    return this.call('exec', { argv, stdin: options.stdin, timeoutMs: options.timeoutMs, cwd: options.cwd });
  }

  /**
   * Starts a detached job that outlives this session; resolves to its id.
   * `timeoutMs` is the job's own lifetime, up to 86400000 (24 hours).
   * `label` is 1..120 printable characters on one line. With `input: 'pipe'`
   * its stdin stays open for `write` (fed through a queue drained every 25 ms).
   */
  async start(
    argv: string[],
    options: { timeoutMs?: number; label?: string; cwd?: string; input?: 'pipe' | 'null' } = {},
  ): Promise<string> {
    const started = await this.call<{ id: string }>('start', {
      argv,
      timeoutMs: options.timeoutMs,
      label: options.label,
      cwd: options.cwd,
      input: options.input,
    });
    return started.id;
  }

  /**
   * Starts a session child: an `s-` id that lives until it exits, its own
   * `timeoutMs` (up to 24 hours) passes, it is stopped, or this session ends.
   * With `stdin: 'pipe'` (the default) its stdin stays open for `write`.
   */
  spawn(
    argv: string[],
    options: { stdin?: 'pipe' | 'null'; timeoutMs?: number; label?: string; cwd?: string } = {},
  ): Promise<JobState> {
    return this.call('spawn', {
      argv,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      label: options.label,
      cwd: options.cwd,
    });
  }

  /** Appends up to 65536 characters to an interactive child's stdin, in order. */
  write(job: string, text: string): Promise<WriteRecord> {
    return this.call('write', { job, text });
  }

  /** Ends an interactive child's stdin. Idempotent. */
  closeInput(job: string): Promise<WriteRecord> {
    return this.call('closeInput', { job });
  }

  /**
   * Up to `max` (default and limit 65536) bytes of one stream from `offset`.
   * With `waitMs` (1..300000), a long poll: it answers as soon as bytes past
   * `offset` exist, the stream ends, or `waitMs` passes.
   */
  read(
    job: string,
    stream: 'stdout' | 'stderr',
    options: { offset?: number; max?: number; waitMs?: number; encoding?: 'text' | 'base64' } = {},
  ): Promise<ReadRecord> {
    return this.call('read', {
      job,
      stream,
      offset: options.offset,
      max: options.max,
      waitMs: options.waitMs,
      encoding: options.encoding,
    });
  }

  status(job: string): Promise<JobState> {
    return this.call('status', { job });
  }

  /**
   * Retained events with a sequence above `after` (a bounded snapshot). With
   * `waitMs` (1..300000), a long poll: it answers once such an event exists or
   * the job is terminal, or with the (possibly empty) array once `waitMs` passes.
   */
  events(job: string, options: { after?: number; waitMs?: number } = {}): Promise<JobEvent[]> {
    return this.call('events', { job, after: options.after, waitMs: options.waitMs });
  }

  /**
   * Job directories under the session's storage root, newest first; with
   * `scope: 'session'`, this session's children instead.
   */
  list(options: { scope?: 'store' | 'session' } = {}): Promise<JobList> {
    return this.call('list', { scope: options.scope });
  }

  /** The version, protocol, store format, platform and features of the binary. */
  capabilities(): Promise<Capabilities> {
    return this.call('capabilities', {});
  }

  /** The final receipt, or the running state once `timeoutMs` passes. */
  wait(job: string, options: { timeoutMs?: number } = {}): Promise<JobState> {
    return this.call('wait', { job, timeoutMs: options.timeoutMs });
  }

  stop(job: string): Promise<JobState> {
    return this.call('stop', { job });
  }

  /** Live output lines containing `literal`, as monitor records. */
  watch(job: string, literal: string, options: { timeoutMs?: number } = {}): Promise<MonitorRecord[]> {
    return this.call('watch', { job, literal, timeoutMs: options.timeoutMs });
  }

  // -- Jev -------------------------------------------------------------------

  /** Offline registered presets, not a live catalog or credential availability check. */
  decisionProviders(): Promise<DecisionProvider[]> {
    return this.call('decisionProviders', {});
  }

  /** Validate the additive decision request format without retrieving credentials. */
  async validateDecision(request: DecisionRequest): Promise<DecisionRequest> {
    if ('profile' in request) {
      this.requireDecisionTargets();
      if (!Object.hasOwn(request, 'profile')) invalidConfig();
      profileName(request.profile);
    }
    return this.call('validateDecision', { request });
  }

  /** One explicit decision against the shared Jev/decision budget. Inspect result.status. */
  async decide(request: DecisionRequest, options: DecisionCallOptions = {}): Promise<DecisionResult> {
    if ('profile' in request) {
      this.requireDecisionTargets();
      if (!Object.hasOwn(request, 'profile')) invalidConfig();
      profileName(request.profile);
    }
    return this.call('decide', { request, timeoutMs: options.timeoutMs, credential: options.credential });
  }

  /** Resolve routing offline; credentials are named, never retrieved. */
  async resolveDecision(request: DecisionRequest): Promise<DecisionResolution> {
    this.requireDecisionTargets();
    if ('profile' in request) {
      if (!Object.hasOwn(request, 'profile')) invalidConfig();
      profileName(request.profile);
    }
    return this.call('resolveDecision', { request });
  }

  /** Snapshot routing, not evidence or credentials; reuse this exact session. */
  withDecisionTarget(target: DecisionTarget | string): DecisionTargetView {
    this.requireDecisionTargets();
    const bound = typeof target === 'string' ? profileName(target) : freezeJSON(validateTarget(target));
    if (typeof bound !== 'string') {
      const request = (evidence: DecisionEvidence): DecisionRequest => {
        const copy = cloneJSON(evidence) as unknown as DecisionEvidence;
        objectFields(copy, ['state', 'questions', 'images']);
        return { ...copy, ...cloneJSON(bound) as unknown as DecisionTarget };
      };
      return Object.freeze({
        get target() { return freezeJSON(cloneJSON(bound) as unknown as DecisionTarget); },
        decide: async (evidence: DecisionEvidence, options?: DecisionCallOptions) => this.decide(request(evidence), options),
        resolveDecision: async (evidence: DecisionEvidence) => this.resolveDecision(request(evidence)),
      });
    }
    let resolved: DecisionTarget | undefined;
    let binding: Promise<DecisionTarget> | undefined;
    const prepare = async (evidence: DecisionEvidence) => {
      const copy = cloneJSON(evidence) as unknown as DecisionEvidence;
      objectFields(copy, ['state', 'questions', 'images']);
      // Only the caller that starts binding keeps its resolution envelope, and
      // only until this call returns. The shared promise carries routing alone.
      let resolution: DecisionResolution | undefined;
      if (typeof bound === 'string' && !resolved) {
        if (!binding) {
          binding = this.resolveDecision({ ...copy, profile: bound }).then(result => {
            resolved = freezeJSON(validateResolvedTarget(result.target));
            resolution = result;
            return resolved;
          });
        }
        const pending = binding;
        try { await pending; }
        finally { if (binding === pending) binding = undefined; }
      }
      const routing = typeof bound === 'string' ? resolved! : bound;
      return { request: { ...copy, ...cloneJSON(routing) as unknown as DecisionTarget }, resolution };
    };
    return Object.freeze({
      get target() { return typeof bound === 'string' ? bound : freezeJSON(cloneJSON(bound) as unknown as DecisionTarget); },
      decide: async (evidence: DecisionEvidence, options?: DecisionCallOptions) => this.decide((await prepare(evidence)).request, options),
      resolveDecision: async (evidence: DecisionEvidence) => {
        const { request, resolution } = await prepare(evidence);
        return resolution ?? this.resolveDecision(request);
      },
    });
  }

  private requireDecisionTargets(): void {
    if (!this.ready.features?.includes('decision-targets')) {
      throw new FabricError(1, 'decision-targets requires an updated jev-fabric binary; update jev-fabric');
    }
  }

  /** Strictly validates a Jev request offline, without credentials. */
  validate(request: JevRequest): Promise<JevRequest> {
    return this.call('validate', { request });
  }

  /**
   * One explicit, billed evaluation against the session budget. `provider` and
   * `credential` apply to this request only: the credential travels over the
   * private pipe and is never cached, echoed or logged.
   */
  jev(
    request: JevRequest,
    options: { timeoutMs?: number; provider?: 'typesafe' | 'openrouter' | 'vercel' | 'subq'; credential?: string } = {},
  ): Promise<JevAnswer> {
    return this.call('jev', {
      request,
      timeoutMs: options.timeoutMs,
      provider: options.provider,
      credential: options.credential,
    });
  }

  // -- session ---------------------------------------------------------------

  /**
   * Ends the session by closing its input; resolves to the exit code once
   * every request in flight has answered and the session children are stopped.
   */
  close(): Promise<number | null> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    return this.exited;
  }

  // -- framing ---------------------------------------------------------------

  private call<T>(op: string, fields: Record<string, unknown>): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    const request: Record<string, unknown> = { id, op };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) request[key] = value;
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { op, resolve, reject });
      this.child.stdin.write(JSON.stringify(request) + '\n', error => {
        if (error && this.pending.delete(id)) reject(new FabricError(1, `serve input closed: ${error.message}`, op));
      });
    });
  }

  private async pump(lines: AsyncIterator<string>) {
    try {
      for (let next = await lines.next(); !next.done; next = await lines.next()) {
        const response = JSON.parse(next.value);
        const waiting = this.pending.get(response.id);
        if (!waiting) continue;
        this.pending.delete(response.id);
        if (response.ok) waiting.resolve(response.result);
        else waiting.reject(new FabricError(response.error?.code ?? 1, response.error?.message ?? 'request failed', waiting.op));
      }
    } finally {
      const code = await this.exited;
      this.ended = new FabricError(code || 1, this.log.text.trim() || `serve exited with code ${code}`);
      for (const [, waiting] of this.pending) {
        waiting.reject(new FabricError(this.ended.code, this.ended.message, waiting.op));
      }
      this.pending.clear();
    }
  }
}
