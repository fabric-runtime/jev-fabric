// Decision targets: the provider presets and how a request picks one
// (native/DecisionConfig.bend). Pure: the driver supplies DECISION_PROVIDER,
// DECISION_MODEL, DECISION_ENDPOINT and CLOUDFLARE_ACCOUNT_ID. Settings hold
// no credential, only the name of the variable that does.

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import {field, jarr, jbool, jobj, jstr, NULL} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {Failure, attempt, guard, unwrap} from '../codec/result.ts'
import {cpLength, toLower} from '../codec/text.ts'
import * as Http from './http-core.ts'

export type Settings = {
  provider: string
  api: string
  endpoint: string
  model: string
  keyEnv: string
  auth: string
  allowLocal: boolean
}

export const fallback = (value: string, other: string): string => (value === '' ? other : value)

function stringOption(value: Json | undefined, dflt: string): string {
  if (value === undefined) return dflt
  if (value.t === 'str') {
    guard(value.v !== '', 'Decision option must not be empty')
    return value.v
  }
  throw new Failure(22, 'Decision option must be a string')
}

function boolOption(value: Json | undefined): boolean {
  if (value === undefined) return false
  if (value.t === 'bool') return value.v
  throw new Failure(22, 'Decision opt-in must be a boolean')
}

export const canonical = (provider: string): string => (provider === 'vercel-ai-gateway' ? 'vercel' : provider)

export const APIS = ['system-one', 'cloudflare', 'openai-decisions', 'vercel-evaluate', 'llama-cpp', 'llama-system-one', 'anthropic', 'google']
const apiValid = (api: string) => APIS.includes(api)

export const authFor = (api: string): string => (api === 'anthropic' ? 'anthropic' : api === 'google' ? 'google' : 'bearer')

const s = (provider: string, api: string, endpoint: string, model: string, keyEnv: string, auth: string): Settings => ({provider, api, endpoint, model, keyEnv, auth, allowLocal: false})

// One registry for routing and discovery.
export const PRESETS: readonly Settings[] = [
  s('typesafe', 'system-one', 'https://api.typesafe.ai/v1/systemone', 'jev-latest', 'TYPESAFE_API_KEY', 'bearer'),
  s('subq', 'system-one', 'https://api.subq.ai/v1/systemone', 'subq-snap-preview', 'SUBQ_API_KEY', 'bearer'),
  s('openrouter', 'system-one', 'https://openrouter.ai/api/v1/systemone', '~typesafe/jev-latest', 'OPENROUTER_API_KEY', 'bearer'),
  s('vercel', 'system-one', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', 'typesafe-ai/jev', 'AI_GATEWAY_API_KEY', 'bearer'),
  s('vercel-evaluate', 'vercel-evaluate', 'https://ai-gateway.vercel.sh/v1/evaluate', 'typesafe-ai/jev', 'AI_GATEWAY_API_KEY', 'bearer'),
  s('vercel-decisions', 'openai-decisions', 'https://ai-gateway.vercel.sh/v1/decisions', 'openai/gpt-6-luna-decisions', 'AI_GATEWAY_API_KEY', 'bearer'),
  s('openai', 'openai-decisions', 'https://api.openai.com/v1/decisions', 'gpt-6-luna', 'OPENAI_API_KEY', 'bearer'),
  s('cloudflare-workers-ai', 'cloudflare', '', 'typesafe/jev', 'CLOUDFLARE_API_TOKEN', 'bearer'),
  s('opencode', 'system-one', 'https://opencode.ai/zen/v1/systemone', 'jev-1.13', 'OPENCODE_API_KEY', 'bearer'),
  s('llama.cpp', 'llama-cpp', 'http://127.0.0.1:8080', 'local', 'LLAMA_API_KEY', 'bearer'),
  s('llama-system-one', 'llama-system-one', 'http://127.0.0.1:8080/v1/systemone', 'local', 'LLAMA_API_KEY', 'bearer'),
  s('anthropic', 'anthropic', 'https://api.anthropic.com/v1/messages', 'claude-haiku-4-5-20251001', 'ANTHROPIC_API_KEY', 'anthropic'),
  s('google', 'google', '', 'gemini-2.5-flash', 'GEMINI_API_KEY', 'google'),
  s('custom', '', '', '', 'DECISION_API_KEY', ''),
]

export function preset(provider: string): Result<Settings> {
  const found = PRESETS.find((p) => p.provider === provider)
  return found ? {ok: true, value: found} : {ok: false, error: {code: 22, message: 'Unknown decision provider'}}
}

// Cloudflare account IDs are 32 hexadecimal characters: no URL syntax.
const hex = (s: string) => /^[0-9A-Fa-f]*$/.test(s)

// Models are JSON text: Unicode scalars, no C0 controls, no DEL, at most 256.
function modelText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i)
    if (n < 32 || n === 127) return false
  }
  return true
}

export const modelValid = (model: string): boolean => model !== '' && cpLength(model) <= 256 && modelText(model)

const cloudAlias = (model: string) => (model === '@cf/cloudflare/clef' ? 'clef' : model === '@cf/cloudflare/clef-flash' ? 'clef-flash' : model)
export const canonicalModel = (model: string, api: string): string => (api === 'cloudflare' ? cloudAlias(model) : model)
export const cloudModel = (model: string): boolean => model === 'clef' || model === 'clef-flash'

function cloudEndpoint(model: string, account: string, known: boolean): string {
  if (known) return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`
  guard(model === 'typesafe/jev', 'Unknown Cloudflare model requires an explicit endpoint')
  return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`
}

function defaultEndpoint(provider: string, endpoint: string, model: string, account: string): string {
  if (provider === 'cloudflare-workers-ai') {
    guard(cpLength(account) === 32 && hex(account), 'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID')
    return cloudEndpoint(model, account, cloudModel(model))
  }
  if (provider === 'google') {
    guard(Http.hostChars(model), 'Invalid Google model path')
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  }
  return endpoint
}

function imagesPresent(value: Json | undefined): boolean {
  if (value === undefined) return false
  if (value.t === 'arr') return value.items.length > 0
  throw new Failure(22, 'Decision images must be an array')
}

// Capabilities of the implemented adapters, never guessed from model IDs.
export function imageCapable(provider: string, api: string, model: string): boolean {
  return (
    (api === 'cloudflare' && cloudModel(model)) ||
    api === 'llama-system-one' ||
    (api === 'system-one' && (provider === 'subq' || provider === 'typesafe')) ||
    (api === 'openai-decisions' && provider !== 'vercel-decisions') ||
    api === 'anthropic' ||
    api === 'google'
  )
}

function temperature(value: Json | undefined, api: string): void {
  if (value === undefined) return
  if (value.t === 'num') {
    guard(api === 'llama-cpp' || api === 'google', 'Temperature is unsupported by this decision transport')
    return
  }
  throw new Failure(22, 'Decision temperature must be a number')
}

const OPTION_PROVIDERS = ['openrouter', 'vercel', 'typesafe', 'vercel-evaluate', 'vercel-decisions']
const OPTION_APIS = ['vercel-evaluate', 'anthropic', 'google', 'openai-decisions']

function providerOptions(value: Json | undefined, provider: string, api: string): void {
  if (value === undefined) return
  if (value.t === 'obj') {
    guard(OPTION_PROVIDERS.includes(provider) || OPTION_APIS.includes(api), 'providerOptions is unsupported by this decision transport')
    return
  }
  throw new Failure(22, 'Decision providerOptions must be an object')
}

function customExplicit(request: Json, custom: boolean): void {
  if (!custom) return
  const api = stringOption(field(request, 'api'), '')
  const model = stringOption(field(request, 'model'), '')
  const endpoint = stringOption(field(request, 'endpoint'), '')
  guard(api !== '' && model !== '' && endpoint !== '', 'custom requires explicit api, endpoint and model')
}

// Vercel's Decisions surface is text-only, even through custom routing.
export const vercelEndpoint = (endpoint: string): boolean => (toLower(Http.authority(endpoint)).split(':')[0] ?? '') === 'ai-gateway.vercel.sh'

function configure(request: Json, settings: Settings, modelEnv: string, endpointEnv: string, account: string): Settings {
  const {provider, api: defaultApi, endpoint, model, keyEnv} = settings
  customExplicit(request, provider === 'custom')
  const api = stringOption(field(request, 'api'), defaultApi)
  guard(apiValid(api), 'Unknown decision API')
  guard(provider === 'custom' || api === defaultApi, 'Decision API does not match provider preset')
  const rawModel = stringOption(field(request, 'model'), fallback(modelEnv, model))
  const selectedModel = canonicalModel(rawModel, api)
  guard(modelValid(selectedModel), 'Invalid decision model')
  const override = stringOption(field(request, 'endpoint'), endpointEnv)
  const selectedEndpoint = override === '' ? defaultEndpoint(provider, endpoint, selectedModel, account) : override
  const allowLocal = boolOption(field(request, 'allowLocal'))
  const allowGenerated = boolOption(field(request, 'allowGenerated'))
  guard(Http.urlValid(selectedEndpoint, allowLocal), 'Invalid decision endpoint; HTTP requires exact loopback and allowLocal:true')
  guard(!(api === 'llama-cpp' || api === 'llama-system-one') || allowLocal, 'Local decision APIs require allowLocal:true')
  guard(!(api === 'anthropic' || api === 'google') || allowGenerated, 'Generated decisions require allowGenerated:true')
  const images = imagesPresent(field(request, 'images'))
  guard(!images || (imageCapable(provider, api, selectedModel) && !vercelEndpoint(selectedEndpoint)), 'Images are unsupported by this decision transport')
  temperature(field(request, 'temperature'), api)
  providerOptions(field(request, 'providerOptions'), provider, api)
  return {provider, api, endpoint: selectedEndpoint, model: selectedModel, keyEnv, auth: authFor(api), allowLocal}
}

// Explicit target switches cannot inherit ambient model or endpoint settings.
export const configureExplicit = (request: Json, settings: Settings, modelEnv: string, endpointEnv: string, account: string, explicit: Json | undefined): Result<Settings> =>
  attempt(() => (explicit === undefined ? configure(request, settings, modelEnv, endpointEnv, account) : configure(request, settings, '', '', account)))

export const resolve = (request: Json, providerEnv: string, modelEnv: string, endpointEnv: string, account: string): Result<Settings> =>
  attempt(() => {
    const checked = unwrap(Codec.validateWithLimit(request, 16777216))
    if (checked.t !== 'obj') throw new Failure(22, 'Decision request must be an object')
    const provider = stringOption(field(request, 'provider'), fallback(providerEnv, 'typesafe'))
    const settings = unwrap(preset(canonical(provider)))
    return unwrap(configureExplicit(request, settings, modelEnv, endpointEnv, account, field(request, 'provider')))
  })

// Static discovery: no environment, credential or live model reads.
function discoveryEndpoint(provider: string, endpoint: string, model: string): string {
  if (provider === 'cloudflare-workers-ai') return 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run'
  if (provider === 'google') return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  return endpoint
}

function imageSupport(provider: string, api: string): string {
  if (provider === 'custom' || api === 'cloudflare' || api === 'llama-system-one') return 'model-dependent'
  if (provider === 'openai' || provider === 'subq' || provider === 'typesafe' || api === 'anthropic' || api === 'google') return 'supported'
  return 'unsupported'
}

export const descriptor = (p: Settings): Json =>
  jobj([
    ['provider', jstr(p.provider)],
    ['api', jstr(p.api)],
    ['defaultModel', jstr(p.model)],
    ['endpoint', jstr(discoveryEndpoint(p.provider, p.endpoint, p.model))],
    ['credentialEnv', jstr(p.keyEnv)],
    ['imageSupport', jstr(imageSupport(p.provider, p.api))],
    ['generated', jbool(p.api === 'anthropic' || p.api === 'google')],
  ])

export const providers = (): Json => jarr(PRESETS.map(descriptor))

export {NULL}
