// `run`'s arguments (the `run` path through native/Cli.bend, then
// native/Runner.bend's check), pure. The options and errors are 0.8.1's,
// in 0.8.1's order: prefix options up to the program, a legacy positional
// timeout, the work default, then the program path. Only the last check
// changed: the program is now a TypeScript or JavaScript file, and a .bend
// source gets a pointer at the migration instead.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as TimeCore from '../time/core.ts'

export const MAX = 3600000

/** What Jobs.command printed when canonical `run <ms>` had no program (0.8.1 fell through to it). */
export const JOB_USAGE =
  'usage: start <timeout-ms> <command> [args...] | status <id>' +
  ' | events <id> [after-sequence] | wait <id> <wait-timeout-ms> | stop <id>' +
  ' | follow <timeout-ms> <id> [after-sequence] | list' +
  ' | write <id> (--stdin | -- text...) | close-input <id>' +
  ' | read [--wait-ms N] [--base64] <id> <stdout|stderr> [offset] [max]'

export const PROGRAM_ERROR = 'run requires 1..3600000 ms and a .ts or .js program path (not an option)'
export const BEND_ERROR = 'run executes TypeScript or JavaScript programs; Bend programs are no longer supported (see docs/bend-to-typescript.md)'

/** Program files Bun runs directly. */
export const isProgram = (path: string): boolean => /\.(?:[mc]?[jt]s|[jt]sx)$/.test(path)

export type Plan = {timeout: number; program: string; args: string[]}

const digits = (s: string) => s !== '' && /^[0-9]+$/.test(s)

function unique(previous: number | null, value: number): Result<number> {
  return previous === null ? done(value) : fail(2, 'specify the timeout only once')
}

type Prefix = {rest: string[]; timeout: number | null; literal: boolean}

/** Cli.options for `run`: --timeout-ms only; the launch options of exec and start are refused by name. */
function options(args: readonly string[]): Result<Prefix> {
  let timeout: number | null = null
  for (let i = 0; ; ) {
    const a = args[i]
    const next = args[i + 1]
    const more = i + 1 < args.length
    if (a === undefined) return done({rest: [], timeout, literal: false})
    if (a === '--timeout-ms') {
      if (!more) return fail(2, '--timeout-ms requires milliseconds')
      const value = TimeCore.parse(next!, MAX)
      if (!value.ok) return value
      const chosen = unique(timeout, value.value)
      if (!chosen.ok) return chosen
      timeout = chosen.value
      i += 2
    } else if (a === '--label') return fail(2, more ? '--label is supported for start only' : '--label requires text')
    else if (a === '--cwd') return fail(2, more ? '--cwd is supported for exec and start only' : '--cwd requires a directory')
    else if (a === '--input') return fail(2, more ? '--input is supported for start only' : '--input takes pipe')
    else if (a === '--stdin') return fail(2, '--stdin is supported once, for exec only')
    else if (a === '--') return done({rest: args.slice(i + 1), timeout, literal: true})
    else if (a.startsWith('-')) return fail(2, 'unknown option; use -- before a literal command')
    else return done({rest: args.slice(i), timeout, literal: false})
  }
}

/**
 * The words after `run`, and the configured work default (JEV_FABRIC_TIMEOUT_MS
 * as Time.work() read it), into one plan or 0.8.1's refusal.
 */
export function parse(args: readonly string[], work: () => Result<number>): Result<Plan> {
  const prefix = options(args)
  if (!prefix.ok) return prefix
  let {rest, timeout} = prefix.value
  if (!rest.length) return fail(2, 'command or file is required')
  // Cli.launch: an unescaped all-digit first word is the legacy timeout.
  if (!prefix.value.literal && digits(rest[0]!)) {
    const value = TimeCore.parse(rest[0]!, MAX)
    if (!value.ok) return value
    const chosen = unique(timeout, value.value)
    if (!chosen.ok) return chosen
    timeout = chosen.value
    rest = rest.slice(1)
  }
  if (timeout === null) {
    const configured = work()
    if (!configured.ok) return configured
    timeout = configured.value
  }
  if (!rest.length) return fail(2, JOB_USAGE)
  const program = rest[0]!
  if (!(timeout >= 1 && timeout <= MAX) || program.startsWith('-')) return fail(2, PROGRAM_ERROR)
  if (program.endsWith('.bend')) return fail(2, BEND_ERROR)
  if (!isProgram(program)) return fail(2, PROGRAM_ERROR)
  return done({timeout, program, args: rest.slice(1)})
}
