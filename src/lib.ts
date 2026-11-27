// jev-fabric as a TypeScript library: what 0.8.1 offered Bend programs
// (native/Scope, Process, Session, Jobs, Jev, Decision and the pure policy
// modules), for programs run with `jev-fabric -- run program.ts` or with Bun.
//
//   import {Scope, Session, Job, Jev, exec} from 'jev-fabric'
//
// Everything here is a thin layer over src/time, src/proc, src/jobs, src/jev
// and src/decision: the same limits, deadlines, receipts and Jev budget
// rules, with failures thrown as FabricError (its `code` is what the CLI
// would exit with). A process report is a value, never an error: inspect its
// `code`, `timedOut` and `cancelled`. See docs/native-api.md.
//
// Concurrency is ordinary promises (Bend's IO.fork/IO.join): start several
// calls, then `await Promise.all(...)`. At most 32 children run at once per
// process.

import {existsSync, realpathSync} from 'node:fs'
import {basename, join} from 'node:path'
import * as Codec from './codec/codec.ts'
import type {Json} from './codec/json.ts'
import type {Result} from './codec/result.ts'
import * as DecisionCore from './decision/decision-core.ts'
import * as Decision from './decision/decision.ts'
import type {Budget as JevBudget} from './jev/core.ts'
import type {Client, Deps, Env} from './jev/jev.ts'
import * as JevDriver from './jev/jev.ts'
import {JevSession, evaluateFor} from './jev/session.ts'
import * as Jobs from './jobs/jobs.ts'
import * as Process from './proc/process.ts'
import type {Report} from './proc/report.ts'
import * as Reports from './proc/report.ts'
import * as Sessions from './proc/session.ts'
import * as TimeCore from './time/core.ts'
import * as ScopeDriver from './time/scope.ts'
import * as Time from './time/time.ts'

export type {Report} from './proc/report.ts'
export type {Json} from './codec/json.ts'
export type {JevBudget}

// ---------------------------------------------------------------------------
// Errors.

/** A recoverable failure: `code` is the exit status the CLI uses for it (2 usage, 22 invalid, 124 deadline, an errno ...). */
export class FabricError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'FabricError'
    this.code = code
  }
}

const must = <T>(r: Result<T>): T => {
  if (r.ok) return r.value
  throw new FabricError(r.error.code, r.error.message)
}

const MAX_MS = Time.maxTimeout
const timeout = (ms: number | undefined, fallback: () => Result<number>, max = MAX_MS): number =>
  ms === undefined ? must(fallback()) : must(TimeCore.parsed(Number.isInteger(ms) ? ms : null, max))

// ---------------------------------------------------------------------------
// Processes (Process.bend). Literal argv, an owned process group, a deadline
// that kills the whole group, a 32 KiB tail of each stream.

export type ExecOptions = {
  /** Buffered stdin (at most 128 KiB), written and then closed. */
  input?: string
  /** This program's own stdin, streamed (instead of `input`). */
  inheritStdin?: boolean
  /** 1..3600000 ms; default JEV_FABRIC_TIMEOUT_MS, else one hour. */
  timeoutMs?: number
  /** An existing absolute directory to start in; default this process's. */
  cwd?: string
}

/** Process.exec / exec_input / exec_stdin / run_input / run_stdin / run_in, as one call. */
export async function exec(argv: readonly string[], options: ExecOptions = {}): Promise<Report> {
  if (options.inheritStdin && options.input !== undefined) throw new FabricError(2, 'exec takes input or inheritStdin, not both')
  const ms = timeout(options.timeoutMs, Time.work)
  return must(await Process.runIn(argv, options.input ?? '', ms, options.inheritStdin ?? false, options.cwd ?? ''))
}

/** A byte-exact capture: the report's fields with raw bytes, at most `limit` bytes per stream. */
export type Captured = Omit<Report, 'stdout' | 'stderr'> & {stdout: Uint8Array; stderr: Uint8Array}

/** Process.capture: bounded and byte-preserving; reject `stdoutCut`/`stderrCut` if you need every byte. */
export async function capture(argv: readonly string[], options: {input?: string; timeoutMs?: number; limit?: number} = {}): Promise<Captured> {
  const ms = timeout(options.timeoutMs, Time.work)
  const r = must(await Process.capture(argv, options.input ?? '', ms, options.limit ?? Process.SPOOL_LIMIT))
  const {stdout, stderr, ...flags} = Reports.decode({...r, stdout: '', stderr: ''})
  return {...flags, stdout: r.stdout, stderr: r.stderr}
}

/** Process.show: the one-line JSON receipt `exec` prints. */
export const receipt = (report: Report): string => Reports.show(report)

/**
 * Process.cancel: cancels every child this program owns (SIGTERM to each
 * group, SIGKILL 500 ms later), and every later launch. Sticky.
 */
export const cancel = (): void => Process.cancel()

/**
 * Whether SIGINT, SIGTERM or cancel() interrupted this program. Once a child
 * has been started, those signals cancel the children instead of ending the
 * program: check this in long loops.
 */
export const interrupted = (): boolean => Process.interrupted()

// ---------------------------------------------------------------------------
// Sessions (Session.bend): a live child with an open stdin and spooled output.

export type Spooled = {stdout: number; stderr: number}

/**
 * An interactive child. Reads never block or renew its lifetime; each
 * stream's spool keeps the first 1 MiB (Session.spoolLimit). Always wait().
 */
export class Session {
  static readonly spoolLimit = Sessions.spoolLimit
  #handle: Sessions.Session
  #waited: Promise<Report> | null = null

  private constructor(handle: Sessions.Session) {
    this.#handle = handle
  }

  /** @internal */
  static of(r: Result<Sessions.Session>): Session {
    return new Session(must(r))
  }

  /** Session.open / Session.start: a lifetime of `timeoutMs` (default the work limit). */
  static open(argv: readonly string[], options: {timeoutMs?: number} = {}): Session {
    return Session.of(Sessions.start(argv, timeout(options.timeoutMs, Time.work)))
  }

  /** At most 65536 characters; waits while the child is not reading. */
  async write(text: string): Promise<void> {
    must(await Sessions.write(this.#handle, text))
  }

  /** EOF for the child's stdin; idempotent. */
  closeInput(): void {
    this.#handle = Sessions.closeInput(this.#handle)
  }

  /** Raw bytes from `offset` (<= 1 MiB), at most `max` (<= 65536). Empty is not EOF. */
  readStdout(offset: number, max = 65536): Uint8Array {
    return must(Sessions.readStdout(this.#handle, offset, max))
  }

  readStderr(offset: number, max = 65536): Uint8Array {
    return must(Sessions.readStderr(this.#handle, offset, max))
  }

  /** Bytes spooled so far per stream; a size at spoolLimit may be clipped. */
  status(): Spooled {
    const [stdout, stderr] = must(Sessions.status(this.#handle))
    return {stdout, stderr}
  }

  /** Closes stdin, joins the child and returns its report (a launch error throws). */
  wait(): Promise<Report> {
    this.#waited ??= Sessions.wait(this.#handle).then(must)
    return this.#waited
  }
}

// ---------------------------------------------------------------------------
// Shared deadlines (Scope.bend): one budget for many calls, never renewed.

/**
 * One deadline shared by every call made through it. Each call gets what is
 * left (at most its own `capMs`); an expired scope launches nothing: exec
 * reports 124 timed out, start and Jev throw code 124. Not a cancellation
 * group: cancel() still cancels every child of the program.
 */
export class Scope {
  readonly started: number
  readonly duration: number

  private constructor(budget: TimeCore.Budget) {
    this.started = budget.started
    this.duration = budget.duration
  }

  /** Scope.open: the configured work limit (JEV_FABRIC_TIMEOUT_MS, else one hour). */
  static open(): Scope {
    return new Scope(must(ScopeDriver.open()))
  }

  /** Scope.with_timeout: 1..3600000 ms from now. */
  static withTimeout(ms: number): Scope {
    return new Scope(must(ScopeDriver.withTimeout(ms)))
  }

  /** Milliseconds left now, at most `capMs`. */
  remaining(capMs = MAX_MS): number {
    return must(ScopeDriver.remaining(this, capMs))
  }

  /** Scope.run / run_for: a buffered child within what is left. */
  async exec(argv: readonly string[], options: {input?: string; capMs?: number} = {}): Promise<Report> {
    return must(await ScopeDriver.runFor(this, argv, options.input ?? '', options.capMs ?? MAX_MS))
  }

  /** Scope.start / start_for: a session whose lifetime is what is left. */
  start(argv: readonly string[], options: {capMs?: number} = {}): Session {
    return Session.of(ScopeDriver.startFor(this, argv, options.capMs ?? MAX_MS))
  }
}

// ---------------------------------------------------------------------------
// Durable jobs (the CLI's start/status/wait/stop/events/follow/list/write/
// close-input/read). Jobs outlive this program; their workers re-enter the
// jev-fabric executable.

export type JobState = 'starting' | 'running' | 'exited' | 'failed' | 'timed_out' | 'cancelled'

/** The running state, or the final receipt once the job has ended. */
export type JobStatus = {
  id: string
  label?: string
  lifetime: 'durable' | 'session'
  state: JobState
  spoolLimitBytes: number
  schemaVersion: number
  exitCode?: number | null
  timedOut?: boolean
  cancelled?: boolean
  stdout?: string
  stderr?: string
  truncated?: {stdout: boolean; stderr: boolean}
  [field: string]: unknown
}

export type JobEvent = {sequence: number; type: string; data: Record<string, unknown>}
export type FollowRecord = JobEvent | {type: 'follow.loss'; after: number; next: number} | {type: 'follow.end'; reason: 'finished' | 'timeout'; next: number; receipt: JobStatus}
export type ReadRecord = {
  id: string
  stream: 'stdout' | 'stderr'
  offset: number
  bytes: number
  omittedBytes: number
  text?: string
  data?: string
  next: number
  eof: boolean
  state: JobState
}
export type WriteRecord = {id: string; written: number; closed: boolean}
export type JobList = {jobs: {id: string; state: JobState; label?: string; startedAt?: number; exitCode?: number | null}[]; truncated: boolean}

const CLI = Symbol.for('jev-fabric.cli')
let executable: string[] | null = null

/**
 * The argv that runs the jev-fabric CLI, for job workers. `jev-fabric run`
 * sets it; from source it is this Bun and src/main.ts; otherwise the
 * `jev-fabric` on PATH. Call this to choose another.
 */
export function setExecutable(argv: readonly string[]): void {
  if (!argv.length || !argv[0]!.startsWith('/')) throw new FabricError(22, 'the executable must be an absolute path')
  executable = [...argv]
}

function cliArgv(): string[] {
  if (executable) return executable
  const given = (globalThis as Record<symbol, unknown>)[CLI]
  if (Array.isArray(given)) return given as string[]
  const main = join(import.meta.dir, 'main.ts')
  if (basename(process.execPath).startsWith('bun') && existsSync(main)) return [process.execPath, main]
  const found = Bun.which('jev-fabric')
  if (found) return [realpathSync(found)]
  throw new FabricError(2, 'durable jobs need the jev-fabric executable: put it on PATH or call setExecutable()')
}

async function verb(args: string[]): Promise<string[]> {
  const lines: string[] = []
  const r = await Jobs.command(args, (line) => lines.push(line))
  if (r.code !== 0) throw new FabricError(r.code, r.error ?? 'native private job operation failed')
  return lines
}

const one = async <T>(args: string[]): Promise<T> => JSON.parse((await verb(args))[0]!) as T

export type StartOptions = {
  /** Lifetime, 1..86400000 ms (a day); default JEV_FABRIC_TIMEOUT_MS, else one hour. */
  timeoutMs?: number
  /** 1..120 printable characters on one line. */
  label?: string
  /** An existing absolute directory to start in. */
  cwd?: string
  /** Keep stdin open for write()/closeInput(); streams then keep the latest 1 MiB. */
  input?: 'pipe'
}

/** A durable job in the storage home (JEV_FABRIC_HOME or ./.jev-fabric-native), by id. */
export class Job {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  /** `start`: a detached worker runs the command; returns once it is ready. */
  static async start(argv: readonly string[], options: StartOptions = {}): Promise<Job> {
    const ms = timeout(options.timeoutMs, Time.work, Time.jobMaxTimeout)
    if (!argv.length) throw new FabricError(2, 'command or file is required')
    if (options.cwd !== undefined && !(options.cwd.startsWith('/') && Buffer.byteLength(options.cwd) <= 4096)) throw new FabricError(2, 'cwd must be an absolute path')
    Jobs.configureSelf(cliArgv())
    const mode = options.input === 'pipe' ? 'pipe' : 'batch'
    const started = await one<{id: string}>(['__start', String(ms), options.label ?? '', options.cwd ?? '', mode, ...argv])
    return new Job(started.id)
  }

  /** `list`: every job under the storage home, newest first (at most 1024). */
  static list(): Promise<JobList> {
    return one(['list'])
  }

  /** `status`: the running state or the final receipt. */
  status(): Promise<JobStatus> {
    return one(['status', this.id])
  }

  /** `wait`: the receipt, or the running state once `timeoutMs` (default JEV_FABRIC_WAIT_MS, else 30 s) passes. */
  wait(options: {timeoutMs?: number} = {}): Promise<JobStatus> {
    return one(['wait', this.id, String(timeout(options.timeoutMs, Time.wait))])
  }

  /** `stop`: cooperative and idempotent; the receipt once the worker has ended the group. */
  stop(): Promise<JobStatus> {
    return one(['stop', this.id])
  }

  /** `events`: the retained events after `after`; with `timeoutMs` (1..300000) a long poll. */
  async events(options: {after?: number; timeoutMs?: number} = {}): Promise<JobEvent[]> {
    const after = String(options.after ?? 0)
    const args = options.timeoutMs === undefined ? ['events', this.id, after] : ['events', this.id, after, String(timeout(options.timeoutMs, Time.watch, 300000))]
    return (await verb(args)).map((line) => JSON.parse(line) as JobEvent)
  }

  /**
   * `follow`: each event as the worker publishes it, `follow.loss` before a
   * gap, then one `follow.end` (finished, or timeout after `timeoutMs`).
   */
  async *follow(options: {after?: number; timeoutMs?: number} = {}): AsyncGenerator<FollowRecord> {
    const args = ['follow', String(timeout(options.timeoutMs, Time.wait)), this.id, String(options.after ?? 0)]
    const queue: string[] = []
    let wake: (() => void) | null = null
    let end: Jobs.Exit | null = null
    void Jobs.command(args, (line) => {
      queue.push(line)
      wake?.()
    }).then(
      (r) => {
        end = r
        wake?.()
      },
      (e) => {
        end = {code: 1, error: String(e)}
        wake?.()
      },
    )
    for (;;) {
      while (queue.length) yield JSON.parse(queue.shift()!) as FollowRecord
      if (end) break
      await new Promise<void>((resolve) => (wake = resolve))
      wake = null
    }
    const finished = end as Jobs.Exit
    if (finished.code !== 0) throw new FabricError(finished.code, finished.error ?? 'native private job operation failed')
  }

  /** `write`: queue text for an interactive job's stdin (include the newline). */
  write(text: string): Promise<WriteRecord> {
    if ([...text].length > 65536) throw new FabricError(2, 'write takes at most 65536 characters')
    return one(['write', this.id, '--', text])
  }

  /** `close-input`: end stdin after what is queued; idempotent. */
  closeInput(): Promise<WriteRecord> {
    return one(['close-input', this.id])
  }

  /** `read`: raw bytes of one stream from a byte offset; `waitMs` (1..300000) long-polls. */
  read(stream: 'stdout' | 'stderr', options: {offset?: number; max?: number; waitMs?: number; base64?: boolean} = {}): Promise<ReadRecord> {
    const args = ['read']
    if (options.waitMs !== undefined) args.push('--wait-ms', String(options.waitMs))
    if (options.base64) args.push('--base64')
    args.push(this.id, stream, String(options.offset ?? 0))
    if (options.max !== undefined) args.push(String(options.max))
    return one(args)
  }
}

// ---------------------------------------------------------------------------
// Jev (Jev.bend, Decision.bend): one client, one budget, never retried.

export type ConnectOptions = {
  /** Calls this client may dispatch. */
  maxEvaluations: number
  /** Reported tokens after which later calls are refused. */
  maxTokens: number
  /** Per-request maximum; default JEV_FABRIC_JEV_TIMEOUT_MS, else 30 s. */
  timeoutMs?: number
  /** Provider configuration and keys; default process.env. */
  env?: Env
}

/** An answer: `json` is the exact encoding (numbers keep their lexemes), `value` the same parsed. */
export type Answer<T = any> = {json: string; value: T}

export type EvaluateOptions = {
  /** Spend this shared deadline too: the call gets the least of what is left, `capMs` and the client's timeout. */
  scope?: Scope
  capMs?: number
}

const request = (r: string | object): string => (typeof r === 'string' ? r : JSON.stringify(r))

/**
 * A Jev client. Calls run one at a time in call order, each spending the one
 * budget: the request is validated first, a call is reserved before the
 * credential is resolved, and nothing is retried. Credentials are cached
 * only in this object.
 */
export class Jev {
  #session: JevSession
  #deps: Deps

  private constructor(client: Client, env: Env) {
    this.#session = new JevSession(client)
    this.#deps = {env, now: Time.now}
  }

  /** Jev.connect / Jev.from_env, from JEV_PROVIDER, JEV_MODEL, the provider key or JEV_CREDENTIAL_COMMAND. */
  static connect(options: ConnectOptions): Jev {
    const env = options.env ?? process.env
    const {maxEvaluations, maxTokens, timeoutMs} = options
    if (![maxEvaluations, maxTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new FabricError(2, 'Jev budgets must be non-negative integers')
    const client = timeoutMs === undefined ? JevDriver.connect(maxEvaluations, maxTokens, env) : JevDriver.fromEnv(timeoutMs, maxEvaluations, maxTokens, env)
    return new Jev(must(client), env)
  }

  /** What has been spent: calls left, evaluations made, reported tokens and the token limit. */
  get budget(): JevBudget {
    return {...this.#session.client.budget}
  }

  /** Jev.evaluate (Scope.evaluate_for with a scope): one legacy Jev evaluation. */
  evaluate(body: string | object, options: EvaluateOptions = {}): Promise<Answer> {
    const text = request(body)
    return this.#answer((c) => (options.scope ? evaluateFor(options.scope, c, text, options.capMs ?? MAX_MS, this.#deps) : JevDriver.evaluate(c, text, this.#deps)), Codec.encode)
  }

  /**
   * Decision.evaluate (evaluate_for with a scope): one lossless decision on
   * the same budget. Inspect `value.status` and `value.budget`. `credential`
   * is this request's key alone, never cached.
   */
  decide(body: string | object, options: EvaluateOptions & {credential?: string} = {}): Promise<Answer> {
    const text = request(body)
    const credential = options.credential ?? ''
    return this.#answer(
      (c) =>
        options.scope ? Decision.evaluateFor(options.scope, c, text, credential, options.capMs ?? MAX_MS, this.#deps) : Decision.evaluate(c, text, credential, this.#deps),
      DecisionCore.encode,
    )
  }

  async #answer(call: (c: Client) => Promise<[Client, Result<Json>]>, encode: (v: Json) => Result<string>): Promise<Answer> {
    const result = await this.#session.use(async (c) => {
      const [next, r] = await call(c)
      return [next, r] as [Client, Result<Json>]
    })
    const json = must(encode(must(result)))
    return {json, value: JSON.parse(json)}
  }
}

// ---------------------------------------------------------------------------
// Pure policy modules: no IO, the same code the CLI and laws/ use.

/** Strict bounded JSON with exact numbers, UTF-8, field accessors. */
export * as Codec from './codec/codec.ts'
/** The legacy Jev wire contract: request, body, response, usage, exact decimals. */
export * as Wire from './codec/wire.ts'
/** The additive decision schema: request validation, bodies, replies, usage. */
export * as DecisionWire from './decision/wire.ts'
/** Decision presets and routes. */
export * as DecisionConfig from './decision/config.ts'
/** Timeout parsing, defaults and the shared-budget arithmetic. */
export * as TimeCore from './time/core.ts'
/** Jev routes, the client value and budget reservation. */
export * as JevCore from './jev/jev-core.ts'
/** HTTPS endpoint, key and response-bound policy. */
export * as HttpCore from './jev/http-core.ts'
/** JEV_CREDENTIAL_COMMAND parsing and credential checks. */
export * as CredentialCore from './jev/credential-core.ts'
