// The decision protocol (native/DecisionWire.bend): strict request
// validation, each API's request body, and a lossless typed reply. Pure:
// routing, credentials and capability policy belong to the caller.
//
// Errors are code 22 with the native messages (a parse error's code is its
// position), so the CLI exits and prints exactly as 0.8.1 did.

import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {field, jarr, jobj, jstr, NULL} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {Failure, attempt, guard, unwrap as unwrapResult} from '../codec/result.ts'
import {cpLength, utf8Width, isScalar} from '../codec/text.ts'
import type {Decimal} from '../codec/wire.ts'
import * as Generated from './generated.ts'
import * as W from './w.ts'

export const BYTES_MAX = 16777216

// bool, noul and predicate are the boolean question.
export const kind = (value: string): string => (value === 'bool' || value === 'noul' || value === 'predicate' ? 'boolean' : value)

// No C0 controls, no DEL.
export function clean(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

export const identifier = (s: string, limit: number): boolean => W.label(s, limit) && clean(s)

// Model maxLength counts Unicode scalars (JSON Schema), unlike protocol labels.
export function optionalModel(value: Json | undefined): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'Decision model must be a string')
  const text = value.v
  guard(text !== '' && cpLength(text) <= 256 && clean(text), 'Invalid decision target model')
}

export function optionalString(value: Json | undefined, limit: number): void {
  if (value === undefined) return
  guard(identifier(W.string(value), limit), 'invalid decision label')
}

const PROFILE_FORBIDDEN = ['__proto__', 'prototype', 'constructor']

export function profileName(text: string): boolean {
  if (text === '' || cpLength(text) > 128) return false
  if (!/^[A-Za-z0-9_.-]*$/.test(text)) return false
  return !PROFILE_FORBIDDEN.includes(text)
}

function optionalProfile(value: Json | undefined): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'Decision profile must be a string')
  guard(profileName(value.v), 'Invalid decision profile name')
}

export function optionalBool(value: Json | undefined): void {
  if (value === undefined || value.t === 'bool') return
  throw new Failure(22, 'expected boolean option')
}

export function optionalTemperature(value: Json | undefined): void {
  if (value !== undefined) W.decimal(value, 2n)
}

export function options(value: Json | undefined): void {
  if (value !== undefined) W.object(value)
}

// Strict RFC 4648 alphabet with canonical padding bits.
const b64 = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47
const TAIL2 = 'AQgw'
const TAIL3 = 'AEIMQUYcgkosw048'

export function base64(s: string): boolean {
  const n = s.length
  let i = 0
  while (i < n) {
    const rest = n - i
    if (rest < 4) return false
    const a = s.charCodeAt(i)
    const b = s[i + 1]!
    const c = s[i + 2]!
    const d = s[i + 3]!
    if (rest === 4 && c === '=' && d === '=') return b64(a) && TAIL2.includes(b)
    if (rest === 4 && d === '=') return b64(a) && b64(b.charCodeAt(0)) && TAIL3.includes(c)
    if (!(b64(a) && b64(b.charCodeAt(0)) && b64(c.charCodeAt(0)) && b64(d.charCodeAt(0)))) return false
    i += 4
  }
  return true
}

const blank = (s: string) => /^[ \t\n\r]*$/.test(s)

// Codec.string_cost: the budget left after a string's UTF-8 bytes.
export function stringCost(s: string, budget: number): number | null {
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!
    i += c > 0xffff ? 2 : 1
    const w = utf8Width(c)
    if (!isScalar(c) || budget < w) return null
    budget -= w
  }
  return budget
}

function imageRef(value: Json | undefined): void {
  if (value === undefined) return
  if (value.t !== 'str') throw new Failure(22, 'image ref must be a string')
  guard(!blank(value.v), 'invalid image ref')
  if (stringCost(value.v, 1024) === null) throw new Failure(22, 'image ref exceeds 1024 bytes')
}

function images(items: Json[]): void {
  for (const image of items) {
    const fields = W.object(image)
    guard(W.only(fields, ['type', 'data', 'mimeType', 'ref']), 'unknown image field')
    const t = field(image, 'type')
    guard(t === undefined || (t.t === 'str' && t.v === 'image'), 'invalid image type')
    imageRef(field(image, 'ref'))
    const data = W.string(W.need(image, 'data'))
    guard(data !== '' && base64(data), 'invalid image base64')
    const mime = W.string(W.need(image, 'mimeType'))
    guard(['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime), 'invalid image MIME type')
  }
}

function optionalImages(value: Json | undefined): void {
  if (value === undefined) return
  const items = W.array(value)
  guard(items.length <= 128, 'too many images')
  images(items)
}

// Box (one bounding box in an image) is a TypeSafe Jev 1.14 type.
function questionKind(k: string, q: Json): void {
  if (k === 'boolean') return W.noulCriteria(field(q, 'criteria'))
  if (k === 'box') {
    if (field(q, 'criteria') !== undefined) throw new Failure(22, 'Box questions take no criteria')
    return
  }
  W.questionKind(k, q)
}

function question(q: Json): void {
  const fields = W.object(q)
  guard(W.only(fields, ['type', 'instructions', 'criteria']), 'unknown question field')
  guard(W.description(W.need(q, 'instructions')), 'invalid instructions')
  questionKind(kind(W.string(W.need(q, 'type'))), q)
}

export const REQUEST_FIELDS = ['state', 'questions', 'images', 'model', 'provider', 'profile', 'api', 'endpoint', 'allowLocal', 'allowGenerated', 'providerOptions', 'temperature']

function checkRequest(value: Json): Json {
  unwrapResult(Codec.validateWithLimit(value, BYTES_MAX))
  const fields = W.object(value)
  guard(W.only(fields, REQUEST_FIELDS), 'unknown decision request field')
  guard(W.description(W.need(value, 'state')), 'invalid decision state')
  const qfields = W.object(W.need(value, 'questions'))
  guard(qfields.length >= 1 && qfields.length <= 128, 'invalid question count')
  for (const [id, q] of qfields) {
    guard(identifier(id, 128), 'invalid question id')
    question(q)
  }
  optionalModel(field(value, 'model'))
  optionalString(field(value, 'provider'), 128)
  optionalProfile(field(value, 'profile'))
  optionalString(field(value, 'api'), 128)
  optionalString(field(value, 'endpoint'), 4096)
  optionalBool(field(value, 'allowLocal'))
  optionalBool(field(value, 'allowGenerated'))
  optionalTemperature(field(value, 'temperature'))
  options(field(value, 'providerOptions'))
  optionalImages(field(value, 'images'))
  return value
}

export const validateRequest = (value: Json): Result<Json> => attempt(() => checkRequest(value))

export const request = (text: string): Result<Json> =>
  attempt(() => checkRequest(unwrapResult(Codec.readWithLimit(text, BYTES_MAX))))

export const optionalMember = (key: string, value: Json | undefined): Member[] => (value === undefined ? [] : [[key, value]])

function noOption(value: Json | undefined): void {
  if (value !== undefined) throw new Failure(22, 'option unsupported by decision API')
}

// A description as text: a string as is, anything else as its JSON.
const text = (value: Json): string => (value.t === 'str' ? value.v : unwrapResult(Codec.encodeWithLimit(value, BYTES_MAX)))

function booleanWireKind(api: string): string {
  if (api === 'system-one' || api === 'llama-system-one' || api === 'cloudflare') return 'noul'
  if (api === 'openai-decisions') return 'predicate'
  return 'boolean'
}

const wireKind = (k: string, api: string): string => (k === 'boolean' ? booleanWireKind(api) : k)

function standardQuestions(fields: Member[], api: string): Member[] {
  return fields.map(([id, q]) => {
    const typeText = W.string(W.need(q, 'type'))
    const instruction = W.need(q, 'instructions')
    const extras = optionalMember('criteria', field(q, 'criteria'))
    return [id, jobj([['type', jstr(wireKind(kind(typeText), api))], ['instructions', instruction], ...extras])] as Member
  })
}

const choiceDescription = (value: Json): Member[] => (value.t === 'null' ? [] : [['description', jstr(text(value))]])

function openaiCriteria(k: string, q: Json): Member[] {
  if (k === 'choice') {
    const fields = W.object(W.need(q, 'criteria'))
    return [['choices', jarr(fields.map(([id, d]) => jobj([['value', jstr(id)], ...choiceDescription(d)])))]]
  }
  if (k === 'score') {
    const items = W.array(W.need(q, 'criteria'))
    return [
      [
        'levels',
        jarr(
          items.map((item, i) =>
            jobj([
              ['label', jstr(String(i))],
              ['description', jstr(text(item))],
            ]),
          ),
        ),
      ],
    ]
  }
  return []
}

// Predicate has no criteria slot: the criteria go into its instructions.
function openaiInstruction(instruction: Json, k: string, criteria: Json | undefined): string {
  if (k === 'boolean' && criteria !== undefined)
    return text(
      jobj([
        ['instructions', instruction],
        ['criteria', criteria],
      ]),
    )
  return text(instruction)
}

function openaiQuestions(fields: Member[]): Json[] {
  return fields.map(([id, q]) => {
    const k = kind(W.string(W.need(q, 'type')))
    const instruction = W.need(q, 'instructions')
    const instructions = openaiInstruction(instruction, k, field(q, 'criteria'))
    const extra = openaiCriteria(k, q)
    return jobj([['name', jstr(id)], ['type', jstr(wireKind(k, 'openai-decisions'))], ['instructions', jstr(instructions)], ...extra])
  })
}

function imageParts(items: Json[]): Json[] {
  return items.map((image) => {
    const data = W.string(W.need(image, 'data'))
    const mime = W.string(W.need(image, 'mimeType'))
    return jobj([
      ['type', jstr('input_image')],
      ['image_url', jstr(`data:${mime};base64,${data}`)],
    ])
  })
}

function openaiInput(state: string, imgs: Json | undefined): Json {
  if (imgs === undefined) return jstr(state)
  const parts = imageParts(W.array(imgs))
  const content = jarr([
    jobj([
      ['type', jstr('input_text')],
      ['text', jstr(state)],
    ]),
    ...parts,
  ])
  return jarr([
    jobj([
      ['role', jstr('user')],
      ['content', content],
    ]),
  ])
}

function noImages(value: Json | undefined): void {
  if (value === undefined || (value.t === 'arr' && value.items.length === 0)) return
  throw new Failure(22, 'images unsupported by decision API')
}

// Workers AI Clef: the flat model/state/questions/images body.
function cloudflareModel(model: string): string {
  if (model === '@cf/cloudflare/clef' || model === 'clef') return 'clef'
  if (model === '@cf/cloudflare/clef-flash' || model === 'clef-flash') return 'clef-flash'
  throw new Failure(22, 'unsupported Cloudflare decision model')
}

const cloudflareId = (s: string) => /^[A-Za-z0-9_.-]*$/.test(s)
const cloudflareInstruction = (v: Json) => (v.t === 'str' ? v.v !== '' : W.description(v))

function cloudflareQuestions(fields: Member[]): void {
  for (const [id, q] of fields) {
    guard(W.label(id, 100) && cloudflareId(id), 'invalid Cloudflare question id')
    guard(cloudflareInstruction(W.need(q, 'instructions')), 'invalid Cloudflare instructions')
    const k = W.string(W.need(q, 'type'))
    if (k === 'choice') guard(W.object(W.need(q, 'criteria')).length >= 2, 'Cloudflare choice requires two options')
  }
}

const padding = (data: string): number => (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

// Decoded bytes of canonical base64 (length in scalars, as Bend counts it).
export const decodedBytes = (data: string): number => Math.max(0, Math.floor(cpLength(data) / 4) * 3 - padding(data))

// Clef and SubQ Snap: at most 4 PNG, JPEG or WebP images, 4 MiB decoded
// each and 8 MiB in total; only the media-type key's name differs.
export function flatImageRows(items: Json[], remaining: number, typeKey: string, label: string): Json[] {
  const rows: Json[] = []
  for (const image of items) {
    const data = W.string(W.need(image, 'data'))
    const mime = W.string(W.need(image, 'mimeType'))
    guard(['image/png', 'image/jpeg', 'image/webp'].includes(mime), `unsupported ${label} image MIME`)
    const n = decodedBytes(data)
    guard(n <= 4194304 && n <= remaining, `${label} decoded image byte limit`)
    remaining -= n
    rows.push(
      jobj([
        [typeKey, jstr(mime)],
        ['base64', jstr(data)],
      ]),
    )
  }
  return rows
}

function flatImages(value: Json | undefined, typeKey: string, label: string): Member[] {
  if (value === undefined) return []
  const items = W.array(value)
  guard(items.length <= 4, `${label} image count limit`)
  return [['images', jarr(flatImageRows(items, 8388608, typeKey, label))]]
}

export const cloudflareImageRows = (items: Json[], remaining: number): Json[] => flatImageRows(items, remaining, 'content_type', 'Cloudflare')

function clefBody(state: Json, qs: Member[], req: Json, model: string): string {
  noOption(field(req, 'providerOptions'))
  const selector = cloudflareModel(model)
  guard(qs.length <= 64, 'Cloudflare question count limit')
  cloudflareQuestions(qs)
  const questions = standardQuestions(qs, 'cloudflare')
  const imgs = flatImages(field(req, 'images'), 'content_type', 'Cloudflare')
  return unwrapResult(Codec.encodeWithLimit(jobj([['model', jstr(selector)], ['state', state], ['questions', jobj(questions)], ...imgs]), 13631488))
}

function cloudflareWrapped(state: Json, qs: Member[], req: Json, model: string): string {
  noImages(field(req, 'images'))
  noOption(field(req, 'providerOptions'))
  const questions = standardQuestions(qs, 'cloudflare')
  const input = jobj([
    ['state', state],
    ['questions', jobj(questions)],
  ])
  return unwrapResult(
    Codec.encodeWithLimit(
      jobj([
        ['model', jstr(model)],
        ['input', input],
      ]),
      BYTES_MAX,
    ),
  )
}

const CLEF = ['clef', 'clef-flash', '@cf/cloudflare/clef', '@cf/cloudflare/clef-flash']

function cloudflareBody(state: Json, qs: Member[], req: Json, model: string): string {
  return CLEF.includes(model) ? clefBody(state, qs, req, model) : cloudflareWrapped(state, qs, req, model)
}

function llamaBody(state: Json, qs: Member[], req: Json, model: string): string {
  noOption(field(req, 'providerOptions'))
  const questions = standardQuestions(qs, 'llama-system-one')
  const v = field(req, 'images')
  const imgs: Member[] =
    v === undefined
      ? []
      : [
          [
            'images',
            jarr(
              W.array(v).map((image) => {
                const data = W.string(W.need(image, 'data'))
                const mime = W.string(W.need(image, 'mimeType'))
                return jstr(`data:${mime};base64,${data}`)
              }),
            ),
          ],
        ]
  return unwrapResult(Codec.encodeWithLimit(jobj([['model', jstr(model)], ['state', state], ['questions', jobj(questions)], ...imgs]), BYTES_MAX))
}

const providerName = (value: Json | undefined): string => (value !== undefined && value.t === 'str' ? value.v : '')

function providerOptionKey(provider: string): string {
  if (provider === 'openrouter') return 'provider'
  if (provider === 'vercel' || provider === 'vercel-evaluate' || provider === 'vercel-decisions') return 'providerOptions'
  throw new Failure(22, 'providerOptions unsupported by decision provider')
}

const standardOptionKey = (provider: string, api: string): string => (api === 'vercel-evaluate' ? 'providerOptions' : providerOptionKey(provider))

export const typesafeRoute = (provider: string, api: string): boolean => provider === 'typesafe' && api === 'system-one'

// TypeSafe's one option is a header, not a body field: see headers.
function typesafeOptions(v: Json): Member[] {
  const fields = W.object(v)
  guard(W.only(fields, ['longContext']), 'unsupported TypeSafe option')
  optionalBool(field(v, 'longContext'))
  return []
}

function standardOptions(value: Json | undefined, provider: string, api: string): Member[] {
  if (value === undefined) return []
  if (typesafeRoute(provider, api)) return typesafeOptions(value)
  return [[standardOptionKey(provider, api), value]]
}

function openaiDirectOptions(value: Json | undefined): Member[] {
  if (value === undefined) return []
  const fields = W.object(value)
  guard(W.only(fields, ['safety_identifier']), 'unsupported OpenAI decision option')
  const s = field(value, 'safety_identifier')
  if (s !== undefined && s.t !== 'null') optionalString(s, 64)
  return fields
}

const openaiOptions = (value: Json | undefined, provider: string): Member[] =>
  provider === 'vercel-decisions' ? optionalMember('providerOptions', value) : openaiDirectOptions(value)

function typesafeFormat(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  throw new Failure(22, 'unsupported TypeSafe image MIME')
}

function typesafeRef(value: Json | undefined): string {
  if (value !== undefined && value.t === 'str') return value.v
  throw new Failure(22, 'TypeSafe images need a ref that appears in the state, instructions or criteria')
}

// Refs are unique and at most 65536 bytes together.
function typesafeAssetRows(items: Json[]): Member[] {
  const seen: string[] = []
  let budget = 65536
  return items.map((image) => {
    const ref = typesafeRef(field(image, 'ref'))
    guard(!seen.includes(ref), 'duplicate TypeSafe image ref')
    const left = stringCost(ref, budget)
    if (left === null) throw new Failure(22, 'TypeSafe image refs exceed 65536 bytes')
    const data = W.string(W.need(image, 'data'))
    const format = typesafeFormat(W.string(W.need(image, 'mimeType')))
    seen.push(ref)
    budget = left
    return [
      ref,
      jobj([
        ['type', jstr('image')],
        ['format', jstr(format)],
        ['data_base64', jstr(data)],
      ]),
    ] as Member
  })
}

const questionKinds = (fields: Member[]): string[] => fields.map(([, q]) => kind(providerName(field(q, 'type'))))
export const hasBox = (qs: Member[]): boolean => questionKinds(qs).includes('box')

function typesafeAssets(value: Json | undefined, qs: Member[]): Member[] {
  const items = value === undefined ? [] : W.array(value)
  guard(!hasBox(qs) || items.length > 0, 'Box questions need an image')
  const rows = typesafeAssetRows(items)
  return items.length === 0 ? [] : [['assets', jobj(rows)]]
}

function systemOneImages(value: Json | undefined, qs: Member[], provider: string): Member[] {
  if (provider === 'subq') return flatImages(value, 'mediaType', 'SubQ')
  if (provider === 'typesafe') return typesafeAssets(value, qs)
  noImages(value)
  return []
}

function nativeBodyFor(state: Json, qs: Member[], req: Json, api: string, model: string): string {
  if (api === 'cloudflare') return cloudflareBody(state, qs, req, model)
  if (api === 'llama-system-one') return llamaBody(state, qs, req, model)
  if (api === 'openai-decisions') {
    const extras = openaiOptions(field(req, 'providerOptions'), providerName(field(req, 'provider')))
    const stateText = text(state)
    const input = openaiInput(stateText, field(req, 'images'))
    const questions = openaiQuestions(qs)
    return unwrapResult(Codec.encodeWithLimit(jobj([['model', jstr(model)], ['input', input], ['questions', jarr(questions)], ...extras]), BYTES_MAX))
  }
  guard(['system-one', 'vercel-evaluate'].includes(api), 'unsupported decision API')
  const provider = api === 'system-one' ? providerName(field(req, 'provider')) : ''
  const subq = provider === 'subq'
  const imgs = systemOneImages(field(req, 'images'), qs, provider)
  const questions = standardQuestions(qs, api)
  const extras: Member[] = [['model', jstr(model)], ...standardOptions(field(req, 'providerOptions'), providerName(field(req, 'provider')), api)]
  return unwrapResult(Codec.encodeWithLimit(jobj([['state', state], ['questions', jobj(questions)], ...extras, ...imgs]), subq ? 13631488 : BYTES_MAX))
}

function nativeBody(req: Json, api: string, model: string): string {
  noOption(field(req, 'temperature'))
  const state = W.need(req, 'state')
  const qfields = W.object(W.need(req, 'questions'))
  return nativeBodyFor(state, qfields, req, api, model)
}

function generatedOptions(value: Json | undefined, temperature: Json | undefined, api: string): Json {
  const fields = value === undefined ? [] : W.object(value)
  if (temperature === undefined) return jobj(fields)
  guard(api === 'google', 'temperature unsupported by decision API')
  guard(!W.named(fields, 'temperature'), 'duplicate temperature option')
  return jobj([['temperature', temperature], ...fields])
}

function generatedBody(req: Json, api: string, model: string): string {
  const state = W.need(req, 'state')
  const qs = W.need(req, 'questions')
  const opts = generatedOptions(field(req, 'providerOptions'), field(req, 'temperature'), api)
  const imgs = optionalMember('images', field(req, 'images'))
  const projected = jobj([['state', state], ['questions', qs], ['model', jstr(model)], ['providerOptions', opts], ...imgs])
  return unwrapResult(Generated.body(projected, api, model))
}

function bodyFor(req: Json, api: string, model: string): string {
  if (api === 'anthropic' || api === 'google') return generatedBody(req, api, model)
  return nativeBody(req, api, model)
}

function boxRoute(req: Json, api: string): void {
  const qfields = W.object(W.need(req, 'questions'))
  guard(!hasBox(qfields) || typesafeRoute(providerName(field(req, 'provider')), api), 'Box questions are supported only by TypeSafe')
}

// DecisionWire.body: the API's request body for the resolved model.
export const body = (value: Json, api: string, model: string): Result<string> =>
  attempt(() => {
    const checked = checkRequest(value)
    optionalModel(jstr(model))
    boxRoute(checked, api)
    return bodyFor(checked, api, model)
  })

const flag = (options: Json | undefined, key: string): boolean => {
  if (options === undefined) return false
  const v = field(options, key)
  return v !== undefined && v.t === 'bool' && v.v
}

const nonempty = (value: Json | undefined): boolean => value !== undefined && value.t === 'arr' && value.items.length > 0

export const TYPESAFE_IMAGES = 'TypeSafe-Danger-Zone-Images: true'
export const TYPESAFE_LONG_CONTEXT = 'TypeSafe-Danger-Zone-Long-Context: true'

// TypeSafe answers images, Box questions and long context only behind these
// opt-in headers; sending images or asking for long context is the opt-in.
export function headers(req: Json, provider: string, api: string): string[] {
  if (!typesafeRoute(provider, api)) return []
  return [...(nonempty(field(req, 'images')) ? [TYPESAFE_IMAGES] : []), ...(flag(field(req, 'providerOptions'), 'longContext') ? [TYPESAFE_LONG_CONTEXT] : [])]
}

// ---- Usage -------------------------------------------------------------------------

export type Counts = [bigint, bigint] | null

// Missing usage is distinct from zero; malformed partial usage fails.
const count = (value: Json | undefined): bigint | null => (value === undefined || value.t === 'null' ? null : W.scalar(value, 0, W.NAT_MAX))

function usageCounts(u: Json, inputKey: string, outputKey: string): Counts {
  W.object(u)
  const i = count(field(u, inputKey))
  const o = count(field(u, outputKey))
  return i !== null && o !== null ? [i, o] : null
}

function maybeUsageOf(value: Json | undefined, i: string, o: string): Counts {
  if (value === undefined || value.t === 'null') return null
  return usageCounts(value, i, o)
}

export const maybeUsage = (value: Json | undefined, i: string, o: string): Result<Counts> => attempt(() => maybeUsageOf(value, i, o))

export const reportedUsage = (value: Json): Result<Counts> =>
  attempt(() => {
    const checked = unwrapResult(Codec.validateWithLimit(value, BYTES_MAX))
    W.object(checked)
    return maybeUsageOf(field(checked, 'usage'), 'input_tokens', 'output_tokens')
  })

function cloudflareNested(value: Json, state: Json | undefined): Json {
  if (state === undefined) return value
  if (state.t === 'str') {
    guard(state.v === 'Completed', 'Cloudflare decision not completed')
    return W.need(value, 'result')
  }
  throw new Failure(22, 'Cloudflare decision not completed')
}

function cloudflareResult(value: Json): Json {
  const result = W.need(value, 'result')
  return cloudflareNested(result, field(result, 'state'))
}

function rawCounts(value: Json, api: string): Counts {
  switch (api) {
    case 'cloudflare':
      return maybeUsageOf(field(cloudflareResult(value), 'usage'), 'input_tokens', 'output_tokens')
    case 'vercel-evaluate':
      return maybeUsageOf(field(value, 'usage'), 'inputTokens', 'outputTokens')
    case 'google':
    case 'anthropic':
      return usageCounts(unwrapResult(Generated.rawUsage(value, api)), 'input_tokens', 'output_tokens')
    case 'system-one':
    case 'llama-system-one':
    case 'openai-decisions':
      return maybeUsageOf(field(value, 'usage'), 'input_tokens', 'output_tokens')
    default:
      throw new Failure(22, 'unsupported decision API')
  }
}

// The provider's reported token counts, read apart from its answers.
export const rawUsage = (text: string, api: string): Result<Counts> =>
  attempt(() => {
    const value = unwrapResult(Codec.readWithLimit(text, BYTES_MAX))
    W.object(value)
    return rawCounts(value, api)
  })

const nullDefault = (value: Json | undefined): Json => value ?? NULL

const NULL_USAGE = (): Json =>
  jobj([
    ['input_tokens', NULL],
    ['output_tokens', NULL],
  ])

function normalizedUsage(value: Json | undefined, i: string, o: string): Json {
  if (value === undefined || value.t === 'null') return NULL_USAGE()
  usageCounts(value, i, o)
  return jobj([
    ['input_tokens', nullDefault(field(value, i))],
    ['output_tokens', nullDefault(field(value, o))],
  ])
}

const responseUsage = (value: Json, api: string): Json =>
  api === 'vercel-evaluate' ? normalizedUsage(field(value, 'usage'), 'inputTokens', 'outputTokens') : normalizedUsage(field(value, 'usage'), 'input_tokens', 'output_tokens')

// ---- Replies -----------------------------------------------------------------------

function unwrap(value: Json, api: string): Json {
  switch (api) {
    case 'cloudflare': {
      const s = W.need(value, 'success')
      if (!(s.t === 'bool' && s.v)) throw new Failure(22, 'Cloudflare decision failed')
      return cloudflareResult(value)
    }
    case 'anthropic':
    case 'google':
      return unwrapResult(Generated.unwrap(value, api))
    case 'system-one':
    case 'llama-system-one':
    case 'openai-decisions':
    case 'vercel-evaluate':
      return value
    default:
      throw new Failure(22, 'unsupported decision API')
  }
}

function answerMap(items: Json[]): Member[] {
  const seen: string[] = []
  return items.map((a) => {
    const name = W.string(W.need(a, 'name'))
    guard(!seen.includes(name), 'duplicate answer name')
    seen.push(name)
    return [name, a] as Member
  })
}

const responseAnswers = (value: Json, api: string): Json => (api === 'openai-decisions' ? jobj(answerMap(W.array(value))) : jobj(W.object(value)))

function confidence(value: Json | undefined): Member[] {
  if (value === undefined) return []
  W.probability(value)
  return [['confidence', value]]
}

// Each row's value, never its position or label; probability lexemes kept.
const distributionKey = (value: Json, k: string): string => (k === 'score' ? W.scalar(value, 0, 9n).toString() : W.string(value))

function distributionRows(items: Json[], k: string): Member[] {
  const seen: string[] = []
  return items.map((row) => {
    const key = distributionKey(W.need(row, 'value'), k)
    guard(!seen.includes(key), 'duplicate probability value')
    const p = W.need(row, 'probability')
    seen.push(key)
    return [key, p] as Member
  })
}

const distributionObject = (value: Json, k: string, api: string): Json =>
  api === 'openai-decisions' ? jobj(distributionRows(W.array(value), k)) : jobj(W.object(value))

function probabilities(value: Json | undefined, expected: Member[], k: string, api: string): Member[] {
  if (value === undefined) return []
  const p = distributionObject(value, k, api)
  const fields = W.object(p)
  guard(fields.length === expected.length, 'probability key count mismatch')
  const sum = W.probabilitySum(expected, p)
  guard(W.withinTolerance(sum), 'probability mass outside tolerance')
  return [['probabilities', jobj(W.ordered(expected, p))]]
}

const common = (answer: Json, expected: Member[], k: string, api: string): Member[] => [
  ...confidence(field(answer, 'confidence')),
  ...probabilities(field(answer, 'probabilities'), expected, k, api),
]

const before = (a: Decimal, b: Decimal) => !W.decimalLe(b, a)

// Edges are fractions of the image from its top-left corner; lexemes kept.
function boxEdges(value: Json): Json {
  const fields = W.object(value)
  guard(W.only(fields, ['top', 'bottom', 'left', 'right']), 'unknown box edge')
  const top = W.need(value, 'top')
  const bottom = W.need(value, 'bottom')
  const left = W.need(value, 'left')
  const right = W.need(value, 'right')
  const [t, b, l, r] = [W.probability(top), W.probability(bottom), W.probability(left), W.probability(right)]
  guard(before(t, b) && before(l, r), 'empty or inverted box')
  return jobj([
    ['top', top],
    ['bottom', bottom],
    ['left', left],
    ['right', right],
  ])
}

function answerKind(k: string, q: Json, a: Json, actual: string, api: string): Json {
  switch (k) {
    case 'boolean': {
      const p = actual === 'noul' ? W.need(a, 'noul') : W.need(a, 'probability')
      W.probability(p)
      return jobj([['type', jstr('boolean')], ['probability', p], ...confidence(field(a, 'confidence'))])
    }
    case 'choice': {
      const expected = W.object(W.need(q, 'criteria'))
      const selected = W.need(a, 'choice')
      guard(W.named(expected, W.string(selected)), 'unknown selected choice')
      return jobj([['type', jstr('choice')], ['choice', selected], ...common(a, expected, 'choice', api)])
    }
    case 'score': {
      const levels = W.array(W.need(q, 'criteria'))
      const expected = W.indexed(levels)
      const score = W.need(a, 'score')
      W.decimal(score, BigInt(Math.max(0, levels.length - 1)))
      return jobj([['type', jstr('score')], ['score', score], ['legend', jobj(expected)], ...common(a, expected, 'score', api)])
    }
    case 'box': {
      const edges = boxEdges(W.need(a, 'box'))
      return jobj([['type', jstr('box')], ['box', edges], ...confidence(field(a, 'confidence'))])
    }
    default:
      throw new Failure(22, 'unknown answer type')
  }
}

function answer(q: Json, a: Json, api: string): Json {
  W.object(a)
  const actual = W.string(W.need(a, 'type'))
  if (actual === 'refusal') return a
  const k = kind(W.string(W.need(q, 'type')))
  guard(k === kind(actual), 'answer type mismatch')
  return answerKind(k, q, a, actual, api)
}

function responseModel(value: Json | undefined, fallback: string): Json {
  if (value === undefined) {
    optionalModel(jstr(fallback))
    return jstr(fallback)
  }
  optionalModel(value)
  return value
}

export const provenance = (api: string): string => (api === 'anthropic' || api === 'google' ? 'generated' : 'native')

function withRefusal(actual: Json, qs: Member[], refusal: Json | undefined, api: string): Json {
  if (refusal === undefined) return responseAnswers(actual, api)
  guard(api === 'anthropic' || api === 'google', 'unexpected global refusal')
  W.string(refusal)
  guard(W.object(actual).length === 0, 'ambiguous global refusal')
  return jobj(
    qs.map(([id]) => [
      id,
      jobj([
        ['type', jstr('refusal')],
        ['reason', refusal],
      ]),
    ]),
  )
}

// DecisionWire.reply: the provider's text as a normalized, lossless reply.
export const reply = (text: string, req: Json, provider: string, api: string, model: string): Result<Json> =>
  attempt(() => {
    const checked = checkRequest(req)
    guard(identifier(provider, 128), 'invalid resolved provider')
    const raw = unwrapResult(Codec.readWithLimit(text, BYTES_MAX))
    const value = unwrap(raw, api)
    const usage = responseUsage(value, api)
    const returnedModel = responseModel(field(value, 'model'), model)
    const qfields = W.object(W.need(checked, 'questions'))
    const actual = withRefusal(W.need(value, 'answers'), qfields, field(value, 'refusal'), api)
    const afields = W.object(actual)
    guard(qfields.length === afields.length, 'answer key count mismatch')
    const safe: Member[] = qfields.map(([id, q]) => [id, answer(q, W.need(actual, id), api)])
    const result = jobj([
      ['provider', jstr(provider)],
      ['api', jstr(api)],
      ['model', returnedModel],
      ['answers', jobj(safe)],
      ['usage', usage],
      ['provenance', jobj([['kind', jstr(provenance(api))]])],
      ['raw', raw],
      ['rawJson', jstr(text)],
    ])
    // The complete serialized envelope must fit too.
    unwrapResult(Codec.encodeWithLimit(result, BYTES_MAX))
    return result
  })
