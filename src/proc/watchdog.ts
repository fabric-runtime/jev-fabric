// The owner watchdog: what stops a process's in-process supervised children
// when that process dies without stopping them itself (SIGKILL, a crash).
//
// Children supervised in process (serve's session children) are reaped and
// their groups killed by this process on every ending it lives through: end
// of input, the deadline, SIGTERM and SIGINT (the interrupt), and exit. Only
// its abrupt death leaves nothing to notice. One small /bin/sh per owner
// covers that: it holds the read end of a pipe whose only writer is the
// owner (close-on-exec, so no child inherits it), and the owner tells it
// each child's process group as it starts (`+<pgid>:<dir>`) and once it is
// reaped (`-<pgid>:<dir>`). End of file means the owner is gone; with any
// group still listed, the watchdog sends each SIGTERM, then SIGKILL 500 ms
// later (a stop's escalation), and then becomes `<self> --RTS
// __session-reaper <dir>...`, which publishes each child's cancelled receipt
// as its own supervisor would have. With none listed it exits.
//
// The watchdog leads a process group of its own, so a terminal's ^C reaches
// the owner (which stops the children itself) and not it. It costs about
// 1.4 MB (macOS /bin/sh), against a Bun runtime per child or per session
// for a supervisor process. It never signals a group the owner has reaped:
// the owner removes a group before it reports the child gone.

import {closeSync, writeSync} from 'node:fs'
import {onChildExit} from '../sys/exits.ts'
import * as L from '../sys/libc.ts'

const SCRIPT = [
  "trap '' HUP INT",
  "g=''",
  'while IFS= read -r l; do',
  '  case $l in',
  '    +*) g="$g ${l#+}" ;;',
  "    -*) n=''; for x in $g; do [ \"$x\" = \"${l#-}\" ] || n=\"$n $x\"; done; g=$n ;;",
  '  esac',
  'done',
  '[ -n "$g" ] || exit 0',
  'for x in $g; do kill -s TERM -- "-${x%%:*}" 2>/dev/null; done',
  'sleep 0.5',
  'for x in $g; do kill -s KILL -- "-${x%%:*}" 2>/dev/null; done',
  'for x in $g; do set -- "$@" "${x#*:}"; done',
  'exec "$@"',
].join('\n')

export type Watchdog = {
  /** A child started: its group and job directory. */
  add(pgid: number, dir: string): void
  /** That child has been reaped (and its group killed). */
  remove(pgid: number, dir: string): void
  /** The owner is done: no group is left, and the watchdog exits. */
  close(): void
}

/**
 * The owner's watchdog, started on the first `add`. `reaper` is the argv
 * that publishes the receipts once the owner is gone; the directories are
 * appended to it.
 */
export function watchdog(reaper: readonly string[]): Watchdog {
  const listed = new Map<string, true>()
  let fd = -1
  let started = false
  const start = () => {
    started = true
    let r = -1
    try {
      ;[r, fd] = L.pipe()
      const pid = L.spawn({
        argv: ['/bin/sh', '-c', SCRIPT, 'jev-fabric-watchdog', ...reaper],
        env: L.environment(),
        stdio: [r, '/dev/null', '/dev/null'],
        group: true,
      })
      // Reaped on its SIGCHLD; once the owner is gone, init does.
      const unlisten = onChildExit(() => {
        try {
          if (L.waitpid(pid).pid !== pid) return
        } catch {}
        unlisten()
        // It went first (someone killed it): the next change starts another with the full list.
        started = false
        fd = closeQuietly(fd)
      })
    } catch {
      // No watchdog: the owner still stops its children on every ending it lives through.
      fd = closeQuietly(fd)
    }
    closeQuietly(r)
    if (fd >= 0) for (const entry of listed.keys()) send(`+${entry}`)
  }
  const send = (line: string) => {
    if (fd < 0) return
    const data = Buffer.from(`${line}\n`)
    // A blocking pipe the watchdog drains at once: a short line is written whole or the watchdog is gone.
    try {
      writeSync(fd, data)
    } catch {
      fd = closeQuietly(fd)
      started = false
    }
  }
  return {
    add(pgid, dir) {
      const entry = `${pgid}:${dir}`
      listed.set(entry, true)
      if (!started) start()
      else send(`+${entry}`)
    },
    remove(pgid, dir) {
      const entry = `${pgid}:${dir}`
      if (!listed.delete(entry)) return
      if (fd < 0 && listed.size > 0) start()
      else send(`-${entry}`)
    },
    close() {
      fd = closeQuietly(fd)
    },
  }
}

function closeQuietly(fd: number): number {
  if (fd >= 0) {
    try {
      closeSync(fd)
    } catch {}
  }
  return -1
}
