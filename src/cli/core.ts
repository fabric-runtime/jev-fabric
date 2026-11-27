// The command line (native/Cli.bend): public conveniences normalized into
// the stable positional argument lists the verbs take. Only a prefix is
// parsed; after the command or file every argument stays literal. Pure.
//
//   parse(args, decisions?)              -> Plan, or {code, message} to die with
//   canonical(command, args, ms, input, launch) -> the dispatcher's argument list
//   defaultTimeout(command)              -> which configured limit a verb falls back to
//
// One leading "--" is dropped, so `jev-fabric -- <command>` and
// `jev-fabric <command>` are the same call.

import {quote} from '../codec/print.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {cpLength} from '../codec/text.ts'
import type {Arguments} from '../decision/cli-core.ts'
import {labelChecked} from '../jobs/core.ts'
import * as Time from '../time/core.ts'

// ---------------------------------------------------------------------------
// Version and capabilities.

/** Host.platform: `darwin-arm64`, `linux-x64`, ... from the runtime's names. */
export function platformOf(platform: string, arch: string): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : 'unknown'
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : 'unknown'
  return `${os}-${cpu}`
}

/** The release. 0.8.1 was the last Bend build; 0.9.0 is the first TypeScript one. */
export const RELEASE = '0.9.0'
/**
 * The version every machine-readable surface reports (capabilities, the serve
 * banner): the release with the `-native` suffix 0.8.1 had, which clients and
 * the conformance suite match as `^\d+\.\d+\.\d+-native$`.
 */
export const VERSION = `${RELEASE}-native`
/**
 * `--version`: VERSION, then the runtime and platform in parentheses where
 * 0.8.1 printed `(Bend 2.0.38)`, e.g. `0.9.0-native (Bun 1.3.5; darwin-arm64)`.
 * The first word stays the capabilities version.
 */
export const versionLine = (runtime: string, platform: string) => `${VERSION} (${runtime}; ${platform})`

export const PROTOCOL = 2
export const STORE = 1
/** What a host may rely on, in the order 0.8.1 advertised; later releases only append. */
export const FEATURES = [
  'follow',
  'list',
  'label',
  'start-24h',
  'serve-24h',
  'serve-concurrent',
  'sessions',
  'cwd',
  'durable-input',
  'read',
  'jev-request-credential',
  'decisions',
  'decision-targets',
] as const

export const featuresJson = () => `[${FEATURES.map(quote).join(',')}]`

/** ServeCore.capability_fields: what a host needs to choose a binary without guessing from its version. */
export const capabilityFields = (version: string, platform: string) =>
  `"version":${quote(version)},"protocol":${PROTOCOL},"store":${STORE},"platform":${quote(platform)},"features":${featuresJson()}`

/** ServeCore.capabilities: the `capabilities` verb's one line. */
export const capabilities = (version: string, platform: string) => `{${capabilityFields(version, platform)}}`

// ---------------------------------------------------------------------------
// Usage.

/**
 * What `--help` or no command prints (exit 0): 0.8.1's text, but for the two
 * clauses that described the Bend build (its first line and "pooled system
 * libcurl").
 */
export const USAGE =
  'jev-fabric native (TypeScript on Bun)\n' +
  'usage: jev-fabric -- <command>\n' +
  '  exec [--timeout-ms N] [--stdin] [--cwd DIR] [--] <command> [args...]\n' +
  '  run [--timeout-ms N] [--] <program.ts|.js> [args...]\n' +
  '  validate <request.json>\n' +
  '  jev [--timeout-ms N] <request.json> [max-tokens]\n' +
  '  decide [--timeout-ms N] [target flags] <request.json> [max-tokens]\n' +
  '  validate-decision <request.json>\n' +
  '  resolve-decision [target flags] <request.json> (offline preflight)\n' +
  '  target flags: --provider --model --profile --api --endpoint (each takes a value)\n' +
  '  decision-providers (registered endpoints and capabilities, without credentials)\n' +
  '  start [--timeout-ms N] [--label TEXT] [--cwd DIR] [--] <command> [args...]\n' +
  '  status <id> | list | events [--timeout-ms N] <id> [after-sequence]\n' +
  '  follow [--timeout-ms N] <id> [after-sequence] (live JSONL events)\n' +
  '  watch [--timeout-ms N] <id> <literal>\n' +
  '  wait [--timeout-ms N] <id> | stop <id>\n' +
  '  serve [--timeout-ms N] [max-evaluations [max-tokens]] (JSONL session on stdin/stdout)\n' +
  '  capabilities (version, protocol, store format, platform and features, as JSON)\n' +
  '  update (reinstall the latest release via curl | sh)\n' +
  'Defaults: work 1h, Jev 30s, wait 30s, follow 30s, watch 5s; start and serve allow up to 24h.\n' +
  'Timers are ceilings, not delays.\n' +
  'Configure JEV_FABRIC_TIMEOUT_MS, JEV_FABRIC_JEV_TIMEOUT_MS, JEV_FABRIC_WAIT_MS, JEV_FABRIC_WATCH_MS.\n' +
  'Legacy positional milliseconds remain supported. Prefix options stop at the command/file; -- escapes numeric command names.\n' +
  'Native trusted code, not a sandbox. Shell interpretation is explicit.\n' +
  'Jev uses provider environment credentials or JEV_CREDENTIAL_COMMAND,' +
  ' HTTPS through the runtime (JEV_FABRIC_HTTP=exec: one curl per request),' +
  ' and no automatic retries.'

// ---------------------------------------------------------------------------
// Plans.

/**
 * What a launch carries besides its timer: a job label, the directory the
 * command starts in ("" inherits the caller's) and whether its stdin stays
 * open for `write` (`start --input pipe`).
 */
export type Launch = {label: string; cwd: string; pipe: boolean}
export const plain = (): Launch => ({label: '', cwd: '', pipe: false})

/**
 * A verb with a timer (chosen now, or `null` for its configured default) or
 * one passed through unchanged.
 */
export type Plan =
  | {k: 'timed'; command: string; args: string[]; timeout: number | null; input: boolean; launch: Launch}
  | {k: 'pass'; args: string[]}

const timed = (command: string, args: string[], timeout: number | null, input = false, launch: Launch = plain()): Plan => ({
  k: 'timed',
  command,
  args,
  timeout,
  input,
  launch,
})

/** Thrown inside the parser and caught once by parse(), as the Bend `do` blocks failed. */
class Refused {
  readonly code: number
  readonly message: string
  constructor(code: number, message: string) {
    this.code = code
    this.message = message
  }
}
const refuse = (message: string, code = 2): never => {
  throw new Refused(code, message)
}
const must = <T>(r: Result<T>): T => (r.ok ? r.value : refuse(r.error.message, r.error.code))

/** The ceiling a timer for `command` may be set to. */
export function max(command: string): number {
  if (command === 'watch' || command === 'events') return 300000
  if (command === 'start' || command === 'serve') return Time.jobMax
  return 3600000
}

const unique = (previous: number | null, value: number): number => (previous === null ? value : refuse('specify the timeout only once'))

function inputAllowed(allowed: boolean, duplicate: boolean) {
  if (!allowed || duplicate) refuse('--stdin is supported once, for exec only')
}

function labelOnce(allowed: boolean, previous: string | null, value: string): string {
  if (!allowed) refuse('--label is supported for start only')
  if (previous !== null) refuse('specify the label only once')
  return must(labelChecked(value))
}

/** A working directory is an absolute path of at most 4096 characters; whether it exists is checked when the command starts. */
export const CWD_MAX = 4096
export const cwdChecked = (path: string): Result<string> =>
  path.startsWith('/') && cpLength(path) <= CWD_MAX ? done(path) : fail(2, 'cwd must be an absolute path')

function cwdOnce(allowed: boolean, previous: string | null, value: string): string {
  if (!allowed) refuse('--cwd is supported for exec and start only')
  if (previous !== null) refuse('specify the cwd only once')
  return must(cwdChecked(value))
}

/** `--input pipe` keeps a `start` job's stdin open; it is the only input mode. */
function pipeOnce(allowed: boolean, previous: boolean, value: string): boolean {
  if (!allowed) refuse('--input is supported for start only')
  if (previous) refuse('specify the input only once')
  return value === 'pipe' || refuse('--input takes pipe')
}

type Options = {args: string[]; timeout: number | null; input: boolean; literal: boolean; label: string | null; cwd: string | null; pipe: boolean}

/** The prefix options, up to the command or file (or a `--` that makes it literal). */
function options(args: string[], allowInput: boolean, allowLabel: boolean, allowCwd: boolean, limit: number): Options {
  let timeout: number | null = null
  let label: string | null = null
  let cwd: string | null = null
  let pipe = false
  let input = false
  let i = 0
  const rest = (literal: boolean): Options => ({args: args.slice(i), timeout, input, literal, label, cwd, pipe})
  for (;;) {
    const first = args[i]
    if (first === undefined) return rest(false)
    const value = args[i + 1]
    if (first === '--timeout-ms') {
      if (value === undefined) refuse('--timeout-ms requires milliseconds')
      timeout = unique(timeout, must(Time.parse(value!, limit)))
      i += 2
    } else if (first === '--label') {
      if (value === undefined) refuse('--label requires text')
      label = labelOnce(allowLabel, label, value!)
      i += 2
    } else if (first === '--cwd') {
      if (value === undefined) refuse('--cwd requires a directory')
      cwd = cwdOnce(allowCwd, cwd, value!)
      i += 2
    } else if (first === '--input') {
      if (value === undefined) refuse('--input takes pipe')
      pipe = pipeOnce(allowLabel, pipe, value!)
      i += 2
    } else if (first === '--stdin') {
      inputAllowed(allowInput, input)
      input = true
      i += 1
    } else if (first === '--') {
      i += 1
      return rest(true)
    } else if (first.startsWith('-')) {
      return refuse('unknown option; use -- before a literal command')
    } else {
      return rest(false)
    }
  }
}

/** Bend's Char.is_digit over a whole (nonempty) word. */
const numeric = (text: string) => /^[0-9]+$/.test(text)

/** Legacy positional syntax carries the timeout as a bare millisecond argument. */
function legacy(command: string, args: string[], timeout: number | null, input: boolean, launch: Launch, raw: string): Plan {
  const ms = unique(timeout, must(Time.parse(raw, max(command))))
  if (command !== 'exec') return timed(command, args, ms, input, launch)
  // A legacy exec takes `--stdin` after its milliseconds, and (as 0.8.1 did)
  // starts with a plain launch: a prefix --cwd does not carry over.
  if (args[0] === '--stdin') {
    inputAllowed(true, input)
    return timed('exec', args.slice(1), ms, true)
  }
  return timed('exec', args, ms, input)
}

function launch(command: string, args: string[], timeout: number | null, input: boolean, literal: boolean, with_: Launch): Plan {
  const first = args[0]
  if (first === undefined) return refuse('command or file is required')
  if (!literal && numeric(first)) return legacy(command, args.slice(1), timeout, input, with_, first)
  return timed(command, args, timeout, input, with_)
}

function waitArgs(args: string[], timeout: number | null): Plan {
  if (args.length === 1) return timed('wait', [args[0]!], timeout)
  if (args.length === 2) return legacy('wait', [args[0]!], timeout, false, plain(), args[1]!)
  return refuse('usage: wait [--timeout-ms N] <id> [legacy-ms]')
}

function watchArgs(args: string[], timeout: number | null): Plan {
  if (args.length === 2) return timed('watch', [args[0]!, args[1]!], timeout)
  if (args.length === 3) return legacy('watch', [args[0]!, args[2]!], timeout, false, plain(), args[1]!)
  return refuse('usage: watch [--timeout-ms N] <id> <literal>')
}

function followArgs(args: string[], timeout: number | null): Plan {
  if (args.length === 1 || args.length === 2) return timed('follow', args, timeout)
  return refuse('usage: follow [--timeout-ms N] <id> [after-sequence]')
}

/**
 * Without --timeout-ms, events stays an immediate snapshot. With it, events
 * waits up to that long for an event past the cursor or a terminal receipt.
 */
function eventsArgs(args: string[], timeout: number | null): Plan {
  if (args.length === 1 || args.length === 2) {
    if (timeout === null) return {k: 'pass', args: ['events', ...args]}
    return timed('events', [args[0]!, args[1] ?? '0'], timeout)
  }
  return refuse('usage: events [--timeout-ms N] <id> [after-sequence]')
}

function selected(command: string, o: Options): Plan {
  if (command === 'wait') return waitArgs(o.args, o.timeout)
  if (command === 'watch') return watchArgs(o.args, o.timeout)
  if (command === 'follow') return followArgs(o.args, o.timeout)
  if (command === 'events') return eventsArgs(o.args, o.timeout)
  if (command === 'serve') return timed('serve', o.args, o.timeout)
  return launch(command, o.args, o.timeout, o.input, o.literal, {label: o.label ?? '', cwd: o.cwd ?? '', pipe: o.pipe})
}

/** Commands that accept timeout options; every other command passes through unchanged. */
export const TIMED = ['exec', 'run', 'start', 'jev', 'decide', 'wait', 'watch', 'follow', 'events', 'serve'] as const
export const acceptsTimeout = (command: string) => (TIMED as readonly string[]).includes(command)

function parseTimed(command: string, args: string[]): Plan {
  const exec = command === 'exec'
  const start = command === 'start'
  return selected(command, options(args, exec, start, exec || start, max(command)))
}

/**
 * DecisionCli.parse (src/decision/cli-core.ts), handed in so the decision
 * modules load only for `decide` and `resolve-decision`.
 */
export type DecisionParse = (args: readonly string[], offline: boolean) => Result<Arguments>

/** Whether parse() needs a DecisionParse for these arguments. */
export function needsDecisions(args: readonly string[]): boolean {
  const command = args[0] === '--' ? args[1] : args[0]
  return command === 'decide' || command === 'resolve-decision'
}

function parseCommand(args: string[], decisions?: DecisionParse): Plan {
  const [command, ...rest] = args
  if (command === undefined) return {k: 'pass', args: []}
  if (command === 'decide' || command === 'resolve-decision') {
    if (!decisions) throw new Error('parse: decide needs the decision parser')
    const d = must(decisions(rest, command === 'resolve-decision'))
    return timed(command, [d.path, d.tokens, d.overrides], d.timeout)
  }
  if (!acceptsTimeout(command)) return {k: 'pass', args}
  return parseTimed(command, rest)
}

/**
 * Cli.parse: one leading "--" is dropped (Bend 2.0.37 runtimes removed it
 * before the program saw its arguments; 0.8.1 dropped it itself).
 */
export function parse(args: readonly string[], decisions?: DecisionParse): Result<Plan> {
  try {
    return done(parseCommand(args[0] === '--' ? args.slice(1) : [...args], decisions))
  } catch (e) {
    if (e instanceof Refused) return fail(e.code, e.message)
    throw e
  }
}

// ---------------------------------------------------------------------------
// The dispatcher's argument lists.

/** The worker mode `start` hands the dispatcher. */
export const launchMode = (l: Launch) => (l.pipe ? 'pipe' : 'batch')

/**
 * Cli.canonical: what the dispatcher receives once the timer is chosen.
 * `start` always reaches it as `__start <ms> <label> <cwd> <mode> <command...>`,
 * with an empty label or cwd for none, so a command named like an option stays
 * literal. (`exec` is run directly by the CLI; its list is kept for parity.)
 */
export function canonical(command: string, args: readonly string[], ms: number, input: boolean, l: Launch): string[] {
  const t = String(ms)
  if (command === 'exec') return ['exec', t, ...(input ? ['--stdin'] : []), ...args]
  if (command === 'start') return ['__start', t, l.label, l.cwd, launchMode(l), ...args]
  if (command === 'wait') return args.length ? ['wait', args[0]!, t] : ['wait']
  if (command === 'watch') return args.length ? ['watch', args[0]!, t, ...args.slice(1)] : ['watch']
  if (command === 'events') return args.length >= 2 ? ['events', args[0]!, args[1]!, t] : ['events']
  return [command, t, ...args]
}

/** Which configured limit a verb without --timeout-ms falls back to. */
export type Default = 'jev' | 'wait' | 'watch' | 'work'
export function defaultTimeout(command: string): Default {
  if (command === 'jev' || command === 'decide') return 'jev'
  if (command === 'wait' || command === 'follow') return 'wait'
  if (command === 'watch') return 'watch'
  return 'work'
}

// ---------------------------------------------------------------------------
// `update` reinstalls the latest release the way `bend update` did: it shows
// the exact command, runs it, and exits with its status. JEV_FABRIC_PREFIX and
// JEV_FABRIC_VERSION pass through to the installer.

export const UPDATE_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh | sh'
/** Ten minutes covers a slow download; the installer itself takes seconds. */
export const UPDATE_TIMEOUT = 600000
