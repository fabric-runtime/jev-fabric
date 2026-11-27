// A finished child as 0.8.1 reported it (the pure half of native/Process.bend):
// the raw result the supervisor hands back, its flags decoded, the state it
// names and the one-line JSON receipt `exec` prints and a job records.

import {quote} from '../codec/print.ts'

/** Flag bits the supervisor sets (posix.c): */
export const TIMED_OUT = 1
export const STDOUT_CUT = 2
export const STDERR_CUT = 4
export const CANCELLED = 8

/** The supervisor's answer: the exit code, the flags and both final tails. */
export type Raw<T = string> = {code: number; flags: number; stdout: T; stderr: T}

export type Report = {
  code: number
  timedOut: boolean
  cancelled: boolean
  stdoutCut: boolean
  stderrCut: boolean
  stdout: string
  stderr: string
}

export const decode = (raw: Raw): Report => ({
  code: raw.code,
  timedOut: (raw.flags & TIMED_OUT) !== 0,
  cancelled: (raw.flags & CANCELLED) !== 0,
  stdoutCut: (raw.flags & STDOUT_CUT) !== 0,
  stderrCut: (raw.flags & STDERR_CUT) !== 0,
  stdout: raw.stdout,
  stderr: raw.stderr,
})

export type State = 'timed_out' | 'cancelled' | 'exited' | 'failed'

/** A timeout wins over a cancellation; otherwise a zero exit is "exited". */
export function state(code: number, timedOut: boolean, cancelled: boolean): State {
  if (timedOut) return 'timed_out'
  if (cancelled) return 'cancelled'
  return code === 0 ? 'exited' : 'failed'
}

const bool = (b: boolean) => (b ? 'true' : 'false')

/** Process.show: the receipt, field by field, exactly as 0.8.1 printed it. */
export function show(r: Report): string {
  return (
    `{"schemaVersion":1,"state":${quote(state(r.code, r.timedOut, r.cancelled))}` +
    `,"exitCode":${r.code}` +
    `,"timedOut":${bool(r.timedOut)}` +
    `,"cancelled":${bool(r.cancelled)}` +
    `,"stdout":${quote(r.stdout)}` +
    `,"stderr":${quote(r.stderr)}` +
    `,"truncated":{"stdout":${bool(r.stdoutCut)},"stderr":${bool(r.stderrCut)}}}`
  )
}

export const exitCode = (r: Report): number => r.code
