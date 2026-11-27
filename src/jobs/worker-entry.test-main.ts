// A tiny stand-in for the CLI, for tests only: it re-enters itself as the job
// worker (`bun worker-entry.test-main.ts --RTS __job-worker ...`) and runs any
// other canonical jobs verb (`start <ms> <command...>`, `__start ...`,
// `status <id>`, `wait <id> <ms>`, ...) as 0.8.1's Jobs.command did.

import * as IO from '../cli/io.ts'
import * as Process from '../proc/process.ts'
import {command, configureSelf, workerMain} from './jobs.ts'

Process.installSignalScope()
configureSelf([process.execPath, import.meta.path])
const args = process.argv.slice(2)
// The Bend runtime removed a leading --RTS before main saw the arguments.
if (args[0] === '--RTS') args.shift()
if (args[0] === '__job-worker') await workerMain(args)
// Written whole before the exit, as the CLI writes (an async process.stdout write can be cut short by process.exit).
const r = await command(args, (line) => IO.stdout(line + '\n'))
if (r.error !== undefined) IO.stderr(r.error + '\n')
process.exit(r.code)
