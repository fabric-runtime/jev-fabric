// The only place jev-fabric calls libc directly (bun:ffi), for what Bun and
// Node have no exact API for: directory-relative opens (openat, mkdirat,
// renameat, linkat, unlinkat), advisory locks (flock), descriptor flags
// (fcntl), pipes, process groups (posix_spawn with its own group, kill of a
// whole group, waitpid, setsid), the parent pid and dup2. Everything else
// (read, write, fstat, fsync, close) goes through node:fs on the same raw
// descriptors. native/posix.c, pipe.c and host.c made the same calls.
//
// Variadic functions (openat's mode, fcntl's argument): on Apple arm64 the
// variadic arguments travel on the stack, not in registers, and bun:ffi
// calls every function as non-variadic. The declaration there pads the
// named arguments to eight registers, so the variadic one is the ninth
// argument: AAPCS64 puts it at [sp], exactly where the callee reads it.
// Every other platform passes variadic integers like named ones.
//
// Failures throw SysError with the system's errno, the number 0.8.1 exited
// with ("native private job operation failed" exits with it).

import {closeSync, constants as fsc} from 'node:fs'
import {constants as osc} from 'node:os'
import {dlopen, FFIType, ptr, read} from 'bun:ffi'

const darwin = process.platform === 'darwin'
const padded = darwin && process.arch === 'arm64'
const I = FFIType.i32
const P = FFIType.ptr
const PAD = [I, I, I, I, I, I] as const

export const E = osc.errno as Record<string, number> & {
  EPERM: number; ENOENT: number; EINTR: number; EIO: number; EBADF: number; ECHILD: number; EAGAIN: number
  ENOMEM: number; EACCES: number; EBUSY: number; EEXIST: number; ENOTDIR: number; EINVAL: number; EFBIG: number
  ENOSPC: number; EPIPE: number; ELOOP: number; ENAMETOOLONG: number; ECANCELED: number; EWOULDBLOCK: number; ENOSYS: number
}

// open(2) flags: node:fs has all but O_CLOEXEC, which differs by platform.
export const O = {
  RDONLY: fsc.O_RDONLY,
  WRONLY: fsc.O_WRONLY,
  RDWR: fsc.O_RDWR,
  CREAT: fsc.O_CREAT,
  EXCL: fsc.O_EXCL,
  NOFOLLOW: fsc.O_NOFOLLOW,
  DIRECTORY: fsc.O_DIRECTORY,
  NONBLOCK: fsc.O_NONBLOCK,
  CLOEXEC: darwin ? 0x1000000 : 0o2000000,
}

export const AT_FDCWD = darwin ? -2 : -100
export const AT_REMOVEDIR = darwin ? 0x80 : 0x200
const F_GETFD = 1
const F_SETFD = 2
const F_GETFL = 3
const F_SETFL = 4
const F_DUPFD_CLOEXEC = darwin ? 67 : 1030
const FD_CLOEXEC = 1
export const LOCK_EX = 2
export const LOCK_NB = 4
const WNOHANG = 1
export const SIGINT = 2
export const SIGKILL = 9
export const SIGPIPE = 13
export const SIGTERM = 15
const POSIX_SPAWN_SETPGROUP = 0x02
const POSIX_SPAWN_SETSIGDEF = 0x04
const POSIX_SPAWN_SETSIGMASK = 0x08
const POSIX_SPAWN_CLOEXEC_DEFAULT = 0x4000
// setsid(2) in the child: macOS's extension, and glibc's from 2.26.
const POSIX_SPAWN_SETSID = darwin ? 0x0400 : 0x80

// Symbols bind on first use, one dlopen per group, so each verb compiles only
// the trampolines its path calls (`--version` none, `exec` the spawn group,
// the store verbs the file group). Every group also binds the errno location,
// so errno() never needs a dlopen of its own after a failed call.
const LIBC = darwin ? 'libc.dylib' : 'libc.so.6'
const ERRNO = darwin ? '__error' : '__errno_location'
type Fn = (...args: unknown[]) => number
type Table = Record<string, {args: readonly FFIType[]; returns: FFIType}>

// fcntl's variadic argument is read as a long (va_arg(ap, long)), so its
// stack slot is passed as all eight bytes; openat's mode is read as an int.
const FCNTL = {fcntl: {args: padded ? [I, I, ...PAD, FFIType.i64] : [I, I, I], returns: I}}
const GROUPS = {
  spawn: {
    ...FCNTL,
    pipe: {args: [P], returns: I},
    dup2: {args: [I, I], returns: I},
    kill: {args: [I, I], returns: I},
    waitpid: {args: [I, P, I], returns: I},
    posix_spawnp: {args: [P, P, P, P, P, P], returns: I},
    posix_spawn_file_actions_init: {args: [P], returns: I},
    posix_spawn_file_actions_destroy: {args: [P], returns: I},
    posix_spawn_file_actions_adddup2: {args: [P, I, I], returns: I},
    posix_spawn_file_actions_addopen: {args: [P, I, P, I, I], returns: I},
    posix_spawnattr_init: {args: [P], returns: I},
    posix_spawnattr_destroy: {args: [P], returns: I},
    posix_spawnattr_setflags: {args: [P, I], returns: I},
    posix_spawnattr_setpgroup: {args: [P, I], returns: I},
    posix_spawnattr_setsigdefault: {args: [P, P], returns: I},
    posix_spawnattr_setsigmask: {args: [P, P], returns: I},
  },
  files: {
    ...FCNTL,
    openat: {args: padded ? [I, P, I, ...PAD.slice(0, 5), I] : [I, P, I, I], returns: I},
    mkdirat: {args: [I, P, I], returns: I},
    unlinkat: {args: [I, P, I], returns: I},
    renameat: {args: [I, P, I, P], returns: I},
    linkat: {args: [I, P, I, P, I], returns: I},
    flock: {args: [I, I], returns: I},
  },
  // Linux openat2(2), by number (glibc has no wrapper): 437 on x86-64 and arm64.
  openat2: darwin ? {} : {syscall: {args: [FFIType.i64, I, P, P, FFIType.u64], returns: FFIType.i64}},
  ids: {
    setsid: {args: [], returns: I},
    getpgrp: {args: [], returns: I},
    getpid: {args: [], returns: I},
    getppid: {args: [], returns: I},
  },
} satisfies Record<string, Table>
type Group = keyof typeof GROUPS

let errnoAt: Fn | undefined
const bound: {[G in Group]?: Record<keyof (typeof GROUPS)[G], Fn>} = {}

function bind<G extends Group>(group: G): Record<keyof (typeof GROUPS)[G], Fn> {
  const symbols = dlopen(LIBC, {[ERRNO]: {args: [], returns: P}, ...GROUPS[group]} as Table).symbols as unknown as Record<string, Fn>
  errnoAt ??= symbols[ERRNO]
  return symbols as never
}
const spawnLib = () => (bound.spawn ??= bind('spawn'))
const openat2Lib = () => (bound.openat2 ??= bind('openat2'))
const filesLib = () => (bound.files ??= bind('files'))
const idsLib = () => (bound.ids ??= bind('ids'))

// posix_spawn_file_actions_addchdir_np exists on macOS and from glibc 2.29.
// Without it a child with its own cwd starts through `/bin/sh -c 'cd -- "$0"
// && exec "$@"'`, as posix.c does: the directory and every argument are
// positional parameters, never parsed as shell source.
let addchdirFn: Fn | undefined | null = null
const addchdir = () => (addchdirFn === null ? (addchdirFn = optional('posix_spawn_file_actions_addchdir_np', [P, P])) : addchdirFn)
// glibc 2.34+: close every inherited descriptor from 3 up in the child, as
// POSIX_SPAWN_CLOEXEC_DEFAULT does on macOS.
let addclosefromFn: Fn | undefined | null = darwin ? undefined : null
const addclosefrom = () =>
  addclosefromFn === null ? (addclosefromFn = optional('posix_spawn_file_actions_addclosefrom_np', [P, I])) : addclosefromFn

function optional(name: string, args: FFIType[]): Fn | undefined {
  try {
    return dlopen(LIBC, {[name]: {args, returns: I}}).symbols[name] as never
  } catch {
    return undefined
  }
}

export class SysError extends Error {
  readonly errno: number
  constructor(errno: number, what: string) {
    super(`${what}: errno ${errno}`)
    this.errno = errno
  }
}

/** The calling thread's errno, read right after the failed call (whose group bound the errno location). */
export function errno(): number {
  if (!errnoAt) idsLib()
  return read.i32(errnoAt!() as never, 0)
}

/** The errno of a SysError or a node:fs error (EIO for anything else). */
export function errnoOf(error: unknown): number {
  if (error instanceof SysError) return error.errno
  const code = (error as {code?: unknown})?.code
  if (typeof code === 'string' && typeof E[code] === 'number') return E[code]!
  return E.EIO
}

const cstr = (s: string) => Buffer.from(s + '\0', 'utf8')

function check(rc: number, what: string): number {
  if (rc < 0) throw new SysError(errno(), what)
  return rc
}

// Retries a call the kernel interrupted, as the C did around every call.
function retried(call: () => number, what: string): number {
  for (;;) {
    const rc = call()
    if (rc >= 0) return rc
    const e = errno()
    if (e !== E.EINTR) throw new SysError(e, what)
  }
}

export function openat(dir: number, name: string, flags: number, mode = 0): number {
  const fd = openatOrErrno(dir, name, flags, mode)
  if (fd < 0) throw new SysError(-fd, 'openat')
  return fd
}

// macOS 11+: fail with ELOOP if any component of the path is a symlink.
const O_NOFOLLOW_ANY = 0x20000000
const SYS_OPENAT2 = 437
const RESOLVE_NO_SYMLINKS = 0x04
let noOpenat2 = false

/**
 * Opens a whole path with no symlink in any component, in one call: macOS's
 * O_NOFOLLOW_ANY or Linux's openat2 RESOLVE_NO_SYMLINKS. The descriptor, or
 * minus the errno; -ENOSYS where the kernel has neither (the caller then
 * walks the path a component at a time, which also names the exact errno of
 * any refusal).
 */
export function openNoSymlinks(dir: number, path: string, flags: number): number {
  // O_NOFOLLOW_ANY covers the last component too, and macOS refuses it beside O_NOFOLLOW (EINVAL).
  if (darwin) return openatOrErrno(dir, path, (flags & ~O.NOFOLLOW) | O_NOFOLLOW_ANY)
  if (noOpenat2 || (process.arch !== 'x64' && process.arch !== 'arm64')) return -E.ENOSYS
  const how = new BigUint64Array([BigInt(flags), 0n, BigInt(RESOLVE_NO_SYMLINKS)])
  const name = cstr(path)
  for (;;) {
    const rc = Number(openat2Lib().syscall(SYS_OPENAT2, dir, name, ptr(how), 24))
    if (rc >= 0) return rc
    const e = errno()
    if (e === E.EINTR) continue
    // No openat2 (before Linux 5.6, or a seccomp filter): never ask again.
    if (e === E.ENOSYS || e === E.EPERM) noOpenat2 = true
    return -e
  }
}

/** openat without a throw: the descriptor, or minus the errno (for opens that expect ENOENT). */
export function openatOrErrno(dir: number, name: string, flags: number, mode = 0): number {
  const path = cstr(name)
  for (;;) {
    const rc = padded ? filesLib().openat(dir, path, flags, 0, 0, 0, 0, 0, mode) : filesLib().openat(dir, path, flags, mode)
    if (rc >= 0) return rc
    const e = errno()
    if (e !== E.EINTR) return -e
  }
}

export function fcntl(fd: number, cmd: number, arg = 0): number {
  const lib = bound.spawn ?? filesLib()
  return check(padded ? lib.fcntl(fd, cmd, 0, 0, 0, 0, 0, 0, arg) : lib.fcntl(fd, cmd, arg), 'fcntl')
}

export const mkdirat = (dir: number, name: string, mode: number) => check(filesLib().mkdirat(dir, cstr(name), mode), 'mkdirat')
export const unlinkat = (dir: number, name: string, flags = 0) => check(filesLib().unlinkat(dir, cstr(name), flags), 'unlinkat')
export const renameat = (from: number, a: string, to: number, b: string) => check(filesLib().renameat(from, cstr(a), to, cstr(b)), 'renameat')
export const linkat = (from: number, a: string, to: number, b: string) => check(filesLib().linkat(from, cstr(a), to, cstr(b), 0), 'linkat')

/** flock(2), retrying signals. With LOCK_NB, false when another holds it. */
export function flock(fd: number, how: number): boolean {
  for (;;) {
    if (filesLib().flock(fd, how) === 0) return true
    const e = errno()
    if (e === E.EINTR) continue
    if ((how & LOCK_NB) && (e === E.EWOULDBLOCK || e === E.EAGAIN)) return false
    throw new SysError(e, 'flock')
  }
}

export const setCloexec = (fd: number) => fcntl(fd, F_SETFD, fcntl(fd, F_GETFD) | FD_CLOEXEC)
export const setNonblock = (fd: number) => fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O.NONBLOCK)
/** A CLOEXEC duplicate of `fd` at `min` or above. */
export const dupCloexec = (fd: number, min = 3) => fcntl(fd, F_DUPFD_CLOEXEC, min)

/** One pipe, both ends CLOEXEC, as Native.pipe: [read, write]. */
export function pipe(): [number, number] {
  const fds = new Int32Array(2)
  check(spawnLib().pipe(ptr(fds)), 'pipe')
  const [r, w] = [fds[0]!, fds[1]!]
  try {
    setCloexec(r)
    setCloexec(w)
  } catch (error) {
    closeQuietly(r)
    closeQuietly(w)
    throw error
  }
  return [r, w]
}

export const dup2 = (from: number, to: number) => check(spawnLib().dup2(from, to), 'dup2')
/** kill(2); a negative pid is that whole process group. 0 or -1, never a throw. */
export const kill = (pid: number, signal: number): number => spawnLib().kill(pid, signal)
export const setsid = (): number => idsLib().setsid()
export const getpgrp = (): number => idsLib().getpgrp()
export const getpid = (): number => idsLib().getpid()
/** The live parent pid (it changes once the parent has exited). */
export const getppid = (): number => idsLib().getppid()

export type Waited = {pid: number; status: number}
/** waitpid(pid, WNOHANG): pid 0 while it runs. Retries EINTR. */
const waited = new Int32Array(1)
export function waitpid(pid: number, block = false): Waited {
  waited[0] = 0
  const got = retried(() => spawnLib().waitpid(pid, ptr(waited), block ? 0 : WNOHANG), 'waitpid')
  return {pid: got, status: waited[0]!}
}
/** The exit code a wait status reports: the code, or 128 + the signal. */
export function exitCode(status: number): number {
  return (status & 0x7f) === 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
}

function closeQuietly(fd: number) {
  try {
    closeSync(fd)
  } catch {}
}

export type Spawn = {
  argv: string[]
  env: string[]
  /** The child's 0, 1 and 2: a descriptor of ours, or a path opened in the child. */
  stdio: [number | string, number | string, number | string]
  /** An absolute directory to start in, or '' to inherit ours. */
  cwd?: string
  /** Its own process group (setpgid(0, 0)); SIGPIPE, SIGINT and SIGTERM at their defaults. */
  group?: boolean
  /**
   * With `group`: its own session too (setsid(2), so it leads a new group
   * and has no controlling terminal), as a child of a job worker that had
   * made itself a session leader was. Where the C library cannot (glibc
   * before 2.26), the child gets a group of its own in this session.
   */
  session?: boolean
}

let noSetsid = false

/**
 * posix_spawnp(3), as posix.c and host.c called it. With `group` the child
 * leads a new process group in this session, so kill(-pid) reaches every
 * descendant that stays in it. The signal mask is cleared, and on macOS only
 * the descriptors given as stdio are inherited (POSIX_SPAWN_CLOEXEC_DEFAULT;
 * glibc 2.34+ closes the rest likewise). Returns the pid, or throws the
 * spawn's errno (ENOENT for a missing command).
 */
export function spawn(s: Spawn): number {
  if (s.session && s.group && !noSetsid) {
    try {
      return spawnOnce(s, true)
    } catch (e) {
      if (!(e instanceof SysError && e.errno === E.EINVAL && !darwin)) throw e
      noSetsid = true
    }
  }
  return spawnOnce(s, false)
}

function spawnOnce(s: Spawn, setsid: boolean): number {
  const C = spawnLib()
  let argv = s.argv
  const actions = Buffer.alloc(1024)
  const attr = Buffer.alloc(1024)
  const keep: Buffer[] = []
  const c = (text: string) => {
    const b = cstr(text)
    keep.push(b)
    return b
  }
  let rc = C.posix_spawn_file_actions_init(actions)
  if (rc) throw new SysError(rc, 'posix_spawn_file_actions_init')
  try {
    rc = C.posix_spawnattr_init(attr)
    if (rc) throw new SysError(rc, 'posix_spawnattr_init')
    try {
      const signals = Buffer.alloc(128)
      const empty = Buffer.alloc(128)
      if (s.group) signals.writeUInt32LE((1 << (SIGPIPE - 1)) | (1 << (SIGINT - 1)) | (1 << (SIGTERM - 1)), 0)
      // A new session makes the child its group's leader; asking for setpgid too would fail (EPERM).
      const grouping = setsid ? POSIX_SPAWN_SETSID : POSIX_SPAWN_SETPGROUP
      const flags = POSIX_SPAWN_SETSIGMASK | (s.group ? grouping | POSIX_SPAWN_SETSIGDEF : 0) | (darwin ? POSIX_SPAWN_CLOEXEC_DEFAULT : 0)
      for (const r of [
        s.group && !setsid ? C.posix_spawnattr_setpgroup(attr, 0) : 0,
        s.group ? C.posix_spawnattr_setsigdefault(attr, signals) : 0,
        C.posix_spawnattr_setsigmask(attr, empty),
        C.posix_spawnattr_setflags(attr, flags),
      ])
        if (r) throw new SysError(r, 'posix_spawnattr')
      s.stdio.forEach((io, fd) => {
        const r = typeof io === 'number'
          ? C.posix_spawn_file_actions_adddup2(actions, io, fd)
          : C.posix_spawn_file_actions_addopen(actions, fd, c(io), fd ? O.WRONLY : O.RDONLY, 0)
        if (r) throw new SysError(r, 'posix_spawn_file_actions')
      })
      const closefrom = addclosefrom()
      if (closefrom) closefrom(actions, 3)
      if (s.cwd) {
        const chdir = addchdir()
        if (chdir) {
          const r = chdir(actions, c(s.cwd))
          if (r) throw new SysError(r, 'posix_spawn_file_actions_addchdir_np')
        } else argv = ['/bin/sh', '-c', 'cd -- "$0" && exec "$@"', s.cwd, ...argv]
      }
      const vector = (items: string[]) => {
        const v = new BigUint64Array(items.length + 1)
        items.forEach((x, i) => (v[i] = BigInt(ptr(c(x)))))
        return v
      }
      const args = vector(argv)
      const envp = vector(s.env)
      const pid = new Int32Array(1)
      rc = C.posix_spawnp(ptr(pid), c(argv[0]!), actions, attr, ptr(args), ptr(envp))
      if (rc) throw new SysError(rc, 'posix_spawnp')
      return pid[0]!
    } finally {
      C.posix_spawnattr_destroy(attr)
    }
  } finally {
    C.posix_spawn_file_actions_destroy(actions)
    keep.length = 0
  }
}

/** The environment as posix_spawn takes it. */
export function environment(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]))
}
