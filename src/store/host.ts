// The private storage root and its jobs' files (native/host.c and
// native/Host.bend): the OS boundary only. Job states, deadlines, events and
// polling policy live in src/jobs; the format decision in ./core.ts.
//
// Layout (byte-compatible with 0.8.1): `$JEV_FABRIC_HOME` or
// `.jev-fabric-native` (with a `.gitignore` of "*\n" when this created it),
// the marker `.jev-fabric-store.json`, and one directory per job named by 32
// lowercase hex digits. Every directory is 0700 and every file 0600, owned by
// us, single-link, never followed through a symlink: the root is walked one
// component at a time with no-follow directory descriptors and every job file
// is opened relative to its job directory's descriptor. Writes replace a file
// through a fsynced exclusive temp file and rename. A job's worker holds an
// advisory flock on `.lease` for as long as it lives; nothing else signals or
// trusts a pid. Every failure is the system's errno with one message,
// "native private job operation failed", which the CLI exits with.

import {closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, readdirSync, readSync, realpathSync, statSync, watch, writeSync} from 'node:fs'
import type {Result} from '../codec/result.ts'
import {done, fail} from '../codec/result.ts'
import {onChildExit} from '../sys/exits.ts'
import * as L from '../sys/libc.ts'
import * as Store from './core.ts'

const ID_LEN = 32
const LEAF_MAX = 64
const ARGS = 69
const ARG_BYTES = 4096
const TEXT_MAX = 1048576
const JOBS_MAX = 4096
export const STORE_NAME = '.jev-fabric-store.json'
const STORE_MAX = 4096
const DIRECTORY_MAX = 4096
const PATH_MAX = process.platform === 'darwin' ? 1024 : 4096

export const FAILED = 'native private job operation failed'

const DIR_FLAGS = L.O.RDONLY | L.O.DIRECTORY | L.O.NOFOLLOW | L.O.CLOEXEC
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
// A leading BOM is text like any other, and malformed bytes read as U+FFFD (io_str).
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const decode = (b: Uint8Array) => decoder.decode(b)

class Errno extends L.SysError {
  constructor(errno: number) {
    super(errno, 'host')
  }
}
const raise = (errno: number): never => {
  throw new Errno(errno)
}

function attempt<T>(f: () => T): Result<T> {
  try {
    return done(f())
  } catch (e) {
    return fail(L.errnoOf(e), FAILED)
  }
}

function close(fd: number) {
  if (fd >= 0) {
    try {
      closeSync(fd)
    } catch {}
  }
}

// Owned by us, no group or other permissions, and a directory or a single-link regular file.
function ensurePrivate(fd: number, directory: boolean) {
  const s = fstatSync(fd)
  const rightType = directory ? s.isDirectory() : s.isFile() && s.nlink === 1
  if (s.uid !== process.geteuid!() || (s.mode & 0o77) !== 0 || !rightType) raise(L.E.EPERM)
  return s
}

export const isId = (s: string) => /^[0-9a-f]{32}$/.test(s)
const isLeaf = (s: string) => s.length >= 1 && s.length <= LEAF_MAX && s[0] !== '.' && /^[a-z0-9.-]+$/.test(s)

function random(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(ID_LEN / 2))).toString('hex')
}

function writeAll(fd: number, data: Uint8Array, at: number | null = null) {
  let used = 0
  while (used < data.length) {
    const put = writeSync(fd, data, used, data.length - used, at === null ? null : at + used)
    if (put <= 0) raise(L.E.EIO)
    used += put
  }
}

type Root = {fd: number; path: string; created: boolean}

// A default root created by this call also ignores itself in version control.
// Best effort: the root stays valid without it, and nothing reads it back.
function ignore(root: number) {
  let fd = -1
  try {
    fd = L.openat(root, '.gitignore', L.O.WRONLY | L.O.CREAT | L.O.EXCL | L.O.NOFOLLOW | L.O.CLOEXEC, 0o600)
    writeSync(fd, '*\n')
  } catch {}
  close(fd)
}

/**
 * Walks the root's components with no-follow directory descriptors, ancestors
 * included, creating what is missing (0700). No realpath: it would silently
 * bless symlink traversal. `created` is whether this call made the root itself.
 */
function openRoot(): Root {
  const env = process.env.JEV_FABRIC_HOME
  const path = env ?? '.jev-fabric-native'
  if (!path || bytes(path) >= PATH_MAX || path.includes('\0')) raise(L.E.EINVAL)
  const parts = path.split('/').filter(Boolean)
  // An existing root, the usual case, opens in one call with no symlink
  // anywhere in it. Anything else (a component to create, a symlink, any
  // refusal) takes the walk, which creates what is missing and fails exactly
  // as it always has.
  if (!parts.some((part) => part === '.' || part === '..')) {
    const fast = L.openNoSymlinks(L.AT_FDCWD, path, DIR_FLAGS)
    if (fast >= 0) {
      try {
        ensurePrivate(fast, true)
      } catch (e) {
        close(fast)
        throw e
      }
      return {fd: fast, path, created: false}
    }
  }
  let created = false
  let fd = L.openat(L.AT_FDCWD, path[0] === '/' ? '/' : '.', DIR_FLAGS)
  try {
    for (const part of parts) {
      if (part === '.' || part === '..') raise(L.E.EINVAL)
      // Open first: a component that exists (every one, once the root is
      // made) costs one call and no exception; only a missing one is made.
      let next = L.openatOrErrno(fd, part, DIR_FLAGS)
      created = false
      if (next === -L.E.ENOENT) {
        try {
          L.mkdirat(fd, part, 0o700)
          created = true
        } catch (e) {
          if (L.errnoOf(e) !== L.E.EEXIST) throw e
        }
        next = L.openat(fd, part, DIR_FLAGS)
      } else if (next < 0) raise(-next)
      close(fd)
      fd = next
    }
    ensurePrivate(fd, true)
  } catch (e) {
    close(fd)
    throw e
  }
  if (env === undefined && created) ignore(fd)
  return {fd, path, created}
}

function withRoot<T>(f: (root: Root) => T): T {
  const root = openRoot()
  try {
    return f(root)
  } finally {
    close(root.fd)
  }
}

type Dir = {fd: number; path: string}

function withJob<T>(id: string, f: (dir: Dir) => T): T {
  if (!isId(id)) raise(L.E.EINVAL)
  return withRoot((root) => {
    const fd = L.openat(root.fd, id, DIR_FLAGS)
    try {
      ensurePrivate(fd, true)
      return f({fd, path: `${root.path}/${id}`})
    } finally {
      close(fd)
    }
  })
}

/** A private file's bytes, at most `limit`; a missing file is null. */
function readFile(dir: number, name: string, limit: number): Buffer | null {
  const fd = L.openatOrErrno(dir, name, L.O.RDONLY | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK)
  if (fd === -L.E.ENOENT) return null
  if (fd < 0) raise(-fd)
  try {
    const size = ensurePrivate(fd, false).size
    if (size > limit) raise(L.E.EFBIG)
    // Read up to one byte past the limit so growth after the fstat is
    // detected; the buffer starts at the file's size and grows only if it did.
    let text = Buffer.allocUnsafe(Math.min(size, limit) + 1)
    let used = 0
    while (used <= limit) {
      if (used === text.length) {
        const grown = Buffer.allocUnsafe(Math.min(text.length * 2, limit + 1))
        text.copy(grown, 0, 0, used)
        text = grown
      }
      const got = readSync(fd, text, used, text.length - used, null)
      if (!got) break
      used += got
    }
    if (used > limit) raise(L.E.EFBIG)
    return text.subarray(0, used)
  } finally {
    close(fd)
  }
}

// Replaces `name` via a fsynced exclusive temp file and rename.
function atomic(dir: Dir, name: string, text: Uint8Array) {
  try {
    const s = lstatSync(`${dir.path}/${name}`, {throwIfNoEntry: false})
    if (s && (!s.isFile() || s.uid !== process.geteuid!() || (s.mode & 0o77) !== 0 || s.nlink !== 1)) raise(L.E.EPERM)
  } catch (e) {
    if (e instanceof Errno || L.errnoOf(e) !== L.E.ENOENT) throw e
  }
  const temp = `.${random()}.tmp`
  const fd = L.openat(dir.fd, temp, L.O.WRONLY | L.O.CREAT | L.O.EXCL | L.O.NOFOLLOW | L.O.CLOEXEC, 0o600)
  try {
    writeAll(fd, text)
    fsyncSync(fd)
    L.renameat(dir.fd, temp, dir.fd, name)
    fsyncSync(dir.fd)
  } finally {
    close(fd)
    try {
      L.unlinkat(dir.fd, temp)
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// The interactive input queue: `input.queue` holds bytes not yet handed to
// the child, `input.closed` records the end of input. Both change only under
// an exclusive lock on the queue file, so writers and the draining worker see
// one order. Bytes are opaque here; the bounds come from src/jobs.

function openQueue(dir: number): number {
  const fd = L.openat(dir, 'input.queue', L.O.RDWR | L.O.CREAT | L.O.NOFOLLOW | L.O.CLOEXEC, 0o600)
  try {
    ensurePrivate(fd, false)
    L.flock(fd, L.LOCK_EX)
    return fd
  } catch (e) {
    close(fd)
    throw e
  }
}

function queueClosed(dir: Dir): boolean {
  // Whether any entry of that name exists (as lstat would tell), looked up
  // relative to the job's descriptor rather than by path again.
  const fd = L.openatOrErrno(dir.fd, 'input.closed', L.O.RDONLY | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK)
  if (fd >= 0) close(fd)
  return fd !== -L.E.ENOENT
}

// ---------------------------------------------------------------------------
// The operations (Host.jfh_os), each a value or the errno.

let lease = -1

const checkName = (id: string, name: string, text = '', limit = 0) => {
  if (bytes(id) > ID_LEN || bytes(name) > LEAF_MAX || bytes(text) > TEXT_MAX || limit > TEXT_MAX || id.includes('\0') || name.includes('\0')) raise(L.E.EINVAL)
}

/** Host.self: this executable's real path. */
export function self(): string {
  return realpathSync(process.execPath)
}

/** "+" when this call created the root, else "=", then the store marker's text (or nothing). */
export function storeAnswer(): Result<string> {
  return attempt(() => {
    const root = openRoot()
    try {
      let text: Buffer | null = null
      // A marker being adopted has a second link for an instant; read it again.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          text = readFile(root.fd, STORE_NAME, STORE_MAX)
          break
        } catch (e) {
          if (L.errnoOf(e) !== L.E.EPERM || attempt === 19) throw e
          Bun.sleepSync(1)
        }
      }
      return (root.created ? '+' : '=') + (text ? decode(text) : '')
    } finally {
      close(root.fd)
    }
  })
}

/**
 * Writes the store marker only if none exists, atomically and owner-only: a
 * fsynced temp file is linked into place, which fails rather than replace a
 * marker another process wrote first. Answers "written" or "exists".
 */
export function adoptMarker(text: string): Result<string> {
  return attempt(() =>
    withRoot((root) => {
      const temp = `.${random()}.tmp`
      const fd = L.openat(root.fd, temp, L.O.WRONLY | L.O.CREAT | L.O.EXCL | L.O.NOFOLLOW | L.O.CLOEXEC, 0o600)
      try {
        writeAll(fd, Buffer.from(text, 'utf8'))
        fsyncSync(fd)
        try {
          L.linkat(root.fd, temp, root.fd, STORE_NAME)
        } catch (e) {
          if (L.errnoOf(e) === L.E.EEXIST) return 'exists'
          throw e
        }
        fsyncSync(root.fd)
        return 'written'
      } finally {
        close(fd)
        try {
          L.unlinkat(root.fd, temp)
        } catch {}
      }
    }),
  )
}

export type Checked = Result<void>

/** Host.store_attempt: the format check every store verb makes first; writers adopt an unmarked home. */
export function storeAttempt(mutating: boolean): Checked {
  const answer = storeAnswer()
  if (!answer.ok) return answer
  const decision = Store.decide(answer.value, mutating)
  if (decision.d === 'accept') return done(undefined)
  if (decision.d === 'refuse') return fail(Store.refusedCode, decision.message)
  const adopted = adoptMarker(Store.marker)
  return adopted.ok ? done(undefined) : adopted
}

/** Host.make: a new private job directory under a checked store, at most `maxJobs` of them. */
export function make(maxJobs: number): Result<string> {
  const checked = storeAttempt(true)
  if (!checked.ok) return checked
  return attempt(() => {
    if (!maxJobs || maxJobs > JOBS_MAX) raise(L.E.EINVAL)
    return withRoot((root) => {
      L.flock(root.fd, L.LOCK_EX)
      let count = 0
      // Hidden entries (.gitignore, the store marker, temp files) are not job directories.
      for (const name of readdirSync(root.path)) {
        if (count >= maxJobs) break
        if (name[0] !== '.') count++
      }
      if (count >= maxJobs) raise(L.E.ENOSPC)
      const id = random()
      L.mkdirat(root.fd, id, 0o700)
      fsyncSync(root.fd)
      return id
    })
  })
}

/** Host.attempt: a private file's text ("" when missing); unsafe or oversize files fail closed. */
export function read(id: string, name: string, limit: number): Result<string> {
  return attempt(() => {
    checkName(id, name, '', limit)
    return withJob(id, (dir) => {
      if (!isLeaf(name)) raise(L.E.EINVAL)
      const text = readFile(dir.fd, name, limit)
      return text ? decode(text) : ''
    })
  })
}

/** Host.put: replaces a private file atomically. */
export function put(id: string, name: string, text: string): Result<string> {
  return attempt(() => {
    checkName(id, name, text, TEXT_MAX)
    return withJob(id, (dir) => {
      if (!isLeaf(name)) raise(L.E.EINVAL)
      atomic(dir, name, Buffer.from(text, 'utf8'))
      return ''
    })
  })
}

/**
 * Host.claim: holds the job's advisory lease until this process exits, and
 * makes this worker its own session (a worker its owner spawned into a group
 * of its own already leads it and stays in the owner's session).
 */
export function claim(id: string): Result<void> {
  return attempt(() => {
    checkName(id, '')
    withJob(id, (dir) => {
      let fd = L.openat(dir.fd, '.lease', L.O.RDWR | L.O.CREAT | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK, 0o600)
      try {
        ensurePrivate(fd, false)
        if (lease >= 0) raise(L.E.EBUSY)
        if (!L.flock(fd, L.LOCK_EX | L.LOCK_NB)) raise(L.E.EWOULDBLOCK)
        if (L.setsid() < 0) {
          const e = L.errno()
          if (!(e === L.E.EPERM && L.getpgrp() === L.getpid())) raise(e)
        }
        lease = fd
        fd = -1
      } finally {
        close(fd)
      }
    })
  })
}

/**
 * The job's advisory lease, held on a descriptor of its own: a process that
 * supervises several jobs (serve, for its session children) holds one per
 * job, each released by closing it (or by the process's exit). Other
 * processes, and this one's own probes, see the job as live meanwhile, as
 * they would its worker's claim. EWOULDBLOCK when it is already held.
 */
export function hold(id: string): Result<number> {
  return attempt(() => {
    checkName(id, '')
    return withJob(id, (dir) => {
      const fd = L.openat(dir.fd, '.lease', L.O.RDWR | L.O.CREAT | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK, 0o600)
      try {
        ensurePrivate(fd, false)
        if (!L.flock(fd, L.LOCK_EX | L.LOCK_NB)) raise(L.E.EWOULDBLOCK)
        return fd
      } catch (e) {
        close(fd)
        throw e
      }
    })
  })
}

/** Releases a lease `hold` took (or a directory `directoryOf` opened). */
export const release = (fd: number): void => close(fd)

/**
 * A descriptor of a job's private directory, held for cheap existence
 * checks of its files (`present`), as a supervisor watching for a marker
 * makes them; close it with `release`. What it finds is read with `read`.
 */
export function directoryOf(id: string): Result<number> {
  return attempt(() => {
    if (!isId(id)) raise(L.E.EINVAL)
    return withRoot((root) => {
      const fd = L.openat(root.fd, id, DIR_FLAGS)
      try {
        ensurePrivate(fd, true)
      } catch (e) {
        close(fd)
        throw e
      }
      return fd
    })
  })
}

/** Whether an entry named `name` is in the directory `dir` holds: one openat, no symlink followed. */
export function present(dir: number, name: string): boolean {
  const fd = L.openatOrErrno(dir, name, L.O.RDONLY | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK)
  if (fd >= 0) close(fd)
  return fd !== -L.E.ENOENT
}

/**
 * A writer of an existing private spool (no create, no truncate), for
 * marking a rolling spool's stream ended after its supervisor is gone.
 */
export function reopen(id: string, name: string): Result<number> {
  return attempt(() => {
    checkName(id, name)
    return withJob(id, (dir) => {
      if (!isLeaf(name)) raise(L.E.EINVAL)
      const fd = L.openat(dir.fd, name, L.O.WRONLY | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK)
      try {
        ensurePrivate(fd, false)
      } catch (e) {
        close(fd)
        throw e
      }
      return fd
    })
  })
}

/** Host.probe: "1" while a worker holds the lease, "0" once none does. Never a signal. */
export function probe(id: string): Result<string> {
  return attempt(() => {
    checkName(id, '')
    return withJob(id, (dir) => {
      const fd = L.openat(dir.fd, '.lease', L.O.RDWR | L.O.CREAT | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK, 0o600)
      try {
        ensurePrivate(fd, false)
        return L.flock(fd, L.LOCK_EX | L.LOCK_NB) ? '0' : '1'
      } finally {
        close(fd)
      }
    })
  })
}

/**
 * Host.spawn: starts a detached worker (an absolute argv[0]) with /dev/null
 * for its stdio and `env` (this process's by default); it is reaped while
 * this process lives, then the OS adopts it.
 */
export function spawn(argv: readonly string[], env: readonly string[] = L.environment()): Result<string> {
  return attempt(() => {
    if (argv.length > ARGS || argv.some((a) => bytes(a) > ARG_BYTES || a.includes('\0'))) raise(L.E.EINVAL)
    if (!argv.length || argv[0]![0] !== '/') raise(L.E.EINVAL)
    // Reaped on its SIGCHLD (listened for before it exists), with a backstop
    // every second that never keeps this process alive.
    let reaper: ReturnType<typeof setInterval> | undefined
    const reap = () => {
      let gone = true
      try {
        gone = L.waitpid(pid).pid === pid
      } catch {}
      if (gone) {
        unlisten()
        clearInterval(reaper)
      }
    }
    const unlisten = onChildExit(reap)
    let pid: number
    try {
      pid = L.spawn({argv: [...argv], env: [...env], stdio: ['/dev/null', '/dev/null', '/dev/null']})
    } catch (e) {
      unlisten()
      throw e
    }
    reaper = setInterval(reap, 1000)
    reaper.unref()
    reap()
    return ''
  })
}

/**
 * Host.list: names only, the ids of private no-follow job-shaped directories
 * under the root, one per line, in directory order, at most limit + 1 so the
 * caller can disclose truncation. Whether one holds a job is src/jobs' call.
 */
export function list(limit: number): Result<string> {
  return attempt(() => {
    if (!limit || limit >= JOBS_MAX) raise(L.E.EINVAL)
    return withRoot((root) => {
      let out = ''
      let found = 0
      for (const name of readdirSync(root.path)) {
        if (found >= limit + 1) break
        if (!isId(name)) continue
        let fd = -1
        try {
          fd = L.openat(root.fd, name, DIR_FLAGS)
          ensurePrivate(fd, true)
        } catch {
          close(fd)
          continue
        }
        close(fd)
        out += name + '\n'
        found++
      }
      return out
    })
  })
}

/** Host.clock: wall-clock time in epoch milliseconds, as decimal digits. */
export const clock = (): string => String(Date.now())

/** Host.parent: the parent process id, as decimal digits. It changes when the parent exits. */
export const parent = (): string => String(L.getppid())

/**
 * Host.enqueue: appends to a job's input queue unless the queue would pass
 * `limit` bytes (ENOSPC) or input has ended (EPIPE); `close` ends input after
 * the text. Answers the bytes now pending.
 */
export function enqueue(id: string, text: string, closeAfter: boolean, limit: number): Result<string> {
  return attempt(() => {
    checkName(id, closeAfter ? 'close' : '', text, limit)
    return withJob(id, (dir) => {
      const fd = openQueue(dir.fd)
      try {
        if (queueClosed(dir)) raise(L.E.EPIPE)
        const size = fstatSync(fd).size
        const data = Buffer.from(text, 'utf8')
        if (size + data.length > limit) raise(L.E.ENOSPC)
        writeAll(fd, data, size)
        if (closeAfter) {
          try {
            close(L.openat(dir.fd, 'input.closed', L.O.WRONLY | L.O.CREAT | L.O.EXCL | L.O.NOFOLLOW | L.O.CLOEXEC, 0o600))
          } catch (e) {
            if (L.errnoOf(e) !== L.E.EEXIST) throw e
          }
        }
        return String(size + data.length)
      } finally {
        close(fd)
      }
    })
  })
}

/**
 * Calls `changed` when a job's input queue may have changed (a writer
 * appended to it), as a hint only: what is queued is still read under its
 * lock by dequeue, and a lost or failed watch only leaves the reader to its
 * poll. The queue must exist (dequeue creates it). Returns the unwatch.
 */
export function watchQueue(id: string, changed: () => void): () => void {
  try {
    checkName(id, '')
    const path = withJob(id, (dir) => `${dir.path}/input.queue`)
    const w = watch(path, {persistent: false}, () => changed())
    w.on('error', () => {})
    return () => {
      try {
        w.close()
      } catch {}
    }
  } catch {
    return () => {}
  }
}

/** Host.dequeue: takes every queued byte (at most `limit`): "C" when input has ended, else "O", then the bytes. */
export function dequeue(id: string, limit: number): Result<string> {
  return attempt(() => {
    checkName(id, '', '', limit)
    return withJob(id, (dir) => {
      const fd = openQueue(dir.fd)
      try {
        const size = fstatSync(fd).size
        if (size > limit) raise(L.E.EFBIG)
        const out = Buffer.alloc(size + 1)
        out[0] = queueClosed(dir) ? 0x43 : 0x4f
        let used = 1
        while (used < size + 1) {
          const got = readSync(fd, out, used, size + 1 - used, used - 1)
          if (got <= 0) break
          used += got
        }
        if (used !== size + 1) raise(L.E.EIO)
        if (size) ftruncateSync(fd, 0)
        return decode(out)
      } finally {
        close(fd)
      }
    })
  })
}

/**
 * Host.remove: deletes one job directory and the plain files directly in it,
 * unless a live worker still holds its lease (EBUSY). For session children,
 * which nothing can address once their owner has ended.
 */
export function remove(id: string): Result<string> {
  return attempt(() => {
    if (!isId(id)) raise(L.E.EINVAL)
    return withRoot((root) => {
      const dir = L.openat(root.fd, id, DIR_FLAGS)
      let leaseFd = -1
      try {
        ensurePrivate(dir, true)
        try {
          leaseFd = L.openat(dir, '.lease', L.O.RDWR | L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK)
        } catch {}
        if (leaseFd >= 0 && !L.flock(leaseFd, L.LOCK_EX | L.LOCK_NB)) raise(L.E.EBUSY)
        const path = `${root.path}/${id}`
        for (const name of readdirSync(path)) {
          try {
            if (!lstatSync(`${path}/${name}`).isDirectory()) L.unlinkat(dir, name)
          } catch {}
        }
        L.unlinkat(root.fd, id, L.AT_REMOVEDIR)
        return ''
      } finally {
        close(leaseFd)
        close(dir)
      }
    })
  })
}

/** Host.platform: the build's operating system and CPU, such as darwin-arm64 or linux-x64. */
export function platform(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'unknown'
  const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unknown'
  return `${os}-${cpu}`
}

/** Host.directory: whether an absolute path names an existing directory ("1", or the failure). */
export function directory(path: string): Result<string> {
  return attempt(() => {
    if (!path || path[0] !== '/' || bytes(path) > DIRECTORY_MAX || path.includes('\0')) raise(L.E.EINVAL)
    if (!statSync(path).isDirectory()) raise(L.E.ENOTDIR)
    return '1'
  })
}

/**
 * Host.jfh_spool: a spool's descriptor. The writer is created exclusively;
 * readers get independent descriptors. The caller owns (closes) it, or hands
 * writers to the supervisor, which consumes them.
 */
export function spool(id: string, name: string, writing: boolean): Result<number> {
  return attempt(() => {
    checkName(id, name)
    return withJob(id, (dir) => {
      if (!isLeaf(name)) raise(L.E.EINVAL)
      const mode = writing ? L.O.WRONLY | L.O.CREAT | L.O.EXCL : L.O.RDONLY
      const fd = L.openat(dir.fd, name, L.O.NOFOLLOW | L.O.CLOEXEC | L.O.NONBLOCK | mode, 0o600)
      try {
        ensurePrivate(fd, false)
      } catch (e) {
        close(fd)
        throw e
      }
      return fd
    })
  })
}

/** Host.open: a new reader of a private file (a missing file is ENOENT). */
export const open = (id: string, name: string) => spool(id, name, false)
