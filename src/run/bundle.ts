// A Bun macro (imported `with {type: 'macro'}` by ./embedded.ts): it runs
// while `bun build --compile` bundles the CLI, so the binary carries the
// library (src/lib.ts and everything it imports) as one ESM text. `run`
// writes that text next to the program it starts. Bun.build cannot run
// inside a macro during bundling, so this calls the bun CLI instead.

import {join} from 'node:path'

export function library(): string {
  const entry = join(import.meta.dir, '..', 'lib.ts')
  const r = Bun.spawnSync([process.execPath, 'build', entry, '--target=bun', '--format=esm'], {stdout: 'pipe', stderr: 'pipe'})
  if (r.exitCode !== 0) throw new Error(`bundling ${entry} failed:\n${r.stderr.toString()}`)
  return r.stdout.toString()
}
