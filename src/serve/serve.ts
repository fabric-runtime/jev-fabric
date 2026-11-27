// `serve`: a JSONL session over stdin and stdout for callers in any language
// (the driver half of native/Serve.bend; the policy is ./core.ts and the
// bookkeeping ./hub.ts).
//
// Protocol 2 answers requests concurrently. The reader frames stdin into
// lines and hands each to the hub, which owns the session: the one Jev
// client (budget and cached credential), the session children and the
// counts the session needs to end cleanly. The hub answers offline requests
// at once, in arrival order, and starts a task for every other request; each
// task writes its own response. Every response line is written whole, with
// one synchronous write, so lines never interleave. A session child's stdin
// belongs to its feeder, which applies that child's writes and closes in
// arrival order.
//
// Process and job operations re-enter this executable as CLI children
// (`<self> --RTS exec …`, `start`, `status`, `events`, `wait`, `stop`,
// `list`) under a deadline and relay their JSON, so their records are the
// CLI's exactly and a command that cannot launch costs one error response,
// never the session. `watch` runs the CLI's own monitor in process and is
// relayed the same way. `read`, `write`, `closeInput`, `spawn` and `list`
// with `"scope":"session"` run in process.
//
// Session children are supervised here, in this process (src/jobs/session.ts
// writes the files their 0.8.1 workers wrote). The session holds each one's
// lease, kills and reaps each one's group on every ending it lives through
// (end of input, the deadline, SIGTERM and SIGINT, exit), and starts one
// small watchdog with its first child (src/proc/watchdog.ts) for the ending
// it cannot live through: once this process is gone without stopping them,
// the watchdog stops the children's groups and publishes their receipts.
//
// The session ends when stdin closes (exit 0), when a request finds its
// deadline passed (exit 124), when a partial line grows past 16 MiB (exit 2)
// or after 16,777,216 reads (exit 1). Ending answers every request in
// flight, stops the session children (forcing whatever is left after 3 s)
// and removes their directories.

import {closeSync, writeSync} from 'node:fs'
import * as Cli from '../cli/core.ts'
import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import {NULL} from '../codec/json.ts'
import type {Err, Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Decision from '../decision/decision.ts'
import * as DecisionConfig from '../decision/config.ts'
import * as Targets from '../decision/targets.ts'
import type {Client, Deps} from '../jev/jev.ts'
import * as Jev from '../jev/jev.ts'
import * as JevPolicy from '../jev/jev-core.ts'
import type {Scope} from '../jev/session.ts'
import {JevSession, encoded as jevEncoded, evaluateRequest, remaining as scopeRemaining} from '../jev/session.ts'
import * as JobsCore from '../jobs/core.ts'
import * as Monitor from '../monitor/index.ts'
import * as Jobs from '../jobs/jobs.ts'
import * as SessionChildren from '../jobs/session.ts'
import * as Process from '../proc/process.ts'
import * as Watchdog from '../proc/watchdog.ts'
import * as Spool from '../spool/spool.ts'
import * as Host from '../store/host.ts'
import * as L from '../sys/libc.ts'
import * as TimeCore from '../time/core.ts'
import * as Time from '../time/time.ts'
import * as Core from './core.ts'
import * as Hub from './hub.ts'

/** The version `serve` and `capabilities` report (Cli.version). */
export const VERSION = Cli.VERSION

const clock = (): number => Math.floor(performance.now())
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function closeFd(fd: number): void {
  if (fd < 0) return
  try {
    closeSync(fd)
  } catch {}
}

/** One whole line on stdout: a single write, waiting while the pipe is full. */
let stdoutGone = false
export function println(text: string): void {
  if (stdoutGone) return
  const data = Buffer.from(`${text}\n`, 'utf8')
  for (let sent = 0; sent < data.length; ) {
    try {
      sent += writeSync(1, data, sent, data.length - sent)
    } catch (e) {
      const n = L.errnoOf(e)
      if (n === L.E.EAGAIN || n === L.E.EWOULDBLOCK || n === L.E.EINTR) {
        Bun.sleepSync(1)
        continue
      }
      stdoutGone = true
      return
    }
  }
}

const printErr = (message: string) => {
  try {
    writeSync(2, `${message}\n`)
  } catch {}
}

/** Writes all of `text` to a nonblocking pipe, waiting while it is full; false once its reader is gone. */
async function writeAll(fd: number, text: string): Promise<boolean> {
  const data = Buffer.from(text, 'utf8')
  for (let sent = 0; sent < data.length; ) {
    try {
      sent += writeSync(fd, data, sent, data.length - sent)
    } catch (e) {
      const n = L.errnoOf(e)
      if (n !== L.E.EAGAIN && n !== L.E.EWOULDBLOCK && n !== L.E.EINTR) return false
      await sleep(2)
    }
  }
  return true
}

/** A request's one answer. */
type Ticket = (result: Result<string>) => void

/** A session child: its directory, public id, stdin, and its supervision in this process. */
type ChildIO = {dir: string; id: string; fd: number; feeder: Hub.Feeder<Ticket>; child: SessionChildren.Child}

export type Settings = {
  timeout: number
  calls: number
  tokens: number
  client: Client
  self: string[]
  defaults: Core.Defaults
  platform: string
  env: Deps['env']
}

export class Session {
  readonly hub = Hub.hub()
  readonly #s: Settings
  readonly #scope: Scope
  readonly #jev: JevSession
  readonly #deps: Deps
  readonly #children = new Map<string, ChildIO>()
  #chain: Promise<void> = Promise.resolve()
  #force: ReturnType<typeof setTimeout> | undefined
  /** In-process watches, cancelled with the CLI children when the ending forces stragglers. */
  readonly #watches = new Set<AbortController>()
  /** Stops the session children's groups if this process dies without doing so itself. */
  readonly #watchdog: Watchdog.Watchdog
  #finish!: (code: number) => void
  readonly finished: Promise<number>

  constructor(s: Settings) {
    this.#s = s
    this.#scope = {started: clock(), duration: s.timeout}
    this.#jev = new JevSession(s.client)
    this.#deps = {env: s.env, now: clock}
    this.finished = new Promise((r) => (this.#finish = r))
    this.#watchdog = Watchdog.watchdog([...s.self, '--RTS', '__session-reaper'])
  }

  /** What is left of the session, at most an hour (Scope.remaining with Time.max_timeout). */
  #remaining(): number {
    return Math.min(scopeRemaining(this.#scope, clock()), Core.MAX_TIMEOUT)
  }

  // -------------------------------------------------------------------------
  // Answers. Each accepted request gets exactly one.

  #ticket(id: Json): Ticket {
    Hub.accept(this.hub)
    let answered = false
    return (result) => {
      if (answered) throw new Error('serve: a request answered twice')
      answered = true
      println(Core.respond(id, result))
      Hub.answer(this.hub)
      this.#settle()
    }
  }

  #reply(id: Json, result: Result<string>): void {
    this.#ticket(id)(result)
  }

  #refuse(id: Json, error: Err): void {
    this.#reply(id, fail(error.code, error.message))
  }

  /** Runs a request's task; whatever it throws is its error answer. */
  #run(id: Json, task: () => Promise<Result<string>>): void {
    const ticket = this.#ticket(id)
    task().then(ticket, (e) => ticket(fail(1, e instanceof Error ? e.message : String(e))))
  }

  // -------------------------------------------------------------------------
  // CLI children.

  async #subprocess(plan: Result<Core.Call>): Promise<Result<string>> {
    if (!plan.ok) return plan
    const {argv, input, timeout, many} = plan.value
    return Core.outcome(await Process.capture(argv, input, timeout, Core.CAPTURE_MAX), many)
  }

  #plan(op: Core.Op, remaining: number): Result<Core.Call> {
    return Core.plan(this.#s.self, op, this.#s.defaults, remaining)
  }

  /** A CLI step: `watch` runs the monitor in process, every other one re-enters the executable. */
  #step(op: Core.Op, remaining: number): Promise<Result<string>> {
    return op.op === 'watch' ? this.#watch(op, remaining) : this.#subprocess(this.#plan(op, remaining))
  }

  /**
   * `watch`: the monitor's records for the requested (or default) time, cut
   * to the session less the grace, relayed as its CLI step's were (an array,
   * `[]` when the step failed without printing). The grace bounds it as it
   * bounded the CLI child: past it, the watch is cancelled.
   */
  async #watch(op: Extract<Core.Op, {op: 'watch'}>, remaining: number): Promise<Result<string>> {
    const ms = Core.inner(op.timeout, this.#s.defaults.watch, remaining)
    if (ms === 0) return fail(Core.EXPIRED.code, Core.EXPIRED.message)
    const lines: string[] = []
    const cancel = new AbortController()
    const timer = setTimeout(() => cancel.abort(), ms + Core.GRACE)
    this.#watches.add(cancel)
    try {
      const exit = await Monitor.watch(op.job, String(ms), op.literal, (line) => lines.push(line), cancel.signal)
      return Core.relayed(exit.code, lines, exit.error, true)
    } finally {
      clearTimeout(timer)
      this.#watches.delete(cancel)
    }
  }

  // -------------------------------------------------------------------------
  // Jev: one client, so evaluations run one at a time, in arrival order.

  async #evaluate(op: Extract<Core.Op, {op: 'jev' | 'decide'}>): Promise<Result<string>> {
    return this.#jev.use(async (client): Promise<[Client, Result<string>]> => {
      if (this.#remaining() <= Core.GRACE) return [client, fail(Core.EXPIRED.code, Core.EXPIRED.message)]
      const cap = op.timeout ?? Core.MAX_TIMEOUT
      try {
        if (op.op === 'decide') {
          const text = Codec.encodeWithLimit(op.request, Core.LINE_MAX)
          if (!text.ok) return [client, text]
          return Decision.encoded(await Decision.evaluateFor(this.#scope, client, text.value, op.credential, cap, this.#deps))
        }
        // Validated here for a precise error; the evaluation validates again before dispatch.
        const checked = Core.validated(op.request)
        if (!checked.ok) return [client, checked]
        return jevEncoded(await evaluateRequest(this.#scope, client, checked.value, cap, op.provider, op.credential, this.#deps))
      } catch (e) {
        // A client lost to an unexpected failure: its budget is treated as spent.
        const {settings, budget, key} = client
        return [JevPolicy.client(settings, {...budget, remaining: 0}, key), fail(1, e instanceof Error ? e.message : String(e))]
      }
    })
  }

  // -------------------------------------------------------------------------
  // Session children.

  /** Applies a feeder's effects for one child. */
  #effects(child: ChildIO, effects: Hub.Effect<Ticket>[]): void {
    for (const fx of effects) {
      if (fx.e === 'close') {
        closeFd(child.fd)
        child.fd = -1
      } else if (fx.e === 'respond') {
        Hub.fed(this.hub, child.dir)
        fx.id(fx.error ? fail(fx.error.code, fx.error.message) : done(Core.writeJson(child.id, fx.bytes, fx.closed)))
      } else {
        // A write runs on its own, so a child that is not reading never holds up a stop.
        const bytes = Core.utf8Bytes(fx.text)
        const ticket = fx.id
        writeAll(child.fd, fx.text).then(
          (ok) => this.#effects(child, Hub.wrote(child.feeder, ticket, ok, bytes)),
          () => this.#effects(child, Hub.wrote(child.feeder, ticket, false, bytes)),
        )
      }
    }
  }

  /** A stop is applied when it arrives: the marker, then the child is stopped, and the answer is its receipt. */
  async #stop(child: ChildIO): Promise<Result<string>> {
    const marked = Host.put(child.dir, 'stop', 'stop')
    if (!marked.ok) return marked
    child.child.stop()
    return this.#subprocess(this.#plan({op: 'wait', job: child.dir, timeout: 3000}, this.#remaining()))
  }

  /** The time left for a session child: the connection's, less the receipt grace, within a day. */
  #childLeft(): number {
    return Core.left(TimeCore.cap(scopeRemaining(this.#scope, clock()), TimeCore.jobMax))
  }

  /**
   * Spawns a session child: its directory and meta, then its supervision in
   * this process (src/jobs/session.ts), answered once it has announced
   * itself (`ready`). The child counts toward the bound from the moment its
   * directory exists, until its receipt is published.
   */
  #spawn(id: Json, op: Extract<Core.Op, {op: 'spawn'}>): void {
    if (!Hub.room(this.hub)) this.#refresh()
    if (!Hub.room(this.hub)) return this.#refuse(id, Core.TOO_MANY_CHILDREN)
    const lifetime = Core.childLifetime(op.timeout, this.#childLeft())
    const ticket = this.#ticket(id)
    if (op.cwd !== '' && !Host.directory(op.cwd).ok) return ticket(fail(2, 'cwd must be an existing directory'))
    const made = Host.make(Jobs.maxJobs)
    if (!made.ok) return ticket(made)
    const dir = made.value
    Hub.starting(this.hub, dir)
    const failed = (r: Result<string>) => {
      Hub.exited(this.hub, dir)
      ticket(r)
    }
    const meta = JobsCore.meta(op.label, Host.clock(), 'session', op.pipe)
    const put = Host.put(dir, 'meta.json', meta)
    if (!put.ok) return failed(put)
    const started = SessionChildren.start(dir, meta, op.argv, lifetime, op.cwd, op.pipe, {
      spawned: (pid) => {
        Hub.spawned(this.hub, dir)
        this.#watchdog.add(pid, dir)
      },
      reaped: (pid) => {
        Hub.reaped(this.hub, dir)
        this.#watchdog.remove(pid, dir)
      },
    })
    if (!started.ok) return failed(started)
    if (started.value === null) {
      Host.put(dir, 'stop', 'stop')
      Hub.exited(this.hub, dir)
      return ticket(fail(Core.NOT_STARTED.code, Core.NOT_STARTED.message))
    }
    const supervised = started.value
    const child: ChildIO = {dir, id: `s-${dir}`, fd: supervised.input, feeder: Hub.feeder<Ticket>(op.pipe), child: supervised}
    this.#children.set(dir, child)
    Hub.ready(this.hub, dir)
    void supervised.ended.then(() => {
      // Its receipt is published, its group reaped and its lease released.
      Hub.exited(this.hub, dir)
      this.#settle()
    })
    ticket(done(JobsCore.running(dir, meta)))
  }

  /** Children whose receipt is published no longer run, though their supervision may not have wound up yet. */
  #refresh(): void {
    for (const [dir, c] of this.hub.children) {
      if (!c.live || c.finished) continue
      const receipt = Host.read(dir, 'receipt.json', Jobs.spoolLimit)
      if (receipt.ok && receipt.value !== '') Hub.finished(this.hub, dir)
    }
  }

  /** The connection ends for this child: its stdin closes once its feeder is idle, and it is stopped. */
  #endChild(child: ChildIO): void {
    this.#effects(child, Hub.ending(child.feeder))
    Host.put(child.dir, 'stop', 'stop')
    child.child.stop()
  }

  // -------------------------------------------------------------------------
  // Dispatch.

  /** A request addressed to one of this connection's session children. */
  #sessionRequest(id: Json, op: Core.Op, dir: string, remaining: number): void {
    const child = this.#children.get(dir)
    if (!child || !Hub.addressed(this.hub, dir)) return this.#refuse(id, Core.UNKNOWN_CHILD)
    switch (op.op) {
      case 'write':
      case 'closeInput': {
        if (!Hub.queue(this.hub, dir)) return this.#refuse(id, Core.TOO_MANY_PENDING)
        const ticket = this.#ticket(id)
        const item: Hub.Item<Ticket> = op.op === 'write' ? {kind: 'write', id: ticket, text: op.text} : {kind: 'close', id: ticket}
        return this.#effects(child, Hub.arrive(child.feeder, item))
      }
      case 'stop': {
        if (!Hub.queue(this.hub, dir)) return this.#refuse(id, Core.TOO_MANY_PENDING)
        this.#run(id, () => this.#stop(child))
        return Hub.fed(this.hub, dir)
      }
      case 'read':
        return this.#run(id, () => Spool.read(dir, op.stream, op.offset, op.max, Core.inner(op.wait, 0, remaining), op.base64))
      default:
        return this.#run(id, () => this.#step(Core.retarget(op, dir), remaining))
    }
  }

  /** Requests that name no session child. */
  async #unaddressed(id: Json, op: Core.Op, remaining: number): Promise<void> {
    switch (op.op) {
      case 'validate':
        return this.#reply(id, Core.validated(op.request))
      case 'decisionProviders':
        return this.#reply(id, Codec.encode(DecisionConfig.providers()))
      case 'resolveDecision': {
        const ticket = this.#ticket(id)
        const text = Codec.encodeWithLimit(op.request, Core.LINE_MAX)
        return ticket(text.ok ? await Targets.offline(text.value, this.#s.env) : text)
      }
      case 'validateDecision':
        return this.#reply(id, Core.validatedDecision(op.request))
      case 'capabilities':
        return this.#reply(id, done(Core.capabilities(VERSION, this.#s.platform)))
      case 'jev':
      case 'decide':
        return this.#run(id, () => this.#evaluate(op))
      case 'spawn':
        return this.#spawn(id, op)
      case 'list':
        if (op.sessions) return this.#reply(id, done(JobsCore.listJson(Jobs.inspectAll(Hub.started(this.hub), true), false)))
        return this.#run(id, () => this.#subprocess(this.#plan(op, remaining)))
      // An interactive job's input is queued here, so writes and closes apply in arrival order.
      case 'write':
        return this.#reply(id, Spool.queueWrite(op.job, op.text, false))
      case 'closeInput':
        return this.#reply(id, Spool.queueWrite(op.job, '', true))
      case 'read':
        return this.#run(id, () => Spool.read(op.job, op.stream, op.offset, op.max, Core.inner(op.wait, 0, remaining), op.base64))
      default:
        return this.#run(id, () => this.#step(op, remaining))
    }
  }

  async #line(bytes: Uint8Array): Promise<void> {
    if (!Hub.serving(this.hub) || bytes.length === 0) return
    const value = Core.readLine(bytes)
    if (!value.ok) return this.#refuse(NULL, value.error)
    const id = Core.id(value.value)
    const op = Core.request(value.value)
    if (!op.ok) return this.#refuse(id, op.error)
    // The session deadline is checked before each request.
    const remaining = this.#remaining()
    if (remaining <= Core.GRACE) {
      this.#refuse(id, Core.EXPIRED)
      return this.#end(Core.EXPIRED.code, Core.EXPIRED.message)
    }
    const target = Core.sessionTarget(op.value)
    if (target !== null) return this.#sessionRequest(id, op.value, target.slice(2), remaining)
    return this.#unaddressed(id, op.value, remaining)
  }

  /** Answers lines in arrival order; offline answers that take IO hold up the lines after them only. */
  lines(lines: Uint8Array[]): Promise<void> {
    for (const l of lines) this.#chain = this.#chain.then(() => this.#line(l)).catch((e) => printErr(`serve: ${e instanceof Error ? e.message : String(e)}`))
    return this.#chain
  }

  /** End of input (or an oversized line, or the read limit): answer what is left, then end. */
  closed(code: number, message: string, last: Uint8Array[]): Promise<void> {
    void this.lines(last)
    this.#chain = this.#chain.then(() => this.#end(code, message))
    return this.#chain
  }

  // -------------------------------------------------------------------------
  // Ending: stop the session children, let every request in flight answer,
  // force stragglers after 3 s, then remove the children's directories.

  #end(code: number, message: string): void {
    if (!Hub.end(this.hub, code, message)) return
    for (const child of this.#children.values()) this.#endChild(child)
    this.#force = setTimeout(() => {
      Process.cancel()
      for (const w of this.#watches) w.abort()
    }, 3000)
    this.#settle()
  }

  #settle(): void {
    if (this.hub.concluded || !Hub.conclude(this.hub)) return
    if (this.#force) clearTimeout(this.#force)
    // Every child has been reaped: the watchdog has nothing left to stop, and exits.
    this.#watchdog.close()
    // Session children are unaddressable once their connection has ended, so their directories go with it.
    for (const dir of Hub.started(this.hub)) Host.remove(dir)
    this.#finish(this.hub.ending!.code)
  }
}

// ---------------------------------------------------------------------------
// The reader: frames stdin into lines for the hub, 64 KiB at a time.

async function read(session: Session): Promise<void> {
  let f = Core.framer()
  let reads = 0
  const stream = Bun.stdin.stream()
  const reader = stream.getReader()
  void session.finished.then(() => reader.cancel().catch(() => {}))
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch {
        return void session.closed(1, 'serve could not read its input', [])
      }
      if (chunk.done) return void session.closed(0, '', Core.last(f))
      const bytes = chunk.value
      for (let at = 0; at < bytes.length; at += Core.READ_CHUNK) {
        if (++reads > Core.READS_MAX) return void session.closed(1, 'serve read limit reached; start a new session', [])
        const framed = Core.frame(f, bytes.subarray(at, at + Core.READ_CHUNK))
        f = framed.framer
        void session.lines(framed.lines)
        // A partial line longer than any valid request cannot be answered: the session ends instead of resynchronizing.
        if (Core.overflowed(f)) {
          const message = 'request line exceeds 16 MiB'
          await session.lines([])
          println(Core.respond(NULL, fail(2, message)))
          return void session.closed(2, message, [])
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Launch.

const fatal = (e: Err): number => {
  printErr(e.message)
  return e.code
}

/**
 * Serve.serve: a session of `timeout` ms with `[max-evaluations
 * [max-tokens]]` in `args`. Resolves to the exit code once the session has
 * ended; a nonzero code's message has been written to stderr.
 */
export async function serve(timeout: number, args: readonly string[]): Promise<number> {
  const budget = Core.budget(args)
  if (!budget.ok) return fatal(budget.error)
  const [calls, tokens] = budget.value
  const client = Jev.connect(calls, tokens, process.env)
  if (!client.ok) return fatal(client.error)
  const work = Time.work()
  if (!work.ok) return fatal(work.error)
  const wait = Time.wait()
  if (!wait.ok) return fatal(wait.error)
  const watch = Time.watch()
  if (!watch.ok) return fatal(watch.error)
  // serve reads its inherited stdin: one it does not have fails before the banner.
  const input = Process.stdin()
  if (!input.ok) return fatal(input.error)
  closeFd(input.value)
  Process.installSignalScope()
  const platform = Host.platform()
  const session = new Session({
    timeout,
    calls,
    tokens,
    client: client.value,
    self: Jobs.selfArgv(),
    defaults: {work: work.value, wait: wait.value, watch: watch.value},
    platform,
    env: process.env,
  })
  println(Core.banner(VERSION, platform, timeout, calls, tokens))
  void read(session)
  const code = await session.finished
  if (code !== 0) printErr(session.hub.ending!.message)
  return code
}

/**
 * `serve` as the CLI dispatches it (main.bend's `serve <timeout> rest`):
 * `args` are `[timeout-ms, max-evaluations?, max-tokens?]`, the timeout
 * already chosen by the CLI's parser (--timeout-ms, else
 * JEV_FABRIC_TIMEOUT_MS, else an hour). Resolves to the exit code; a
 * nonzero code's message is already on stderr. The caller exits with it.
 */
export async function serveMain(args: string[]): Promise<number> {
  const ms = Core.deadline(args[0])
  if (!ms.ok) return fatal(ms.error)
  return serve(ms.value, args.slice(1))
}
