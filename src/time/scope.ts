// A shared deadline budget for composed workflows (native/Scope.bend): not a
// separate OS ownership or cancellation group. Each child call samples what
// is left of the budget, at most its own local cap, never a fresh allowance;
// an expired budget launches nothing. The Jev half (Scope.evaluate*, which
// lowers a client's timeout to what is left and hands its settings back) is
// src/jev/session.ts's evaluateFor, over the same Budget shape.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Process from '../proc/process.ts'
import type {Report} from '../proc/report.ts'
import * as Session from '../proc/session.ts'
import * as Policy from './core.ts'
import * as Time from './time.ts'

export type Budget = Policy.Budget

/** Scope.with_timeout: a budget of `ms` (1..3600000) from now. */
export function withTimeout(ms: number): Result<Budget> {
  const valid = Policy.parsed(ms, Time.maxTimeout)
  return valid.ok ? done({started: Time.now(), duration: valid.value}) : valid
}

/** Scope.open: a budget of the configured work limit. */
export function open(): Result<Budget> {
  const ms = Time.work()
  return ms.ok ? withTimeout(ms.value) : ms
}

/** Scope.remaining: what is left now, at most `cap` (itself 1..3600000). */
export function remaining(scope: Budget, cap: number): Result<number> {
  const valid = Policy.parsed(cap, Time.maxTimeout)
  return valid.ok ? done(Policy.cap(Policy.remaining(scope, Time.now()), valid.value)) : valid
}

/** What an expired budget reports instead of launching: exit 124, timed out, no output. */
export const expired: Report = {code: 124, timedOut: true, cancelled: false, stdoutCut: false, stderrCut: false, stdout: '', stderr: ''}

/** Scope.run_for: a buffered child within the budget and `cap`. */
export async function runFor(scope: Budget, argv: readonly string[], input: string, cap: number): Promise<Result<Report>> {
  const ms = remaining(scope, cap)
  if (!ms.ok) return ms
  return ms.value === 0 ? done(expired) : Process.runInput(argv, input, ms.value)
}

export const run = (scope: Budget, argv: readonly string[], input: string) => runFor(scope, argv, input, Time.maxTimeout)
export const exec = (scope: Budget, argv: readonly string[]) => run(scope, argv, '')

/** Scope.start_for: a session within the budget; an expired one starts nothing (124). */
export function startFor(scope: Budget, argv: readonly string[], cap: number): Result<Session.Session> {
  const ms = remaining(scope, cap)
  if (!ms.ok) return ms
  return ms.value === 0 ? fail(124, 'scope deadline expired before session start') : Session.start(argv, ms.value)
}

export const start = (scope: Budget, argv: readonly string[]) => startFor(scope, argv, Time.maxTimeout)
