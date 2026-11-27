// The jev-fabric executable (native/main.bend), compiled with
// `bun build --compile` (package.json `build`).
//
// Its own re-entries come first: a detached job worker is
// `<self> --RTS __job-worker <id> <ms> <mode> <cwd> <command...>`, a serve
// session's watchdog becomes `<self> --RTS __session-reaper <dir...>` once
// its owner is gone, and a serve CLI child is `<self> --RTS <args...>`. 0.8.1's Bend runtime removed that
// `--RTS`; here a leading one is dropped and every later argument is literal.
// (Bend's runtime also took `+RTS ... -RTS` and a `--RTS` anywhere as runtime
// options; this binary passes them through as arguments.)

import {installSignalScope} from './proc/process.ts'

installSignalScope()

const given = process.argv.slice(2)
const args = given[0] === '--RTS' ? given.slice(1) : given
const verb = args[0] === '--' ? args.slice(1) : args

// No top-level await: the entry also builds as CommonJS (`--bytecode`).
// Modules load on first use, so each verb starts with only what it runs.
if (verb[0] === '__job-worker') void import('./jobs/jobs.ts').then((m) => m.workerMain(verb))
else if (verb[0] === '__session-reaper') void import('./jobs/session.ts').then((m) => m.reaperMain(verb.slice(1)))
else void import('./cli/cli.ts').then((m) => m.main(args)).then((code) => process.exit(code))
