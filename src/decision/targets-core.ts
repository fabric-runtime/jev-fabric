// Target resolution, the pure half of native/DecisionTargets.bend: the
// request, its profiles document and the ambient settings resolved to one
// checked target and its request body, with exactly the dispatch adapter's
// preflight. Nothing here resolves a credential, dispatches or reads a file;
// ./targets.ts reads the profiles file and the environment.
//
// Pure: no IO.

import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {field, jbool, jobj, jstr} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {attempt, done, fail, unwrap} from '../codec/result.ts'
import * as Config from './config.ts'
import * as Local from './local-core.ts'
import * as Profiles from './profiles.ts'
import * as Wire from './wire.ts'

export type Env = Readonly<Record<string, string | undefined>>
export type PreparedTarget = {config: Config.Settings; request: Json; body: string; profile: string}

export const LIMIT = 16777216

function body(request: Json, api: string, model: string): string {
  if (api === 'llama-cpp') {
    unwrap(Local.preflight(request))
    return ''
  }
  return unwrap(Wire.body(request, api, model))
}

function prepare(request: Json, config: Config.Settings, profile: string): PreparedTarget {
  const effective = unwrap(Profiles.merge(request, jobj([['provider', jstr(config.provider)]])))
  return {config, request: effective, body: body(effective, config.api, config.model), profile}
}

export type Ambient = {selector: string; provider: string; model: string; endpoint: string; account: string}

export const resolveWith = (text: string, profiles: string, ambient: Ambient): Result<PreparedTarget> =>
  attempt(() => {
    const request = unwrap(Codec.readWithLimit(text, LIMIT))
    const selected = unwrap(Profiles.apply(request, profiles, ambient.selector))
    const checked = unwrap(Wire.validateRequest(selected.request))
    const config = unwrap(Config.resolve(checked, ambient.provider, ambient.model, ambient.endpoint, ambient.account))
    return prepare(checked, config, selected.profile)
  })

function imageSupport(provider: string, api: string, model: string, endpoint: string): string {
  if (Config.vercelEndpoint(endpoint) || !Config.imageCapable(provider, api, model)) return 'unsupported'
  return api === 'llama-system-one' ? 'model-dependent' : 'supported'
}

// The sanitized resolution `resolve-decision` prints: no state, questions,
// images or credential value.
export function resolution(ready: PreparedTarget): Json {
  const {provider, api, endpoint, model, keyEnv, allowLocal} = ready.config
  const request = ready.request
  const target: Member[] = [
    ['provider', jstr(provider)],
    ['api', jstr(api)],
    ['model', jstr(model)],
    ['endpoint', jstr(endpoint)],
    ['allowLocal', jbool(allowLocal)],
    ['allowGenerated', jbool(Local.enabled(field(request, 'allowGenerated')))],
    ...Wire.optionalMember('providerOptions', field(request, 'providerOptions')),
    ...Wire.optionalMember('temperature', field(request, 'temperature')),
  ]
  return jobj([
    ['target', jobj(target)],
    [
      'credential',
      jobj([
        ['env', jstr(keyEnv)],
        ['resolved', jbool(false)],
      ]),
    ],
    ['imageSupport', jstr(imageSupport(provider, api, model, endpoint))],
    ['generated', jbool(api === 'anthropic' || api === 'google')],
    ...(ready.profile === '' ? [] : ([['profile', jstr(ready.profile)]] as Member[])),
  ])
}

export const ambientOf = (env: Env): Ambient => ({
  selector: env.DECISION_PROFILE ?? '',
  provider: env.DECISION_PROVIDER ?? '',
  model: env.DECISION_MODEL ?? '',
  endpoint: env.DECISION_ENDPOINT ?? '',
  account: env.CLOUDFLARE_ACCOUNT_ID ?? '',
})
