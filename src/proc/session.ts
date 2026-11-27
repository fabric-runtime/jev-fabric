// Interactive sessions for TypeScript programs (native/Session.bend): an
// affine stdin, two independent readers and a join. A session's child gets
// its own private directory with first-byte spools (stdout.bin, stderr.bin),
// read by offset; reads preserve those spools, they are not a lossless
// protocol (check spoolLimit). The lifetime is chosen once; writes and reads
// never renew it. Launch errors are recoverable through wait().

import {closeSync, fstatSync, readSync, writeSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import * as Host from '../store/host.ts'
import * as L from '../sys/libc.ts'
import * as Time from '../time/time.ts'
import * as Process from './process.ts'
import type {Report} from './report.ts'
import {decode} from './report.ts'

export type Outcome = Result<Report>

export type Session = {stdin: number | null; stdout: number; stderr: number; result: Promise<Outcome>}

/** The first-byte cap of each spool: reaching it means the stream may be clipped. */
export const spoolLimit = 1048576

const closeFd = (fd: number) => {
  try {
    closeSync(fd)
  } catch {}
}

/** Session.start: a private directory, spools, a stdin pipe and the supervised child. */
export function start(argv: readonly string[], timeout: number): Result<Session> {
  const id = Host.make(1024)
  if (!id.ok) return id
  const opened: number[] = []
  const take = (r: Result<number>) => {
    if (!r.ok) throw r
    opened.push(r.value)
    return r.value
  }
  try {
    const out = take(Host.spool(id.value, 'stdout.bin', true))
    const err = take(Host.spool(id.value, 'stderr.bin', true))
    const outRead = take(Host.spool(id.value, 'stdout.bin', false))
    const errRead = take(Host.spool(id.value, 'stderr.bin', false))
    const pair = Process.pipe()
    if (!pair.ok) throw pair
    const [input, writer] = pair.value
    L.setNonblock(writer)
    const result = Process.execPipe(argv, input, timeout, out, err, false).then((r): Outcome => (r.ok ? done(decode(r.value)) : r))
    return done({stdin: writer, stdout: outRead, stderr: errRead, result})
  } catch (e) {
    for (const fd of opened) closeFd(fd)
    return (e as {ok?: boolean}).ok === false ? (e as Result<Session>) : fail(L.errnoOf(e), Host.FAILED)
  }
}

/** Session.open: the configured work limit. */
export function open(argv: readonly string[]): Result<Session> {
  const ms = Time.work()
  return ms.ok ? start(argv, ms.value) : ms
}

/** Session.write: at most 65536 characters, waiting while the child is not reading. */
export async function write(s: Session, text: string): Promise<Result<void>> {
  if ([...text].length > 65536) return fail(1, 'session write exceeds 65536 characters')
  if (s.stdin === null) return fail(1, 'session stdin is closed')
  const data = Buffer.from(text, 'utf8')
  for (let sent = 0; sent < data.length; ) {
    try {
      sent += writeSync(s.stdin, data, sent, data.length - sent)
    } catch (e) {
      const n = L.errnoOf(e)
      if (n !== L.E.EAGAIN && n !== L.E.EWOULDBLOCK && n !== L.E.EINTR) return fail(n, 'session write failed')
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  return done(undefined)
}

/** Session.close_input: idempotent; keeps the readers and the join. */
export function closeInput(s: Session): Session {
  if (s.stdin !== null) closeFd(s.stdin)
  return {...s, stdin: null}
}

function readBounded(fd: number, offset: number, max: number): Result<Uint8Array> {
  if (!(max <= 65536 && offset <= spoolLimit)) return fail(1, 'session read requires offset <= 1048576 and max <= 65536')
  try {
    const out = Buffer.alloc(max)
    let used = 0
    while (used < max) {
      const got = readSync(fd, out, used, max - used, offset + used)
      if (got <= 0) break
      used += got
    }
    return done(out.subarray(0, used))
  } catch (e) {
    return fail(L.errnoOf(e), 'session read failed')
  }
}

export const readStdout = (s: Session, offset: number, max: number) => readBounded(s.stdout, offset, max)
export const readStderr = (s: Session, offset: number, max: number) => readBounded(s.stderr, offset, max)

/**
 * Session.status: bytes spooled so far per stream. Reaching the cap means the
 * stream may be clipped; a final report separately discloses cut 32 KiB tails.
 */
export function status(s: Session): Result<[number, number]> {
  try {
    return done([fstatSync(s.stdout).size, fstatSync(s.stderr).size])
  } catch (e) {
    return fail(L.errnoOf(e), 'session status failed')
  }
}

/** Session.wait: ends input, joins the child and closes the readers. */
export async function wait(s: Session): Promise<Outcome> {
  if (s.stdin !== null) closeFd(s.stdin)
  const outcome = await s.result
  closeFd(s.stdout)
  closeFd(s.stderr)
  return outcome
}

/** Sticky cancellation of every child this process owns, not one session. */
export const cancelScope = () => Process.cancel()
