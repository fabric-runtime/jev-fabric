// Shared harness for src tests: private temp roots under .tmp/, child
// processes run to completion, and the probe and worker-entry fixtures.

import {mkdirSync, mkdtempSync} from 'node:fs'
import {resolve} from 'node:path'

export const repo = resolve(import.meta.dir, '../..')
export const probe = resolve(repo, 'src/proc/probe.test-main.ts')
export const entry = resolve(repo, 'src/jobs/worker-entry.test-main.ts')
export const oracle = resolve(repo, '.tmp/oracle-0.8.1/jev-fabric')

/** A fresh private directory under the repository's ignored `.tmp/`. */
export function tempRoot(prefix: string): string {
  mkdirSync(resolve(repo, '.tmp'), {recursive: true})
  return mkdtempSync(resolve(repo, '.tmp', prefix))
}

export type Captured = {out: string; err: string; code: number}

/** Runs argv to completion; `input` is written to a piped stdin, which is then closed. */
export async function capture(argv: string[], options: {env?: Record<string, string | undefined>; input?: string; cwd?: string} = {}): Promise<Captured> {
  const piped = options.input !== undefined
  const child = Bun.spawn(argv, {env: options.env ?? process.env, cwd: options.cwd, stdin: piped ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe'})
  if (piped) {
    child.stdin!.write(options.input!)
    await child.stdin!.end()
  }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return {out, err, code}
}

/** True once no process with this pid exists (it has been reaped). */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as {code?: string}).code === 'ESRCH'
  }
}

export const jsonLines = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
