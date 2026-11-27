// Pure policy for `serve` (native/ServeCore.bend): one JSON request per input
// line, one JSON response per output line. ./serve.ts performs the reads,
// prints and subprocess calls. Protocol 2 answers requests concurrently:
// responses may come out of order and are matched by id.
//
// Pure: no IO. Every function answers from its arguments alone.

import * as Cli from '../cli/core.ts'
import * as Codec from '../codec/codec.ts'
import type {Json, Member} from '../codec/json.ts'
import {findField} from '../codec/json.ts'
import {quote} from '../codec/print.ts'
import type {Err, Result} from '../codec/result.ts'
import {attempt, done, fail, Failure} from '../codec/result.ts'
import {cpLength, cpTake, readNat, trim} from '../codec/text.ts'
import * as Wire from '../codec/wire.ts'
import * as DecisionWire from '../decision/wire.ts'
import * as Jobs from '../jobs/core.ts'
import * as Streams from '../jobs/streams.ts'
import * as Store from '../store/core.ts'
import * as Time from '../time/core.ts'

/** Protocol, features and capabilities are the CLI's (Cli.capabilities), so `capabilities` and the banner agree. */
export const PROTOCOL = Cli.PROTOCOL
export const FEATURES: readonly string[] = Cli.FEATURES
export const capabilities = Cli.capabilities

/** A request line has the strict JSON bound; a longer partial line ends the session. */
export const LINE_MAX = 16777216
/** stdout and stderr each capture up to this many bytes from a CLI child. */
export const CAPTURE_MAX = 1048577
/** 64 argv entries per child, less the longest CLI prefix (exec's seven). */
export const ARGV_MAX = 57
/** Time a CLI child keeps after its own deadline to print its receipt. */
export const GRACE = 2000
/** Upper bound for status, events, stop and start's readiness handshake. */
export const CONTROL_MAX = 15000
/** A session ends after this many input reads; each read returns at least one byte. */
export const READS_MAX = 16777216
/** Bytes framed per read, as 0.8.1 read them. */
export const READ_CHUNK = 65536
/** The longest a request may run: an hour (Time.max_timeout). */
export const MAX_TIMEOUT = 3600000

// ---------------------------------------------------------------------------
// Line framing. `pending` holds the current partial line's pieces in order.

export type Framer = {pending: Uint8Array[]; size: number}
export const framer = (): Framer => ({pending: [], size: 0})

const joined = (pieces: readonly Uint8Array[]): Uint8Array => {
  if (pieces.length === 1) return pieces[0]!
  let n = 0
  for (const p of pieces) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of pieces) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A finished line, without a CRLF's carriage return. */
export function line(pieces: readonly Uint8Array[]): Uint8Array {
  const bytes = joined(pieces)
  return bytes.length > 0 && bytes[bytes.length - 1] === 13 ? bytes.subarray(0, bytes.length - 1) : bytes
}

/** ServeCore.frame: the lines `bytes` finishes, in order, and the partial line left (its size counts every byte). */
export function frame(f: Framer, bytes: Uint8Array): {lines: Uint8Array[]; framer: Framer} {
  const lines: Uint8Array[] = []
  let pending = f.pending
  let size = f.size
  let from = 0
  for (;;) {
    const nl = bytes.indexOf(10, from)
    if (nl < 0) break
    lines.push(line([...pending, bytes.subarray(from, nl)]))
    pending = []
    size = 0
    from = nl + 1
  }
  if (from < bytes.length) {
    pending = [...pending, bytes.slice(from)]
    size += bytes.length - from
  }
  return {lines, framer: {pending, size}}
}

/** Whether the partial line has grown past any valid request. */
export const overflowed = (f: Framer): boolean => f.size > LINE_MAX

/** The unterminated last line at end of input, if any. */
export const last = (f: Framer): Uint8Array[] => (f.pending.length === 0 ? [] : [line(f.pending)])

// ---------------------------------------------------------------------------
// Session options: `serve <timeout-ms> [max-evaluations [max-tokens]]`, the
// timeout already chosen by the CLI (--timeout-ms, else JEV_FABRIC_TIMEOUT_MS).

/** Serve.serve: the deadline the CLI chose, 1..86400000 ms. */
export function deadline(raw: string | undefined): Result<number> {
  const ms = raw === undefined ? null : readU32(raw)
  return ms === null ? fail(2, 'serve timeout must be 1..86400000 milliseconds') : done(ms)
}

const BUDGETS = 'serve budgets must be integers: [max-evaluations [max-tokens]]'

const count = (raw: string): Result<number> => {
  const n = readU32(raw)
  return n === null ? fail(2, BUDGETS) : done(n)
}

/** U32.read: decimal digits that fit 32 bits. */
export function readU32(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null
  const n = readNat(raw)
  return n !== null && n <= 4294967295n ? Number(n) : null
}

/** ServeCore.budget: `[max-evaluations [max-tokens]]`, defaults 1 and 100000 as for `jev`. */
export function budget(args: readonly string[]): Result<[number, number]> {
  if (args.length === 0) return done([1, 100000])
  const calls = count(args[0]!)
  if (!calls.ok) return calls
  if (args.length === 1) return done([calls.value, 100000])
  if (args.length === 2) {
    const tokens = count(args[1]!)
    return tokens.ok ? done([calls.value, tokens.value]) : tokens
  }
  return fail(2, 'usage: serve [--timeout-ms N] [max-evaluations [max-tokens]]')
}

export const banner = (version: string, platform: string, timeout: number, calls: number, tokens: number): string =>
  `{"ready":{"protocol":${PROTOCOL},"version":${quote(version)},"timeoutMs":${timeout},"maxEvaluations":${calls},"maxTokens":${tokens}` +
  `,"store":${Store.version},"platform":${quote(platform)},"features":${Cli.featuresJson()}}}`

// ---------------------------------------------------------------------------
// Requests.

export type Op =
  | {op: 'exec'; argv: string[]; input: string; timeout: number | null; cwd: string}
  | {op: 'start'; argv: string[]; timeout: number | null; label: string; cwd: string; pipe: boolean}
  | {op: 'spawn'; argv: string[]; pipe: boolean; timeout: number | null; label: string; cwd: string}
  | {op: 'status'; job: string}
  | {op: 'events'; job: string; after: number; wait: number | null}
  | {op: 'wait'; job: string; timeout: number | null}
  | {op: 'stop'; job: string}
  | {op: 'watch'; job: string; literal: string; timeout: number | null}
  | {op: 'write'; job: string; text: string}
  | {op: 'closeInput'; job: string}
  | {op: 'read'; job: string; stream: string; offset: number; max: number; wait: number | null; base64: boolean}
  | {op: 'list'; sessions: boolean}
  | {op: 'capabilities'}
  | {op: 'validate'; request: Json}
  | {op: 'decisionProviders'}
  | {op: 'resolveDecision'; request: Json}
  | {op: 'validateDecision'; request: Json}
  | {op: 'decide'; request: Json; timeout: number | null; credential: string}
  | {op: 'jev'; request: Json; timeout: number | null; provider: string; credential: string}

const bad = (message: string): never => {
  throw new Failure(2, message)
}
const check = (ok: boolean, message: string, code = 2) => {
  if (!ok) throw new Failure(code, message)
}

const objectOf = (value: Json): Member[] => (value.t === 'obj' ? value.fields : bad('request must be a JSON object'))

/** The id to echo: a string or number, else null. Validation reports a bad id. */
export function id(value: Json): Json {
  const found = value.t === 'obj' ? findField(value.fields, 'id') : undefined
  return found !== undefined && (found.t === 'str' || found.t === 'num') ? found : Codec.NULL
}

function idValid(found: Json | undefined): void {
  if (found === undefined || found.t === 'num') return
  if (found.t === 'str') return check(cpLength(found.v) <= 128, 'id must be at most 128 characters', 22)
  bad('id must be a string or number')
}

const need = (fields: readonly Member[], key: string): Json => findField(fields, key) ?? bad(`missing field: ${key}`)
const string = (value: Json, key: string): string => (value.t === 'str' ? value.v : bad(`${key} must be a string`))
const text = (fields: readonly Member[], key: string): string => string(need(fields, key), key)
const optionalText = (found: Json | undefined, key: string): string => (found === undefined ? '' : string(found, key))

/** An id can never start with "-", so it is never read as a CLI option. */
function job(fields: readonly Member[]): string {
  const raw = text(fields, 'job')
  check(raw !== '' && !raw.startsWith('-'), 'job must be an id returned by start')
  return raw
}

const timeoutError = (max: number) => `timeoutMs must be an integer from 1 to ${max}`

/** An integer lexeme within 1..max (TimeCore.parse), or the message. */
function within(value: Json, max: number, message: string): number {
  if (value.t !== 'num') return bad(message)
  const ms = Time.parse(value.lex, max)
  return ms.ok ? ms.value : bad(message)
}

function timeout(fields: readonly Member[], max: number): number | null {
  const found = findField(fields, 'timeoutMs')
  return found === undefined ? null : within(found, max, timeoutError(max))
}

const WAIT_ERROR = 'waitMs must be an integer from 1 to 300000'

/** `waitMs`: an optional long poll, 1..300000 ms, like `watch`. */
function waitMs(fields: readonly Member[]): number | null {
  const found = findField(fields, 'waitMs')
  return found === undefined ? null : within(found, 300000, WAIT_ERROR)
}

/** `label`: checked exactly as the CLI's --label; absent means none. */
function label(found: Json | undefined): string {
  if (found === undefined) return ''
  if (found.t !== 'str') return bad('label must be a string')
  const checked = Jobs.labelChecked(found.v)
  return checked.ok ? checked.value : bad(checked.error.message)
}

export const cwdChecked = Cli.cwdChecked

function cwd(fields: readonly Member[]): string {
  const found = findField(fields, 'cwd')
  if (found === undefined) return ''
  if (found.t !== 'str') return bad('cwd must be a string')
  const checked = cwdChecked(found.v)
  return checked.ok ? checked.value : bad(checked.error.message)
}

/** One of `choices`, or absent (the fallback). */
function choice(found: Json | undefined, fallback: string, choices: readonly string[], message: string): string {
  if (found === undefined) return fallback
  return found.t === 'str' && choices.includes(found.v) ? found.v : bad(message)
}

const CURSOR_ERROR = 'after must be an event sequence number'

function cursor(fields: readonly Member[]): number {
  const found = findField(fields, 'after')
  if (found === undefined) return 0
  const n = found.t === 'num' ? natOf(found.lex) : null
  return n !== null && n <= 4294967295n ? Number(n) : bad(CURSOR_ERROR)
}

/** Nat.read: decimal digits only. */
const natOf = (lex: string): bigint | null => (/^[0-9]+$/.test(lex) ? readNat(lex) : null)

const OFFSET_ERROR = 'offset must be a byte offset (a non-negative integer)'

function offset(found: Json | undefined): number {
  if (found === undefined) return 0
  const n = found.t === 'num' ? natOf(found.lex) : null
  return n === null ? bad(OFFSET_ERROR) : Number(n)
}

const MAX_ERROR = 'max must be an integer from 1 to 65536'
const maxOf = (found: Json | undefined): number => (found === undefined ? 65536 : within(found, 65536, MAX_ERROR))

/** `write.text`: at most 65536 Unicode characters, like Session.write. */
function writeText(fields: readonly Member[]): string {
  const raw = text(fields, 'text')
  check(cpLength(raw) <= 65536, 'text must be at most 65536 characters')
  return raw
}

const CREDENTIAL_ERROR = 'credential must be a non-empty string'

/** A per-request credential: a non-empty string, never echoed back. */
function credential(found: Json | undefined): string {
  if (found === undefined) return ''
  return found.t === 'str' && found.v !== '' ? found.v : bad(CREDENTIAL_ERROR)
}

const ARGV_ERROR = 'argv must be an array of 1 to 57 strings'

function argv(fields: readonly Member[]): string[] {
  const value = need(fields, 'argv')
  if (value.t !== 'arr') return bad(ARGV_ERROR)
  const list = value.items.map((item) => string(item, 'argv entries'))
  check(list.length >= 1 && list.length <= ARGV_MAX, ARGV_ERROR)
  check(list[0] !== '', 'argv[0] must name a command')
  return list
}

/** Unknown fields are rejected so that a misspelled option never goes unnoticed. */
function allowed(fields: readonly Member[], keys: readonly string[]): void {
  for (const [key] of fields) if (key !== 'id' && key !== 'op' && !keys.includes(key)) bad(`unknown request field: ${key}`)
}

export const UNKNOWN_OP =
  'unknown op: use exec, start, spawn, write, closeInput, read, status, events, wait, stop, watch, list, capabilities, validate, jev, decide, validateDecision or decisionProviders'

const PROVIDERS = ['typesafe', 'openrouter', 'vercel', 'subq']

function opOf(name: string, f: readonly Member[]): Op {
  switch (name) {
    case 'exec': {
      allowed(f, ['argv', 'stdin', 'timeoutMs', 'cwd'])
      const command = argv(f)
      const input = optionalText(findField(f, 'stdin'), 'stdin')
      const ms = timeout(f, MAX_TIMEOUT)
      return {op: 'exec', argv: command, input, timeout: ms, cwd: cwd(f)}
    }
    case 'start': {
      // A job's own lifetime may reach a day; it is not bounded by the session.
      allowed(f, ['argv', 'timeoutMs', 'label', 'cwd', 'input'])
      const command = argv(f)
      const ms = timeout(f, Time.jobMax)
      const l = label(findField(f, 'label'))
      const dir = cwd(f)
      const input = choice(findField(f, 'input'), 'null', ['pipe', 'null'], 'input must be "pipe" or "null"')
      return {op: 'start', argv: command, timeout: ms, label: l, cwd: dir, pipe: input === 'pipe'}
    }
    case 'spawn': {
      // A session child lives at most a day, and never longer than its connection.
      allowed(f, ['argv', 'stdin', 'timeoutMs', 'label', 'cwd'])
      const command = argv(f)
      const input = choice(findField(f, 'stdin'), 'pipe', ['pipe', 'null'], 'stdin must be "pipe" or "null"')
      const ms = timeout(f, Time.jobMax)
      const l = label(findField(f, 'label'))
      return {op: 'spawn', argv: command, pipe: input === 'pipe', timeout: ms, label: l, cwd: cwd(f)}
    }
    case 'write': {
      allowed(f, ['job', 'text'])
      const id = job(f)
      return {op: 'write', job: id, text: writeText(f)}
    }
    case 'closeInput':
      allowed(f, ['job'])
      return {op: 'closeInput', job: job(f)}
    case 'read': {
      allowed(f, ['job', 'stream', 'offset', 'max', 'waitMs', 'encoding'])
      const id = job(f)
      const stream = choice(findField(f, 'stream'), '', ['stdout', 'stderr'], 'stream must be "stdout" or "stderr"')
      check(stream !== '', 'missing field: stream')
      const at = offset(findField(f, 'offset'))
      const most = maxOf(findField(f, 'max'))
      const wait = waitMs(f)
      const encoding = choice(findField(f, 'encoding'), 'text', ['text', 'base64'], 'encoding must be "text" or "base64"')
      return {op: 'read', job: id, stream, offset: at, max: most, wait, base64: encoding === 'base64'}
    }
    case 'capabilities':
      allowed(f, [])
      return {op: 'capabilities'}
    case 'status':
      allowed(f, ['job'])
      return {op: 'status', job: job(f)}
    case 'events': {
      allowed(f, ['job', 'after', 'waitMs'])
      const id = job(f)
      const after = cursor(f)
      return {op: 'events', job: id, after, wait: waitMs(f)}
    }
    case 'wait': {
      allowed(f, ['job', 'timeoutMs'])
      const id = job(f)
      return {op: 'wait', job: id, timeout: timeout(f, MAX_TIMEOUT)}
    }
    case 'stop':
      allowed(f, ['job'])
      return {op: 'stop', job: job(f)}
    case 'watch': {
      allowed(f, ['job', 'literal', 'timeoutMs'])
      const id = job(f)
      const literal = text(f, 'literal')
      return {op: 'watch', job: id, literal, timeout: timeout(f, 300000)}
    }
    case 'list': {
      // "store" (the default) lists the storage root's jobs, as the CLI does; "session" this connection's children.
      allowed(f, ['scope'])
      const scope = choice(findField(f, 'scope'), 'store', ['store', 'session'], 'scope must be "store" or "session"')
      return {op: 'list', sessions: scope === 'session'}
    }
    case 'validate':
      allowed(f, ['request'])
      return {op: 'validate', request: need(f, 'request')}
    case 'jev': {
      // `provider` and `credential` apply to this request only.
      allowed(f, ['request', 'timeoutMs', 'provider', 'credential'])
      const request = need(f, 'request')
      const ms = timeout(f, MAX_TIMEOUT)
      const provider = choice(findField(f, 'provider'), '', PROVIDERS, 'provider must be typesafe, openrouter, vercel or subq')
      return {op: 'jev', request, timeout: ms, provider, credential: credential(findField(f, 'credential'))}
    }
    case 'decide': {
      allowed(f, ['request', 'timeoutMs', 'credential'])
      const request = need(f, 'request')
      const ms = timeout(f, MAX_TIMEOUT)
      return {op: 'decide', request, timeout: ms, credential: credential(findField(f, 'credential'))}
    }
    case 'validateDecision':
      allowed(f, ['request'])
      return {op: 'validateDecision', request: need(f, 'request')}
    case 'decisionProviders':
      allowed(f, [])
      return {op: 'decisionProviders'}
    case 'resolveDecision':
      allowed(f, ['request'])
      return {op: 'resolveDecision', request: need(f, 'request')}
    default:
      return bad(UNKNOWN_OP)
  }
}

/** Decision requests take the 16 MiB cap; every other request the codec's 1 MiB encoding. */
const WIDE = ['decide', 'validateDecision', 'resolveDecision']

function limited(value: Json, name: string): void {
  const r = WIDE.includes(name) ? Codec.validateWithLimit(value, LINE_MAX) : Codec.encode(value)
  if (!r.ok) throw new Failure(r.error.code, r.error.message)
}

/** ServeCore.request: an object, a valid id, an op, the size cap, then the op's own fields. */
export const request = (value: Json): Result<Op> =>
  attempt(() => {
    const fields = objectOf(value)
    idValid(findField(fields, 'id'))
    const name = text(fields, 'op')
    limited(value, name)
    return opOf(name, fields)
  })

/** A line that is not strict JSON: the codec's code, its message prefixed. */
export function readLine(bytes: Uint8Array): Result<Json> {
  const r = Codec.readBytesWithLimit(bytes, LINE_MAX)
  return r.ok ? r : fail(r.error.code, `request line is not strict JSON: ${r.error.message}`)
}

// ---------------------------------------------------------------------------
// CLI child plans. Each process and job operation re-enters this executable,
// so a failing command costs one response, never the session.

export type Defaults = {work: number; wait: number; watch: number}
export type Call = {argv: string[]; input: string; timeout: number; many: boolean}

export const EXPIRED: Err = {code: 124, message: 'serve deadline expired'}
const expired = () => fail(EXPIRED.code, EXPIRED.message)

/** What is left for a child: the session's remaining time less the receipt grace; 0 when none is. */
export const left = (remaining: number): number => (remaining > GRACE ? remaining - GRACE : 0)

/** The requested or default time, within the session's remaining time less the grace. */
export const inner = (requested: number | null, fallback: number, remaining: number): number => Math.min(requested ?? fallback, left(remaining))

/** A child's own deadline plus the grace to print its receipt; none at all once no time is left. */
export const timed = (argv: string[], input: string, ms: number, many: boolean): Result<Call> =>
  ms === 0 ? expired() : done({argv, input, timeout: ms + GRACE, many})

/** A control step: under the 15 s bound, while more than the grace is left. */
export const control = (argv: string[], remaining: number, many: boolean): Result<Call> =>
  remaining > GRACE ? done({argv, input: '', timeout: Math.min(remaining, CONTROL_MAX), many}) : expired()

/** This same executable, `--RTS` then the CLI's own arguments, as 0.8.1 re-entered itself. */
export const cli = (self: readonly string[], args: readonly string[]): string[] => [...self, '--RTS', ...args]

const labelArgs = (label: string) => (label === '' ? [] : ['--label', label])
const inputArgs = (pipe: boolean) => (pipe ? ['--input', 'pipe'] : [])
const cwdArgs = (cwd: string) => (cwd === '' ? [] : ['--cwd', cwd])

/** ServeCore.plan: the CLI child that answers `op`, with `remaining` the session's time (at most an hour). */
export function plan(self: readonly string[], op: Op, defaults: Defaults, remaining: number): Result<Call> {
  switch (op.op) {
    case 'exec': {
      const ms = inner(op.timeout, MAX_TIMEOUT, remaining)
      return timed(cli(self, ['exec', '--timeout-ms', String(ms), '--stdin', ...cwdArgs(op.cwd), '--', ...op.argv]), op.input, ms, false)
    }
    case 'start': {
      const lifetime = op.timeout ?? defaults.work
      const opts = [...labelArgs(op.label), ...cwdArgs(op.cwd), ...inputArgs(op.pipe)]
      return control(cli(self, ['start', '--timeout-ms', String(lifetime), ...opts, '--', ...op.argv]), remaining, false)
    }
    case 'status':
      return control(cli(self, ['status', op.job]), remaining, false)
    case 'events': {
      // Without waitMs, a snapshot under the control bound; with it, a long poll cut to the session like `wait`.
      if (op.wait === null) return control(cli(self, ['events', op.job, String(op.after)]), remaining, true)
      const ms = Math.min(op.wait, left(remaining))
      return timed(cli(self, ['events', '--timeout-ms', String(ms), op.job, String(op.after)]), '', ms, true)
    }
    case 'wait': {
      const ms = inner(op.timeout, defaults.wait, remaining)
      return timed(cli(self, ['wait', '--timeout-ms', String(ms), op.job]), '', ms, false)
    }
    case 'stop':
      return control(cli(self, ['stop', op.job]), remaining, false)
    case 'watch': {
      const ms = inner(op.timeout, defaults.watch, remaining)
      return timed(cli(self, ['watch', '--timeout-ms', String(ms), op.job, op.literal]), '', ms, true)
    }
    case 'list':
      return control(cli(self, ['list']), remaining, false)
    default:
      return fail(2, 'this request runs in process')
  }
}

// ---------------------------------------------------------------------------
// CLI child output: JSON lines on stdout, or an error on stderr.

export type Captured = {code: number; flags: number; stdout: Uint8Array; stderr: Uint8Array}

/** The message of a failed CLI step: its stderr, decoded and trimmed, at most 1024 characters. */
export function message(stderr: Uint8Array): string {
  const t = trim(Streams.text(stderr))
  return t === '' ? 'jev-fabric command failed' : cpTake(t, 1024)
}

/** ServeCore.output: every non-empty stdout line read as JSON; one value, or with `many` an array of them. */
export function output(code: number, stdout: Uint8Array, stderr: Uint8Array, many: boolean): Result<string> {
  const {lines, framer: rest} = frame(framer(), stdout)
  const items: Json[] = []
  for (const l of [...lines, ...last(rest)]) {
    if (l.length === 0) continue
    const v = Codec.readBytes(l)
    if (!v.ok) return v
    items.push(v.value)
  }
  if (many) return Codec.encode({t: 'arr', items})
  if (items.length > 0) return Codec.encode(items[0]!)
  return fail(code === 0 ? 1 : code, message(stderr))
}

/** Flag bits from the supervisor: 1 timed out, 2 stdout cut, 4 stderr cut, 8 cancelled. */
export function outcome(raw: Result<Captured>, many: boolean): Result<string> {
  if (!raw.ok) return fail(raw.error.code, `jev-fabric could not run the request: ${raw.error.message}`)
  const {code, flags, stdout, stderr} = raw.value
  if (flags === 0) return output(code, stdout, stderr, many)
  if (flags & 1) return expired()
  return fail(1, 'jev-fabric command output exceeded 1 MiB')
}

/**
 * A step run in process (`watch`, through the monitor) relayed exactly as
 * its CLI child's output was: the lines it printed and the error it ended
 * with, under the same 1 MiB capture bound, then `output`.
 */
export function relayed(code: number, lines: readonly string[], error: string | undefined, many: boolean): Result<string> {
  const stdout = new TextEncoder().encode(lines.map((l) => `${l}\n`).join(''))
  const stderr = new TextEncoder().encode(error === undefined ? '' : `${error}\n`)
  if (stdout.length > CAPTURE_MAX || stderr.length > CAPTURE_MAX) return fail(1, 'jev-fabric command output exceeded 1 MiB')
  return output(code, stdout, stderr, many)
}

// ---------------------------------------------------------------------------
// In-process answers and the response line.

/** `validate`: the request as the Jev wire checks it. */
export function validated(request: Json): Result<string> {
  const checked = Wire.validateRequest(request)
  return checked.ok ? Codec.encode(checked.value) : checked
}

/** `validateDecision`: the request as the decision wire checks it, within 16 MiB. */
export function validatedDecision(request: Json): Result<string> {
  const checked = DecisionWire.validateRequest(request)
  return checked.ok ? Codec.encodeWithLimit(checked.value, LINE_MAX) : checked
}

const encoded = (value: Json): string => {
  const r = Codec.encode(value)
  return r.ok ? r.value : 'null'
}

/** One response line: the id echoed, then the result or the error. */
export function respond(id: Json, result: Result<string>): string {
  if (result.ok) return `{"id":${encoded(id)},"ok":true,"result":${result.value}}`
  return `{"id":${encoded(id)},"ok":false,"error":{"code":${result.error.code},"message":${quote(result.error.message)}}}`
}

// ---------------------------------------------------------------------------
// Session children: spawned by one connection, addressed by `s-` ids, ended
// with it. Each child's worker re-enters this executable and reads the
// connection's pipe as the child's stdin.

/** Running session children one connection may hold. */
export const CHILDREN_MAX = 16
/** Writes, closes and stops one child may have queued. */
export const PENDING_MAX = 64
/** A worker's supervisor gives it this long past its child's own deadline to record the receipt. */
export const WORKER_GRACE = 5000

/** The directory behind a session child's id, if `job` is one. */
export const sessionDir = (job: string): string | null => (job.startsWith('s-') ? job.slice(2) : null)

export const UNKNOWN_CHILD: Err = {code: 22, message: 'unknown session child for this connection'}
export const TOO_MANY_CHILDREN: Err = {code: 22, message: 'this connection already has 16 running session children'}
export const TOO_MANY_PENDING: Err = {code: 1, message: 'too many pending requests for this session child'}
export const CLOSED: Err = {code: 1, message: 'session child stdin is closed'}
export const GONE: Err = {code: 1, message: 'session child is no longer reading its input'}
export const NOT_STARTED: Err = {code: 1, message: 'session child did not start'}

/** A session child lives for its own timeoutMs, or else the rest of the connection, and never past it. */
export const childLifetime = (requested: number | null, leftMs: number): number => Math.min(requested ?? leftMs, leftMs)

/** How long the connection supervises the child's worker: the child's lifetime and the grace, within a day. */
export const workerTimeout = (lifetime: number): number => Math.min(lifetime + WORKER_GRACE, Time.jobMax)

export const mode = (pipe: boolean): string => (pipe ? 'session' : 'session-null')

/** The job a request names, if any. */
export function jobOf(op: Op): string | null {
  switch (op.op) {
    case 'status':
    case 'events':
    case 'wait':
    case 'stop':
    case 'watch':
    case 'write':
    case 'closeInput':
    case 'read':
      return op.job
    default:
      return null
  }
}

/** The session child a request names, by its full `s-` id. */
export function sessionTarget(op: Op): string | null {
  const j = jobOf(op)
  return j !== null && j.startsWith('s-') ? j : null
}

/** The same observation, pointed at the child's directory for a CLI child. */
export function retarget(op: Op, dir: string): Op {
  switch (op.op) {
    case 'status':
    case 'events':
    case 'wait':
    case 'watch':
      return {...op, job: dir}
    default:
      return op
  }
}

export const writeJson = Jobs.writeJson
export const utf8Bytes = Jobs.utf8Bytes
