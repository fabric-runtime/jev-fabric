// Target resolution (native/DecisionTargets.bend): ./targets-core.ts
// resolves; this reads the profiles document (DECISION_PROFILES, or the
// DECISION_PROFILES_FILE it names) and the environment for it.

import * as Codec from '../codec/codec.ts'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import type {CaptureFn} from '../jev/capture.ts'
import * as Input from '../jev/input.ts'
import * as Profiles from './profiles.ts'
import type {Env, PreparedTarget} from './targets-core.ts'
import {LIMIT, ambientOf, resolution, resolveWith} from './targets-core.ts'

export * from './targets-core.ts'

const nonempty = (text: Result<string>): Result<string> => (text.ok && text.value === '' ? fail(22, 'Configured decision profiles document is empty') : text)

// DECISION_PROFILES (inline, set even if empty) wins over DECISION_PROFILES_FILE.
export async function profilesSource(env: Env, capture?: CaptureFn): Promise<Result<string>> {
  const inline = env.DECISION_PROFILES
  if (inline !== undefined) return nonempty(done(inline))
  const path = env.DECISION_PROFILES_FILE ?? ''
  if (path === '') return done('')
  return nonempty(await Input.readLimit(path, Profiles.PROFILES_LIMIT, capture))
}

export async function resolve(text: string, env: Env, capture?: CaptureFn): Promise<Result<PreparedTarget>> {
  const profiles = await profilesSource(env, capture)
  if (!profiles.ok) return profiles
  return resolveWith(text, profiles.value, ambientOf(env))
}

// DecisionTargets.offline: the resolution as text, or the first error.
export async function offline(text: string, env: Env, capture?: CaptureFn): Promise<Result<string>> {
  const ready = await resolve(text, env, capture)
  return ready.ok ? Codec.encodeWithLimit(resolution(ready.value), LIMIT) : ready
}
