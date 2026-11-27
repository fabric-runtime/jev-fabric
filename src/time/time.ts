// The configured limits (native/Time.bend): four environment settings over
// the central defaults. An invalid setting fails before any effect.

import type {Result} from '../codec/result.ts'
import * as Policy from './core.ts'

export const maxTimeout = 3600000
/** The lifetime ceiling of a detached `start` job only. */
export const jobMaxTimeout = Policy.jobMax

/** An unset variable reads as empty, as IO.get_env's failure did. */
export const env = (name: string): string => process.env[name] ?? ''

export const setting = (name: string, fallback: number, max: number): Result<number> => Policy.config(env(name), fallback, max)

export const work = () => setting('JEV_FABRIC_TIMEOUT_MS', Policy.workDefault, maxTimeout)
export const jev = () => setting('JEV_FABRIC_JEV_TIMEOUT_MS', Policy.jevDefault, maxTimeout)
export const wait = () => setting('JEV_FABRIC_WAIT_MS', Policy.waitDefault, maxTimeout)
export const watch = () => setting('JEV_FABRIC_WATCH_MS', Policy.watchDefault, 300000)

/** The clock budgets are observed against: monotonic milliseconds. */
export const now = (): number => Math.floor(performance.now())
