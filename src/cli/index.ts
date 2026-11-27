// The command line (native/Cli.bend and native/main.bend).
//
//   main(args: readonly string[], sink?: Sink): Promise<number>
//       The whole CLI: `args` are the words after the executable (one leading
//       `--` optional). Writes what 0.8.1 printed (stdout and stderr through
//       `sink`, the process's own by default) and resolves to the exit status.
//       src/main.ts calls it after dropping a leading `--RTS` and routing
//       `__job-worker` to Jobs.workerMain.
//
// Pure (./core.ts):
//   parse(args, decisions?): Result<Plan>      the prefix parser; `decisions` is
//       src/decision/cli-core.ts's parse, needed only when needsDecisions(args)
//   canonical(command, args, ms, input, launch) the dispatcher's argument list
//   defaultTimeout(command)                     'jev' | 'wait' | 'watch' | 'work'
//   VERSION ('0.9.0-native'), versionLine(runtime, platform), platformOf(platform, arch)
//   capabilities(version, platform), capabilityFields, FEATURES, PROTOCOL, STORE
//   USAGE, UPDATE_COMMAND, UPDATE_TIMEOUT

export * as Core from './core.ts'
export {capabilities, capabilityFields, FEATURES, PROTOCOL, STORE, USAGE, VERSION, versionLine, platformOf} from './core.ts'
export type {Launch, Plan} from './core.ts'
export {main, processSink} from './cli.ts'
export type {Sink} from './cli.ts'
