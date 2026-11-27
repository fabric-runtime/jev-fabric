// A bounded, private capture of one child process (the shape of 0.8.1's
// Process.capture): literal argv, the input written to its stdin, a deadline
// (SIGTERM to its process group, then SIGKILL 500 ms later) and a cap on
// stdout and stderr. Flags: 1 timed out, 2 stdout cut, 4 stderr cut, 8
// cancelled. Callers reject any flag.
//
// The credential command, the exec HTTP transport and bounded file reads
// use it. The child gets its own process group. It is injectable everywhere
// it is used, so src/proc's capture can stand in for it.

import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'

export type Captured = {code: number; flags: number; stdout: Uint8Array; stderr: Uint8Array}
// `env` is the child's environment (this process's when not given); a bare
// program name is found on that environment's PATH, as execvp finds it.
export type CaptureFn = (
  argv: readonly string[],
  input: string,
  timeoutMs: number,
  limit: number,
  signal?: AbortSignal,
  env?: Readonly<Record<string, string | undefined>>,
) => Promise<Result<Captured>>

async function bounded(stream: ReadableStream<Uint8Array>, limit: number, cut: () => void): Promise<{bytes: Uint8Array; over: boolean}> {
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  const reader = stream.getReader()
  for (;;) {
    const {value, done: end} = await reader.read()
    if (end) break
    if (over) continue
    if (size + value.length > limit) {
      chunks.push(value.subarray(0, limit - size))
      size = limit
      over = true
      cut()
      continue
    }
    chunks.push(value)
    size += value.length
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return {bytes, over}
}

export const capture: CaptureFn = async (argv, input, timeoutMs, limit, signal, env = process.env) => {
  let child: ReturnType<typeof Bun.spawn>
  try {
    const program = argv[0] ?? ''
    const found = program.includes('/') ? program : Bun.which(program, {PATH: env.PATH ?? ''})
    if (!found) return fail(1, 'capture could not start')
    const childEnv = Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined))
    // Its own process group (setsid), so a deadline stops everything it started.
    child = Bun.spawn([found, ...argv.slice(1)], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true, env: childEnv})
  } catch {
    return fail(1, 'capture could not start')
  }
  let flags = 0
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {}
    }
  }
  const stop = (flag: number) => {
    flags |= flag
    signalGroup('SIGTERM')
    killTimer ??= setTimeout(() => signalGroup('SIGKILL'), 500)
  }
  const deadline = setTimeout(() => stop(1), Math.max(0, timeoutMs))
  const onAbort = () => stop(8)
  signal?.addEventListener('abort', onAbort)
  try {
    const stdin = child.stdin as import('bun').FileSink
    try {
      if (input) stdin.write(input)
      await stdin.end()
    } catch {}
    const [out, err] = await Promise.all([
      bounded(child.stdout as ReadableStream<Uint8Array>, limit, () => stop(2)),
      bounded(child.stderr as ReadableStream<Uint8Array>, limit, () => stop(4)),
    ])
    const code = await child.exited
    return done({code: code ?? 1, flags, stdout: out.bytes, stderr: err.bytes})
  } finally {
    clearTimeout(deadline)
    if (killTimer) clearTimeout(killTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}
