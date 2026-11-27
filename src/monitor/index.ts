// The monitor: `watch`, bounded filtered line batches over a job's events.
//
// For serve's `watch` op (and the CLI):
//
//   watch(id: string, ms: string, literal: string, out: (line: string) => void, signal?: AbortSignal): Promise<{code: number; error?: string}>
//
//     Prints each record (monitor.loss, monitor.batch, then one monitor.end)
//     through `out` as a line without its newline, as it goes, exactly as
//     `jev-fabric -- watch --timeout-ms <ms> <id> <literal>` prints them.
//     `ms` is the duration as text (1..300000, read as U32.read reads it).
//     Resolves to {code: 0}, or to what the CLI exited with and printed on
//     stderr: {code: 2, error: USAGE} for a bad duration or literal (nothing
//     was printed then: serve 0.8.1 answered an empty-literal watch with
//     ok:true and [] because it read that child's empty stdout), or a store
//     or job file failure's own code and message (2 "native private job
//     operation failed" for a missing job, 22 for an unsafe id). It never
//     throws for those. Aborting `signal` ends the loop before its next poll
//     with a monitor.end whose reason is "cancelled".
//
//   command(args: readonly string[], out, signal?): Promise<Exit>
//     the canonical `["watch", id, ms, literal]` the CLI dispatches.
//
// The pure policy (framing, filter, dedup, batches, losses, the stop
// decision) is Core; laws/monitor.ts proves its laws and holds them to it.

export * as Core from './core.ts'
export {USAGE} from './core.ts'
export {command, watch, READ_LIMIT} from './monitor.ts'
export type {Exit, Out} from './monitor.ts'
