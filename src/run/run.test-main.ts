// A stand-in CLI for tests until src/main.ts lands: `run` goes to runMain,
// the job worker re-entry and every other canonical jobs verb to src/jobs,
// as 0.8.1's main dispatched them. Compiled with `bun build --compile` it is
// how the tests exercise the binary path (BUN_BE_BUN and the embedded library).

import * as Jobs from '../jobs/jobs.ts'
import * as Process from '../proc/process.ts'
import {runMain} from './index.ts'

Process.installSignalScope()
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
if (args[0] === '--RTS') args.shift()
if (args[0] === '__job-worker') await Jobs.workerMain(args)
if (args[0] === 'run') process.exit(await runMain(args.slice(1)))
const r = await Jobs.command(args, (line) => process.stdout.write(line + '\n'))
if (r.error !== undefined) process.stderr.write(r.error + '\n')
process.exit(r.code)
