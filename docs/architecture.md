# Architecture

One executable owns processes, observations and Jev calls. It is TypeScript
on Bun, compiled to a single file with `bun build --compile --bytecode`: the
Bun runtime is inside, so there is no daemon, no Node, Bun or Python to
install, and no dependency on a particular agent harness.

```text
 shell / agent tool call        Python / TypeScript / any language    TypeScript program
          │                                  │                               │
 jev-fabric -- <verb>            jev-fabric -- serve (JSONL)        jev-fabric -- run
          │                                  │                               │
          └──────────────┬───────────────────┴───────────────┬───────────────┘
                         │                                   │
          processes, jobs, watches                 one Jev client
      (owned process groups, deadlines,         (budget, cached credential,
       bounded receipts, spools, events)          pooled HTTPS connection)
```

## Three ways in

- **CLI verbs** (`exec`, `start`, `status`, `events`, `watch`, `follow`, `wait`,
  `stop`, `list`, `write`, `close-input`, `read`, `validate`, `jev`,
  `capabilities`) print JSON and exit;
  `follow` streams JSONL until its job finishes or its ceiling passes. Anything
  that can run a process can drive them. Each `jev` invocation is a fresh
  client: one call budget, one TLS handshake.
- **`serve`** is a session. One JSONL request per line, one response per line,
  over one process, answered concurrently and matched by id. It threads a single
  Jev client through every `jev` request, so budgets are session-wide and the
  connection stays warm. It owns **session children** (`spawn`), interactive
  processes that end with it and are driven by `write`, `closeInput` and
  `read`. Other process and job operations re-enter the executable as CLI
  children, so they share the CLI's exact receipts and a failing command cannot
  end the session. See the [protocol](serve-protocol.md), the shared
  [vocabulary](composition.md) and the thin clients in `clients/`.
- **TypeScript programs** (`jev-fabric -- run program.ts`, or plain Bun with the
  `jev-fabric` package) get the full library: shared deadline scopes,
  persistent interactive sessions, durable jobs, concurrent calls as promises
  and the pure policy modules. `run` uses the Bun inside the executable and
  binds `import ... from 'jev-fabric'` to the library that binary carries. See
  the [library API](native-api.md).

## Modules

Each concern splits into a pure policy module, which imports nothing that does
IO, and a driver that does the IO. The pure modules are what
[the laws](laws.md) are about. `src/purity.test.ts` holds the split, as 0.8.1's
`native/trust.json` and safety check did: it lists every module of `src/` as
pure or driver, and fails if a pure module (or anything it imports) imports a
driver, `node:`, `bun:` or a package, or references a global that does IO,
reads a clock or randomness, schedules work or reaches the process.

| Concern | Pure policy | Driver |
| --- | --- | --- |
| Arguments and timers | `cli/core`, `time/core` | `cli/cli`, `time/time`, `time/scope`, `main` |
| JSON, UTF-8, Jev wire | `codec/` (strict JSON, codec, wire, text) | |
| Jev client, HTTPS, credentials | `jev/core`, `jev/jev-core`, `jev/http-core`, `jev/credential-core` | `jev/jev`, `jev/http`, `jev/credentials`, `jev/session` |
| Decisions | `decision/*-core` (`targets-core` among them), `config`, `profiles`, `wire`, `generated`, `math`, `w` | `decision/decision`, `decision/http`, `decision/local`, `decision/targets`, `decision/cli` |
| Processes and sessions | `proc/report` | `proc/process`, `proc/session` |
| Durable jobs, `list`, `follow` | `jobs/core`, `jobs/streams` | `jobs/jobs` |
| Storage format | `store/core` | `store/host` |
| Reads by byte offset, rolling spools | `spool/core` | `spool/spool` |
| Watches | `monitor/core` | `monitor/monitor` |
| JSONL sessions and session children | `serve/core`, `serve/hub` | `serve/serve` |
| `run` | `run/args` | `run/index` |

What Bun and Node have no exact API for (process groups, `posix_spawn` with
its own group, `waitpid`, `flock`, directory-relative opens) goes through
`bun:ffi` to libc in one module, `src/sys/libc.ts`; `src/sys/exits.ts` turns
child exits into events (one SIGCHLD listener). The supervisor waits on those
events, on its pipes' readiness and on timers, never on a fixed poll, so an
idle child costs nothing. HTTPS is Bun's `fetch`.
`bun run laws` proves the pure rules with
[gdp-wired](https://github.com/monotykamary/gdp-wired) and holds each to the
code that ships; see [laws](laws.md) for what is and isn't proven.

## Execution

- Every child gets its own POSIX process group and a deadline. Deadlines kill the
  group; a stop or a signal sends it SIGTERM, then SIGKILL after 500 ms; failures
  clean up owned groups.
- Every verb that touches the storage root checks its format marker first, and
  refuses a root written by a newer format.
- `start` forks a detached worker that re-enters the executable, holds an advisory
  lease on a private job directory, spools the first 1 MiB per stream and keeps the
  latest 64 events. Its lifetime may reach 24 hours. Controls address the private
  job id, never a PID, so any process sharing the storage root (another harness,
  or the same one after a restart) can `list`, `follow` and stop its jobs.
- `start --input pipe` gives the worker a stdin pipe and a feeder that
  drains a private input queue into it every tick; `write` appends to that
  queue under an advisory lock, from any process.
- `serve`'s `spawn` supervises the child inside the serve process (there is no
  worker process per child): the connection writes the same job files the
  worker writes (src/jobs/session.ts runs the worker's own observer), holds the
  child's lease, gives it the connection's pipe as stdin and a rolling spool of
  the latest 1 MiB per stream. `read` opens its own reader on that spool; the
  header the supervisor publishes (bytes written, stream ended) makes loss and
  `eof` exact. A stop marker another process writes (`jev-fabric stop` on the
  child's directory) is found within 100 ms by one sweep for all children. The
  connection stops and reaps every child on each ending it
  lives through (end of input, its deadline, SIGTERM, SIGINT, exit); for the
  one it cannot live through (SIGKILL, a crash), a small `/bin/sh` watchdog,
  started with the first child, holds a pipe only the connection writes, and
  on its end of file stops each listed child's group (SIGTERM, SIGKILL 500 ms
  later) and becomes `jev-fabric --RTS __session-reaper`, which publishes each
  child's cancelled receipt. Idle, 16 children cost about 1.5 MB beyond serve
  itself (the watchdog), against a Bun runtime (about 7 MB) per worker.
- Inside `serve`, a reader frames stdin, one hub owns the session (Jev client,
  children, counts), each blocking request runs as its own task, and a feeder
  per session child owns its stdin, so one child's writes apply in order and
  never wait on another request.
- `follow` polls the retained events every 25 ms and prints each new one once,
  with a loss record for any eviction, then one `follow.end` with the receipt.
- `watch` polls those retained events and emits bounded, deduplicated line batches
  with explicit loss records.
- Jev requests are validated before credentials are resolved. Budgets are reserved
  before dispatch, answers are validated completely, and nothing is retried.

## Boundaries

- Trusted code, not a security sandbox.
- No restart recovery, action replay, rollback or exactly-once claim. A crashed
  worker is reported failed, not resumed.
- Output, events and watches are bounded observations; loss is disclosed.
- Nothing calls Jev implicitly. A typed answer selects a branch the caller wrote,
  and an executed action still needs verification.

Design lineage: Pi Fabric's Jev and background-shell semantics informed this
independent implementation. There is no runtime dependency on Pi Fabric.
