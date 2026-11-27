// The CLI driver (native/main.bend): parse the arguments (./core.ts), choose
// each timer, and run the verb, writing what 0.8.1 printed and resolving to
// the exit code. `run` takes its words as typed (runMain parses them);
// `serve` takes the canonical `<ms> [max-evaluations [max-tokens]]`. Every
// verb's modules load on first use, so each verb starts with only what it
// runs.

import type {Err, Result} from '../codec/result.ts'
import {died} from '../codec/result.ts'
import {trimEnd} from '../codec/text.ts'
import * as Time from '../time/time.ts'
import type {Launch, Plan} from './core.ts'
import * as Cli from './core.ts'
import * as Io from './io.ts'

/** Where a verb's output goes: stdout and stderr text, written whole. */
export type Sink = {stdout: (text: string) => void; stderr: (text: string) => void}
export const processSink: Sink = {stdout: Io.stdout, stderr: Io.stderr}

type Outcome = {stdout: string; stderr: string; exit: number}

/** IO.die: the message on stderr, the code as the status (0..255, as died() maps it). */
function die(sink: Sink, e: Err): number {
  const d = died(e)
  sink.stderr(d.stderr)
  return d.exit
}

function printed(sink: Sink, o: Outcome): number {
  sink.stdout(o.stdout)
  sink.stderr(o.stderr)
  return o.exit
}

/** A verb that printed lines through `out` and ended with {code, error?}. */
function ended(sink: Sink, exit: {code: number; error?: string}): number {
  return exit.error === undefined ? exit.code : die(sink, {code: exit.code, message: exit.error})
}

const lines = (sink: Sink) => (line: string) => sink.stdout(`${line}\n`)

/** main.finish: a nonzero status ends the verb with it. */
const finish = (sink: Sink, code: number) => (code === 0 ? 0 : die(sink, {code, message: 'subprocess did not complete successfully'}))

/** An empty cwd inherits this process's; any other must be an existing directory. */
async function execute(sink: Sink, argv: string[], ms: number, inheritStdin: boolean, cwd: string): Promise<number> {
  if (cwd !== '' && !(await import('../store/host.ts')).directory(cwd).ok) return die(sink, {code: 2, message: 'cwd must be an existing directory'})
  const r = await (await import('../proc/process.ts')).runIn(argv, '', ms, inheritStdin, cwd)
  if (!r.ok) return die(sink, r.error)
  sink.stdout(`${(await import('../proc/report.ts')).show(r.value)}\n`)
  return finish(sink, r.value.code)
}

/** `update`: shows the installer command on stderr, runs it, relays its output and status. */
async function update(sink: Sink): Promise<number> {
  sink.stderr(`${Cli.UPDATE_COMMAND}\n`)
  const r = await (await import('../proc/process.ts')).runInput(['/bin/sh', '-c', Cli.UPDATE_COMMAND], '', Cli.UPDATE_TIMEOUT)
  if (!r.ok) return die(sink, r.error)
  sink.stdout(r.value.stdout)
  if (r.value.stderr !== '') sink.stderr(`${trimEnd(r.value.stderr)}\n`)
  return finish(sink, r.value.code)
}

/** The runtime `--version` names: Bun and its version. */
const runtime = () => `Bun ${typeof Bun === 'undefined' ? process.versions.bun : Bun.version}`

const jevDeps = () => ({env: process.env})

const jobs = async (sink: Sink, args: string[]) => ended(sink, await (await import('../jobs/jobs.ts')).command(args, lines(sink)))

const platform = () => Cli.platformOf(process.platform, process.arch)

/** main.dispatch_legacy, after the decision verbs. */
async function legacy(sink: Sink, args: string[]): Promise<number> {
  const [verb, a, b, c, d] = args
  const n = args.length
  if (n === 0 || (verb === '--help' && n === 1)) return sink.stdout(`${Cli.USAGE}\n`), 0
  if (verb === '--version' && n === 1) return sink.stdout(`${Cli.versionLine(runtime(), platform())}\n`), 0
  if (verb === 'update' && n === 1) return update(sink)
  if (verb === 'capabilities' && n === 1) return sink.stdout(`${Cli.capabilities(Cli.VERSION, platform())}\n`), 0
  if (verb === 'watch') return ended(sink, await (await import('../monitor/monitor.ts')).command(args, lines(sink)))
  if (verb === 'serve' && n >= 2) return (await import('../serve/index.ts')).serveMain(args.slice(1))
  if (verb === 'validate' && n === 2) return printed(sink, await (await import('../jev/cli.ts')).validateFile(a!))
  if (verb === 'decide' && n === 5) return printed(sink, await (await import('../decision/cli.ts')).decideFlagsFile(a!, b!, c!, d!, jevDeps()))
  if (verb === 'decide' && (n === 3 || n === 4)) return printed(sink, await (await import('../decision/cli.ts')).decideFile(a!, b!, c, jevDeps()))
  if (verb === 'jev' && (n === 3 || n === 4)) return printed(sink, await (await import('../jev/cli.ts')).jevFile(a!, b!, c, jevDeps()))
  return jobs(sink, args)
}

/** main.dispatch: the decision verbs by equality, then the rest. */
async function dispatch(sink: Sink, args: string[]): Promise<number> {
  const [verb, ...rest] = args
  if (verb === 'resolve-decision') {
    if (rest.length !== 4) return die(sink, {code: 2, message: 'resolve-decision requires a request file'})
    return printed(sink, await (await import('../decision/cli.ts')).resolveDecisionFile(rest[1]!, rest[3]!, jevDeps()))
  }
  if (verb === 'validate-decision' && rest.length === 1) return printed(sink, await (await import('../decision/cli.ts')).validateDecisionFile(rest[0]!))
  if (verb === 'decision-providers' && rest.length === 0) return printed(sink, (await import('../decision/cli.ts')).decisionProviders())
  if (verb === 'validate-decision' || verb === 'decision-providers') return jobs(sink, args)
  return legacy(sink, args)
}

/** main.default_timeout: the configured limit (an invalid setting fails before any effect). */
function configured(command: string): Result<number> {
  const which = Cli.defaultTimeout(command)
  if (which === 'jev') return Time.jev()
  if (which === 'wait') return Time.wait()
  if (which === 'watch') return Time.watch()
  return Time.work()
}

function executePlan(sink: Sink, command: string, args: string[], ms: number, input: boolean, launch: Launch): Promise<number> {
  if (command === 'exec') return execute(sink, args, ms, input, launch.cwd)
  return dispatch(sink, Cli.canonical(command, args, ms, input, launch))
}

async function planned(sink: Sink, plan: Plan): Promise<number> {
  if (plan.k === 'pass') return dispatch(sink, plan.args)
  const ms = plan.timeout === null ? configured(plan.command) : {ok: true as const, value: plan.timeout}
  if (!ms.ok) return die(sink, ms.error)
  return executePlan(sink, plan.command, plan.args, ms.value, plan.input, plan.launch)
}

/**
 * The CLI: `args` are the arguments after the executable (a leading `--`
 * optional). Writes through `sink` and resolves to the exit status.
 */
export async function main(args: readonly string[], sink: Sink = processSink): Promise<number> {
  // `run` parses its own words (src/run/args.ts keeps 0.8.1's options and errors).
  const words = args[0] === '--' ? args.slice(1) : [...args]
  if (words[0] === 'run') return (await import('../run/index.ts')).runMain(words.slice(1))
  const decisions = Cli.needsDecisions(args) ? (await import('../decision/cli-core.ts')).parse : undefined
  const plan = Cli.parse(args, decisions)
  if (!plan.ok) return die(sink, plan.error)
  return planned(sink, plan.value)
}
