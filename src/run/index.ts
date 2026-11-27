// The `run` verb: runs a TypeScript or JavaScript program with the Bun built
// into this executable, under one deadline, and prints its process receipt
// (native/Runner.bend's contract, without the compile step).
//
//   runMain(args): the words after `run`, i.e.
//     [--timeout-ms N] [--] <program.ts|.js> [args...]   or   <ms> <program> [args...]
//   It writes the receipt (stdout) and any error (stderr) and resolves to the
//   exit code: 0, the program's nonzero exit (124 on the deadline) with
//   "native program did not complete successfully", or 2 for bad arguments.
//
// How the program runs: a compiled `bun build --compile` executable acts as
// the bun CLI when started with BUN_BE_BUN=1 (Bun 1.4.4). Each run gets a
// private directory in the storage home (as 0.8.1's compiled program did)
// holding a preload and, from the compiled binary, the library as one ESM
// file; the child is
//
//   BUN_BE_BUN=1 <this executable> --preload <dir>/preload.js <program> [args...]
//
// (from source: <bun> --preload ... with src/lib.ts itself). The preload
// unsets BUN_BE_BUN in process.env, tells the library how to re-enter this
// CLI for job workers, and registers `jev-fabric` as a virtual module bound to
// this binary's library, so `import ... from 'jev-fabric'` needs no
// node_modules and always matches the binary that runs it. The child owns its
// process group; the deadline kills the group (SIGTERM, then SIGKILL after
// 500 ms) and SIGINT/SIGTERM to this process do the same.

import {resolve} from 'node:path'
import {died} from '../codec/result.ts'
import * as Jobs from '../jobs/jobs.ts'
import * as Process from '../proc/process.ts'
import {show} from '../proc/report.ts'
import * as Host from '../store/host.ts'
import * as Time from '../time/time.ts'
import {parse} from './args.ts'

export type Out = (text: string) => void

const FAILED = 'native program did not complete successfully'

const compiled = (): boolean => Bun.main.startsWith('/$bunfs/') || Bun.main.startsWith('B:/~BUN/')

/** The preload that binds `jev-fabric` to `library` and points job workers at `cli`. */
export function preload(library: string, cli: readonly string[]): string {
  return [
    '// Written by `jev-fabric run` for one program; see src/run/index.ts.',
    'delete process.env.BUN_BE_BUN',
    `globalThis[Symbol.for('jev-fabric.cli')] = ${JSON.stringify(cli)}`,
    `const library = await import(${JSON.stringify(library)})`,
    "Bun.plugin({name: 'jev-fabric', setup(build) { build.module('jev-fabric', () => ({exports: library, loader: 'object'})) }})",
    '',
  ].join('\n')
}

/** Writes the run directory; resolves to the argv prefix (bun and its preload) or an error. */
async function prepare(): Promise<{ok: true; argv: string[]} | {ok: false; code: number; message: string}> {
  const id = Host.make(1024)
  if (!id.ok) return {ok: false, ...id.error}
  const dir = resolve(process.env.JEV_FABRIC_HOME ?? '.jev-fabric-native', id.value)
  let library = resolve(import.meta.dir, '..', 'lib.ts')
  if (compiled()) {
    const {LIBRARY} = await import('./embedded.ts')
    const put = Host.put(id.value, 'jev-fabric.js', LIBRARY)
    if (!put.ok) return {ok: false, ...put.error}
    library = `${dir}/jev-fabric.js`
  }
  const put = Host.put(id.value, 'preload.js', preload(library, Jobs.selfArgv()))
  if (!put.ok) return {ok: false, ...put.error}
  return {ok: true, argv: [compiled() ? Host.self() : process.execPath, '--preload', `${dir}/preload.js`]}
}

/** `run`, printing through `out` and `err`; resolves to the exit code. */
export async function run(args: readonly string[], out: Out, err: Out): Promise<number> {
  const fatal = (code: number, message: string) => {
    const d = died({code, message})
    err(d.stderr)
    return d.exit
  }
  const plan = parse(args, Time.work)
  if (!plan.ok) return fatal(plan.error.code, plan.error.message)
  const {timeout, program, args: rest} = plan.value
  const started = Time.now()
  const prepared = await prepare()
  if (!prepared.ok) return fatal(prepared.code, prepared.message)
  // Preparing the run directory spends the same deadline, as compiling did.
  const remaining = Math.max(0, timeout - Math.max(0, Time.now() - started))
  if (remaining === 0) return fatal(124, 'native program deadline expired before launch')
  const before = process.env.BUN_BE_BUN
  if (compiled()) process.env.BUN_BE_BUN = '1'
  let result
  try {
    result = await Process.runStdin([...prepared.argv, resolve(program), ...rest], remaining)
  } finally {
    if (before === undefined) delete process.env.BUN_BE_BUN
    else process.env.BUN_BE_BUN = before
  }
  if (!result.ok) return fatal(result.error.code, result.error.message)
  out(show(result.value) + '\n')
  return result.value.code === 0 ? 0 : fatal(result.value.code, FAILED)
}

/** src/main.ts routes `run` here with the words after it. */
export function runMain(args: string[]): Promise<number> {
  return run(
    args,
    (text) => process.stdout.write(text),
    (text) => process.stderr.write(text),
  )
}
