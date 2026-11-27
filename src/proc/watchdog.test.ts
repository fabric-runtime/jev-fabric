// The owner watchdog (src/proc/watchdog.ts), with its real /bin/sh script:
// closing the owner's end of its pipe stands for the owner's death.

import {afterAll, expect, test} from 'bun:test'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as L from '../sys/libc.ts'
import {watchdog} from './watchdog.ts'

const root = mkdtempSync(join(tmpdir(), 'jev-fabric-watchdog-'))
afterAll(() => rmSync(root, {recursive: true, force: true}))

const alive = (pid: number) => L.kill(pid, 0) === 0
const until = async (check: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !check(); await Bun.sleep(10)) if (Date.now() > end) return false
  return true
}
/** A group of its own, reaped by the test once it is gone. */
function group(script: string): number {
  return L.spawn({argv: ['/bin/sh', '-c', script], env: L.environment(), stdio: ['/dev/null', '/dev/null', '/dev/null'], group: true})
}
const reapLater = (pid: number) => until(() => L.waitpid(pid).pid === pid, 3000)

test("once its owner's pipe ends, the watchdog stops every listed group (forcing TERM-ignorers) and runs the reaper on their directories", async () => {
  const out = join(root, 'reaped')
  const dog = watchdog(['/bin/sh', '-c', 'printf "%s\\n" "$@" > "$0"', out])
  const plain = group('exec sleep 30')
  const ready = join(root, 'trapped')
  const stubborn = group(`trap "" TERM; : > '${ready}'; while :; do sleep 0.05; done`)
  // Not before it ignores SIGTERM.
  expect(await until(() => existsSync(ready), 3000)).toBe(true)
  const reaped = group('exec sleep 30')
  dog.add(plain, 'dir-plain')
  dog.add(stubborn, 'dir-stubborn')
  dog.add(reaped, 'dir-reaped')
  // A child its owner reaped is no longer the watchdog's.
  dog.remove(reaped, 'dir-reaped')
  const begin = performance.now()
  dog.close()
  expect(await reapLater(plain)).toBe(true)
  expect(await reapLater(stubborn)).toBe(true)
  expect(performance.now() - begin).toBeGreaterThanOrEqual(400)
  expect(await until(() => existsSync(out) && readFileSync(out, 'utf8').endsWith('\n'), 3000)).toBe(true)
  expect(readFileSync(out, 'utf8')).toBe('dir-plain\ndir-stubborn\n')
  expect(alive(reaped)).toBe(true)
  L.kill(-reaped, L.SIGKILL)
  await reapLater(reaped)
})

test('with nothing listed, the watchdog exits without stopping anything', async () => {
  const out = join(root, 'never')
  const dog = watchdog(['/bin/sh', '-c', 'echo ran > "$0"', out])
  const child = group('exec sleep 30')
  dog.add(child, 'dir')
  dog.remove(child, 'dir')
  dog.close()
  await Bun.sleep(800)
  expect(alive(child)).toBe(true)
  expect(existsSync(out)).toBe(false)
  L.kill(-child, L.SIGKILL)
  await reapLater(child)
})
