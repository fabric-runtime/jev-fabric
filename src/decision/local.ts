// The llama.cpp chat readout driver (native/DecisionLocal.bend): NOT the
// dedicated SystemOne classifier. Each question is rendered through the
// server's chat template, each label verified to be one token, and the
// one next-token distribution read (deepening n_probs 256.., 4096, 32768
// as distinct readouts, never retries). Every HTTP call spends from one
// deadline; every response is retained byte for byte in `raw` (8 MiB at
// most). A failure after dispatch is a status:error envelope, never lost.

import * as Codec from '../codec/codec.ts'
import type {Json} from '../codec/json.ts'
import {field, jarr, jbool, jnum, jobj, jstr, NULL} from '../codec/json.ts'
import type {Result} from '../codec/result.ts'
import {Failure, done, unwrap} from '../codec/result.ts'
import type {Transport} from './http.ts'
import * as Http from './http.ts'
import * as Core from './local-core.ts'
import * as Math_ from './math.ts'
import * as W from './w.ts'

export {preflight} from './local-core.ts'

type Bag = {left: number; raw: Json[]; input: bigint | null; output: bigint | null; had: boolean; pending: boolean}

type Context = {root: string; key: string; model: string; started: number; timeout: number; allowLocal: boolean; temperature: string; prefix: string}

export type LocalDeps = {transport: Transport; now?: () => number; signal?: AbortSignal}

function remaining(ctx: Context, now: number): number {
  const left = ctx.timeout - Math.max(0, now - ctx.started)
  if (!(left > 0)) throw new Failure(22, 'local evaluation deadline expired')
  return left
}

// Raw AST and escaped rawJson are both charged against the allowance.
function retain(bag: Bag, path: string, depth: Json, body: Json, text: string, status: number): void {
  const entry = jobj([
    ['path', jstr(path)],
    ['n_probs', depth],
    ['httpStatus', jnum(String(status))],
    ['body', body],
    ['text', jstr(text)],
  ])
  const cost = (() => {
    const serialized = Codec.encodeProfile(entry, Core.LIMIT, 400000)
    if (!serialized.ok) return null
    const charged = Codec.encodeProfile(
      jobj([
        ['raw', entry],
        ['rawJson', jstr(serialized.value)],
      ]),
      Core.LIMIT,
      400000,
    )
    if (!charged.ok) return null
    if (!Codec.encodeProfile(jarr([entry, ...bag.raw]), Core.LIMIT, 400000).ok) return null
    const bytes = new TextEncoder().encode(charged.value).length
    return bytes <= bag.left ? bag.left - bytes : null
  })()
  if (cost === null) throw new Failure(22, 'local raw retention byte/work limit; current response not retained')
  bag.left = cost
  bag.raw = [entry, ...bag.raw]
}

function capturedCount(value: Json | undefined): bigint | null {
  if (value === undefined) return null
  try {
    return W.scalar(value, 0, W.NAT_MAX)
  } catch (e) {
    if (e instanceof Failure) return null
    throw e
  }
}

const addCount = (a: bigint | null, b: bigint | null): bigint | null => (a !== null && b !== null && b <= W.NAT_MAX - a ? a + b : null)

function account(bag: Bag, completion: boolean, value: Json): void {
  if (!completion) return
  bag.input = addCount(bag.input, capturedCount(field(value, 'tokens_evaluated')))
  bag.output = addCount(bag.output, capturedCount(field(value, 'tokens_predicted')))
  bag.had = true
  bag.pending = false
}

// The opt-in work allowance for 32768-entry readouts, never global.
const readout = (text: string, large: boolean): Result<Json> => (large ? Codec.readProfile(text, Core.LIMIT, 524288) : Codec.readWithLimit(text, Core.LIMIT))

async function post(bag: Bag, ctx: Context, path: string, body: Json, deps: LocalDeps): Promise<Json> {
  const encoded = unwrap(Codec.encodeWithLimit(body, Core.LIMIT))
  const now = deps.now ?? Date.now
  const ms = remaining(ctx, now())
  const completion = path === '/completion'
  bag.pending ||= completion
  const exchange = unwrap(await Http.exchange(ctx.root + path, ctx.key, encoded, ms, ctx.allowLocal, 'bearer', deps.transport, deps.signal))
  const depth = field(body, 'n_probs') ?? NULL
  const decoded = Codec.decodeUtf8WithLimit(exchange.bytes, Core.LIMIT)
  let value: Json
  if (!decoded.ok) {
    // Invalid UTF-8 has no JSON AST: the exact bytes are kept as base64.
    retain(
      bag,
      path,
      depth,
      jobj([
        ['encoding', jstr('base64')],
        ['data', jstr(Buffer.from(exchange.bytes).toString('base64'))],
      ]),
      '',
      exchange.status,
    )
    throw new Failure(decoded.error.code, decoded.error.message)
  }
  const parsed = readout(decoded.value, completion)
  if (!parsed.ok) {
    retain(bag, path, depth, NULL, decoded.value, exchange.status)
    throw new Failure(parsed.error.code, parsed.error.message)
  }
  value = parsed.value
  account(bag, completion, value)
  retain(bag, path, depth, value, decoded.value, exchange.status)
  if (!(exchange.status >= 200 && exchange.status < 300)) throw new Failure(exchange.status, `local decision HTTP status ${exchange.status}`)
  remaining(ctx, now())
  return value
}

async function tokenize(bag: Bag, ctx: Context, content: string, deps: LocalDeps): Promise<string[]> {
  const value = await post(
    bag,
    ctx,
    '/tokenize',
    jobj([
      ['model', jstr(ctx.model)],
      ['content', jstr(content)],
      ['add_special', jbool(false)],
      ['parse_special', jbool(false)],
    ]),
    deps,
  )
  return W.array(W.need(value, 'tokens')).map(Core.tokenValue)
}

async function labelTokens(bag: Bag, ctx: Context, labels: Core.Label[], newline: string[], deps: LocalDeps): Promise<string[]> {
  const seen: string[] = []
  for (const label of labels) {
    const tokens = await tokenize(bag, ctx, `\n${label.token}`, deps)
    let id = Core.prefixedId(newline, tokens)
    if (id === null) {
      const alone = await tokenize(bag, ctx, label.token, deps)
      if (alone.length !== 1) throw new Failure(22, 'local answer label is not a single token')
      id = alone[0]!
    }
    if (seen.includes(id)) throw new Failure(22, 'local answer labels share a token')
    seen.push(id)
  }
  return seen
}

async function renderPrompt(bag: Bag, ctx: Context, task: string, deps: LocalDeps): Promise<string> {
  const value = await post(
    bag,
    ctx,
    '/apply-template',
    jobj([
      ['model', jstr(ctx.model)],
      [
        'messages',
        jarr([
          jobj([
            ['role', jstr('system')],
            ['content', jstr(Core.SYSTEM)],
          ]),
          jobj([
            ['role', jstr('user')],
            ['content', jstr(ctx.prefix + task)],
          ]),
        ]),
      ],
      ['chat_template_kwargs', jobj([['enable_thinking', jbool(false)]])],
    ]),
    deps,
  )
  return Core.closeThink(W.string(W.need(value, 'prompt')))
}

async function readDepths(bag: Bag, ctx: Context, prompt: string, ids: string[], depths: number[], deps: LocalDeps): Promise<string[]> {
  for (const depth of depths) {
    const value = await post(
      bag,
      ctx,
      '/completion',
      jobj([
        ['model', jstr(ctx.model)],
        ['prompt', jstr(prompt)],
        ['n_predict', jnum('1')],
        ['n_probs', jnum(String(depth))],
        ['post_sampling_probs', jbool(false)],
        ['cache_prompt', jbool(true)],
        ['temperature', jnum('0')],
      ]),
      deps,
    )
    const logs = Core.collectLogs(ids, Core.distribution(value))
    if (logs !== null) return logs
  }
  throw new Failure(22, 'local labels missing from top 32768 tokens')
}

async function answer(bag: Bag, ctx: Context, plan: Core.Plan, deps: LocalDeps): Promise<Json> {
  const newline = await tokenize(bag, ctx, '\n', deps)
  const ids = await labelTokens(bag, ctx, plan.labels, newline, deps)
  const prompt = await renderPrompt(bag, ctx, plan.task, deps)
  const depth = Math.max(256, 16 * ids.length)
  const logs = await readDepths(bag, ctx, prompt, ids, [depth, 4096, 32768], deps)
  const encoded = unwrap(Math_.statistics(ctx.temperature, logs.join('\n')))
  const stats = unwrap(Codec.read(encoded))
  const fields = Core.answerFields(plan.kind, plan.labels, stats)
  remaining(ctx, (deps.now ?? Date.now)())
  return jobj([
    ...fields,
    [
      'provenance',
      jobj([
        ['kind', jstr('token-logprobs')],
        ['nativeProbabilities', jbool(false)],
        ['method', jstr('label-softmax')],
        ['temperature', jnum(ctx.temperature)],
        ['labels', jarr(Core.labelMapping(plan.labels, ids, logs))],
      ]),
    ],
  ])
}

const countJson = (value: bigint | null, known: boolean): Json => (value !== null && known ? jnum(value.toString()) : NULL)

function envelope(provider: string, model: string, bag: Bag, answers: Json, status: string, error: Json): Result<Json> {
  const original = jarr([...bag.raw].reverse())
  const rawJson = Codec.encodeProfile(original, Core.LIMIT, 524288)
  if (!rawJson.ok) return rawJson
  const known = bag.had && !bag.pending
  return Codec.validateProfile(
    jobj([
      ['provider', jstr(provider)],
      ['api', jstr('llama-cpp')],
      ['model', jstr(model)],
      ['status', jstr(status)],
      ['error', error],
      ['answers', answers],
      [
        'usage',
        jobj([
          ['input_tokens', countJson(bag.input, known)],
          ['output_tokens', countJson(bag.output, known)],
        ]),
      ],
      [
        'provenance',
        jobj([
          ['kind', jstr('token-logprobs')],
          ['nativeProbabilities', jbool(false)],
          ['method', jstr('label-softmax')],
        ]),
      ],
      ['raw', original],
      ['rawJson', jstr(rawJson.value)],
      ['rawComplete', jbool(status === 'ok')],
    ]),
    Core.LIMIT,
    524288,
  )
}

// DecisionLocal.evaluate: a Fail is predispatch validation; anything after
// dispatch is an envelope (status:error with what was retained).
export async function evaluate(
  request: Json,
  provider: string,
  model: string,
  endpoint: string,
  key: string,
  timeout: number,
  allowLocal: boolean,
  deps: LocalDeps,
): Promise<Result<Json>> {
  const started = (deps.now ?? Date.now)()
  const prepared = Core.preparedFor(request, provider, model, timeout, allowLocal)
  if (!prepared.ok) return prepared
  const ctx: Context = {
    root: Core.serverRoot(endpoint),
    key,
    model,
    started,
    timeout,
    allowLocal,
    temperature: prepared.value.temperature,
    prefix: prepared.value.prefix,
  }
  const bag: Bag = {left: 8388608, raw: [], input: 0n, output: 0n, had: false, pending: false}
  try {
    const answers = []
    for (const plan of prepared.value.plans) answers.push([plan.id, await answer(bag, ctx, plan, deps)] as [string, Json])
    return envelope(provider, model, bag, jobj(answers), 'ok', NULL)
  } catch (e) {
    if (!(e instanceof Failure)) throw e
    return envelope(
      provider,
      model,
      bag,
      jobj([]),
      'error',
      jobj([
        ['code', jnum(String(e.code))],
        ['message', jstr(e.message)],
      ]),
    )
  }
}

export {done}
