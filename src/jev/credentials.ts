// Credential resolution (native/Credentials.bend): a non-blank direct key
// wins; otherwise JEV_CREDENTIAL_COMMAND runs (a JSON argv array, at most 5 s
// and 16 KiB of output) and its trimmed stdout is the key. The key is never
// logged or put in an error.

import type {Result} from '../codec/result.ts'
import {fail} from '../codec/result.ts'
import {trim} from '../codec/text.ts'
import type {CaptureFn} from './capture.ts'
import {capture as defaultCapture} from './capture.ts'
import * as Policy from './credential-core.ts'

type Env = Readonly<Record<string, string | undefined>>

export const COMMAND_TIMEOUT_MS = 5000
export const OUTPUT_LIMIT = 16384

async function execute(command: Result<string[]>, timeout: number, capture: CaptureFn, env?: Env): Promise<Result<string>> {
  if (!command.ok) return command
  const raw = await capture(command.value, '', Math.min(timeout, COMMAND_TIMEOUT_MS), OUTPUT_LIMIT, undefined, env)
  return Policy.captured(raw)
}

// The command runs in `env` (this process's environment when not given).
export function resolve(key: string, command: string, timeout: number, capture: CaptureFn = defaultCapture, env?: Env): Promise<Result<string>> {
  if (trim(key) !== '') return Promise.resolve(Policy.check(key))
  if (command === '') return Promise.resolve(fail(1, 'Missing provider key or JEV_CREDENTIAL_COMMAND'))
  return execute(Policy.command(command), timeout, capture, env)
}
