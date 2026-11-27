// Decision profiles (native/DecisionProfiles.bend): an explicit, bounded
// document of named targets, never credentials, and how a request picks
// one. Pure. laws/decision.ts proves the selection precedence and the merge.

import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {field, findField, jobj} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {Failure, attempt, guard, unwrap} from '../codec/result.ts'
import {toLower} from '../codec/text.ts'
import * as Config from './config.ts'
import * as Http from './http-core.ts'
import * as W from './w.ts'
import * as Wire from './wire.ts'

export type Document = {profiles: Member[]; default: string}
export type Selected = {request: Json; profile: string}

function name(text: string): string {
  guard(Wire.profileName(text), 'Invalid decision profile name')
  return text
}

function selector(value: Json | undefined): string {
  if (value === undefined) return ''
  if (value.t === 'str') return name(value.v)
  throw new Failure(22, 'Decision profile must be a string')
}

const SECRET_WORDS = ['secret', 'password', 'credential', 'apikey', 'authorization']
const SECRET_KEYS = ['auth', 'headers', 'token', 'accesstoken', 'refreshtoken', 'privatekey']

export function secretKey(text: string): boolean {
  const key = toLower(text).replace(/[^a-z0-9]/g, '')
  return SECRET_WORDS.some((w) => key.includes(w)) || SECRET_KEYS.includes(key)
}

type Work = {member: Member} | {json: Json}

// A worklist within Codec's structural job ceiling; past it, not secret-free.
export function secretFree(fuel: number, root: Json): boolean {
  const work: Work[] = [{json: root}]
  while (work.length > 0) {
    if (fuel <= 0) return false
    fuel--
    const item = work.shift()!
    if ('member' in item) {
      if (secretKey(item.member[0])) return false
      work.unshift({json: item.member[1]})
      continue
    }
    const v = item.json
    if (v.t === 'obj') work.unshift(...v.fields.map((member) => ({member})))
    else if (v.t === 'arr') work.unshift(...v.items.map((json) => ({json})))
  }
  return true
}

function endpoint(value: Json | undefined): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'Decision endpoint must be a string')
  guard(Http.urlValid(value.v, true), 'Invalid decision target endpoint; credentials and URL query options are forbidden')
}

// Structural enum only; provider/API compatibility belongs to preflight.
function api(value: Json | undefined): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'Decision API must be a known API string')
  guard(Config.APIS.includes(value.v), 'Invalid decision target API')
}

const TARGET_FIELDS = ['provider', 'api', 'model', 'endpoint', 'allowLocal', 'allowGenerated', 'providerOptions', 'temperature']

function target(value: Json): void {
  guard(secretFree(32768, value), 'Decision targets must not contain credential or secret fields')
  const fields = W.object(value)
  guard(W.only(fields, TARGET_FIELDS), 'Unknown decision target field')
  const provider = W.string(W.need(value, 'provider'))
  unwrap(Config.preset(Config.canonical(provider)))
  Wire.optionalString(field(value, 'provider'), 128)
  api(field(value, 'api'))
  Wire.optionalModel(field(value, 'model'))
  Wire.optionalString(field(value, 'endpoint'), 4096)
  endpoint(field(value, 'endpoint'))
  Wire.optionalBool(field(value, 'allowLocal'))
  Wire.optionalBool(field(value, 'allowGenerated'))
  Wire.options(field(value, 'providerOptions'))
  Wire.optionalTemperature(field(value, 'temperature'))
}

function documentOf(value: Json): Document {
  const fields = W.object(value)
  guard(W.only(fields, ['version', 'defaultProfile', 'profiles']), 'Unknown decision profiles document field')
  const v = W.scalar(W.need(value, 'version'), 0, 1n)
  guard(v === 1n, 'Decision profiles version must be 1')
  const entries = W.object(W.need(value, 'profiles'))
  guard(entries.length <= 128, 'Too many decision profiles')
  for (const [key, t] of entries) {
    name(key)
    target(t)
  }
  const dflt = selector(field(value, 'defaultProfile'))
  guard(dflt === '' || findField(entries, dflt) !== undefined, 'Unknown default decision profile')
  return {profiles: entries, default: dflt}
}

export const document = (value: Json): Result<Document> => attempt(() => documentOf(value))

export const PROFILES_LIMIT = 65536

// The document's text: empty is no document.
export const read = (text: string): Result<Document> =>
  attempt(() => (text === '' ? {profiles: [], default: ''} : documentOf(unwrap(Codec.readWithLimit(text, PROFILES_LIMIT)))))

const present = (value: Json | undefined) => value !== undefined

// Whole-field overlay: a base field the overrides name is replaced (never
// merged recursively); the overrides follow in their order.
export function missing(fields: readonly Member[], overrides: Json): Member[] {
  return fields.filter(([key]) => !present(field(overrides, key)))
}

export const merge = (base: Json, overrides: Json): Result<Json> =>
  attempt(() => {
    const fields = W.object(base)
    const extra = W.object(overrides)
    return jobj([...missing(fields, overrides), ...extra])
  })

export const remove = (fields: readonly Member[], key: string): Member[] => fields.filter(([k]) => k !== key)

function compatible(value: Json | undefined, provider: string): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'Decision provider must be a string')
  guard(Config.canonical(value.v) === Config.canonical(provider), 'Decision profile conflicts with explicit provider')
}

function selected(request: Json, profile: string, entries: Member[]): Selected {
  if (profile === '') return {request, profile: ''}
  name(profile)
  const t = W.need(jobj(entries), profile)
  const provider = W.string(W.need(t, 'provider'))
  compatible(field(request, 'provider'), provider)
  return {request: unwrap(merge(t, request)), profile}
}

// The selection policy, after structural validation: an explicit profile,
// else none when the request names a provider, else the ambient one, else
// the document's default.
export const chooseProfile = (explicit: string, provider: Json | undefined, ambient: string, dflt: string): string =>
  Config.fallback(explicit, present(provider) ? '' : Config.fallback(ambient, dflt))

export const applyDocument = (request: Json, doc: Document, ambient: string): Result<Selected> =>
  attempt(() => {
    const fields = W.object(request)
    const explicit = selector(field(request, 'profile'))
    const profile = chooseProfile(explicit, field(request, 'provider'), ambient, doc.default)
    return selected(jobj(remove(fields, 'profile')), profile, doc.profiles)
  })

export function apply(request: Json, text: string, ambient: string): Result<Selected> {
  const doc = read(text)
  return doc.ok ? applyDocument(request, doc.value, ambient) : doc
}

export {present}
