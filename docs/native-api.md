# Library API and execution contract

jev-fabric is one executable (TypeScript on Bun, compiled with
`bun build --compile`) and a TypeScript library, `jev-fabric`, for programs
that compose processes, durable jobs and Jev decisions. Programs run with
`jev-fabric -- run program.ts`, which uses the Bun built into the executable,
or with Bun directly. The library is trusted code in the program's own
process: budgets and handles are a programming discipline, not isolation from
the program that owns them. Upgrading a Bend program? See
[Bend to TypeScript](bend-to-typescript.md).

```ts
import {Scope, Session, Job, Jev, exec, receipt} from 'jev-fabric'
```

## CLI

All commands follow `jev-fabric --`:

| Command | Meaning |
| --- | --- |
| `exec [--timeout-ms N] [--stdin] [--cwd DIR] [--] <command> [args...]` | Literal argv, owned process group, bounded final receipt |
| `run [--timeout-ms N] [--] <program.ts\|.js> [args...]` | Run a TypeScript or JavaScript program with the built-in Bun, with inherited stdin, under one deadline; prints its receipt |
| `validate <request.json>` | Strict UTF-8/JSON plus typed Jev request validation; no credentials/network |
| `jev [--timeout-ms N] <request.json> [max-tokens]` | One explicit legacy Jev evaluation; default 100000 reported tokens |
| `decide [--timeout-ms N] <request.json> [max-tokens]` | One additive lossless decision; default 100000 reported tokens; inspect `status` and `budget` |
| `validate-decision <request.json>` | Offline decision request-schema validation; no credentials/network |
| `resolve-decision [target flags] <request.json>` | Offline resolved target and adapter preflight; flags: `--profile`, `--provider`, `--model`, `--api`, `--endpoint` (also accepted by `decide`); see [targets](decision-targets.md) |
| `decision-providers` | Registered decision preset definitions, not live model availability or credential checks |
| `start [--timeout-ms N] [--label TEXT] [--cwd DIR] [--input pipe] [--] <command> [args...]` | Detached worker; returns private job ID. Lifetime 1..86400000 ms. `--input pipe` keeps stdin open for `write` |
| `write <id> (--stdin \| -- text...)` | Queue text (standard input, or the words joined by spaces) for an interactive job's stdin; prints a write record |
| `close-input <id>` | End an interactive job's stdin after what is queued; idempotent |
| `read [--wait-ms N] [--base64] <id> <stdout\|stderr> [offset] [max]` | Raw bytes of one stream from a byte offset, as a read record; with `--wait-ms`, a long poll of 1..300000 ms |
| `status <id>` | Running state or stable final receipt |
| `events [--timeout-ms N] <id> [after-sequence]` | Snapshot of bounded retained JSONL events; with a timeout, a long poll of 1..300000 ms |
| `follow [--timeout-ms N] <id> [after-sequence]` | Live JSONL events as the worker publishes them, loss records, then one `follow.end` |
| `list` | One JSON summary of the job directories under the storage root, newest first |
| `wait [--timeout-ms N] <id>` | Poll until final receipt or client deadline; timeout returns running state |
| `stop <id>` | Idempotent cooperative stop through a private marker, never arbitrary PID signalling |
| `serve [--timeout-ms N] [max-evaluations [max-tokens]]` | JSONL session on stdin/stdout: concurrent requests matched by id, one shared Jev/decision budget, one deadline (1..86400000 ms) and the session's children. See [the serve protocol](serve-protocol.md) |
| `capabilities` | One JSON line: `version`, `protocol`, `store`, `platform`, `features` |
| `update` | Print and run `curl -fsSL …/install.sh \| sh`; exits with the installer's status. `JEV_FABRIC_PREFIX`/`JEV_FABRIC_VERSION` pass through |
| `watch [--timeout-ms N] <id> <literal>` | Live bounded line batches, loss records and a final observation summary; duration 1..300000 ms |

Timers may be omitted. Defaults and configuration:

| Operations | Default maximum | Environment override |
| --- | --- | --- |
| `exec`, `run`, `start`, `serve` sessions; library `exec`, `capture`, `Session.open`, `Job.start`, `Scope.open` | 1 hour | `JEV_FABRIC_TIMEOUT_MS` |
| `jev`, `decide`, `Jev.connect` | 30 seconds | `JEV_FABRIC_JEV_TIMEOUT_MS` |
| CLI `wait`, `follow`; `job.wait()`, `job.follow()` | 30 seconds | `JEV_FABRIC_WAIT_MS` |
| CLI `watch` | 5 seconds | `JEV_FABRIC_WATCH_MS` |

Defaults are ceilings, not sleeps: completion returns immediately. Empty/unset
configuration uses the default; malformed values fail closed. Explicit limits
replace configuration for that call (even when that default is malformed).
`wait`, `watch`, `follow` and `events --timeout-ms` only bound observation: they
neither cancel nor renew a job.
The calling harness still has its own shell-tool limits; a CLI default does not
extend those. Use `start` and subsequent controls for work that should outlive
a foreground tool call.
There is no unlimited/zero timeout mode. Limits are 1..3600000 ms, except `watch`
and `events --timeout-ms`, which permit 1..300000 ms, and `start` and `serve`,
whose lifetime may be 1..86400000 ms (24 hours). The work default and
`JEV_FABRIC_TIMEOUT_MS` stay within one hour, so a day is always explicit.

`--cwd DIR` (`exec` and `start` only) starts the command in an existing absolute
directory. It changes nothing else: the storage home is still resolved from the
caller's directory or `JEV_FABRIC_HOME`, and relative command names are still
looked up on PATH.

`capabilities` prints what a host needs to choose a binary without parsing a
version string:

```json
{"version":"0.5.1-native","protocol":2,"store":1,"platform":"darwin-arm64",
 "features":["follow","list","label","start-24h","serve-24h","serve-concurrent","sessions","cwd",
             "durable-input","read","jev-request-credential","decisions"]}
```

`features` lists only what this binary implements; within a protocol major,
features are only added.

Place `--timeout-ms N`, `--stdin`, `--label` and `--cwd` before the executable/program. Parsing stops
there: all subsequent arguments are literal child arguments, including strings
such as `--timeout-ms`. A command-local `--` ends option and legacy-number
parsing: `exec -- 123` executes a numeric command named `123` from PATH. It is
distinct from the initial `--` after `jev-fabric`.

Legacy forms remain supported: `exec/run/start/jev <ms> ...`,
`exec <ms> --stdin ...`, `wait <id> <ms>`, `watch <id> <ms> <literal>`.
Do not specify both a timeout flag and a positional timeout.

## `run`

```sh
jev-fabric -- run examples/native/pipeline.ts
jev-fabric -- run --timeout-ms 600000 -- examples/native/wikirace.ts Doom "Albert Einstein"
```

`run` timeouts are 1..3600000 ms (default the work limit). The program is a
`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` or `.jsx` file; anything
else, or a path that looks like an option, is refused with code 2 before
anything runs, and a `.bend` source is refused with a pointer to
[the migration](bend-to-typescript.md). Arguments after the program reach it
verbatim (`process.argv.slice(2)`); it reads this process's stdin.

`run` returns a **process receipt**, the same JSON `exec` prints: the
program's stdout and stderr (32 KiB tails each), its exit code, and whether it
timed out. stdout may contain your program's JSON result; `run` does not
interpret it as a verified task outcome. A nonzero exit ends `run` with that
code and `native program did not complete successfully` on stderr; the
deadline ends it with 124. The program runs in its own process group, which
the deadline kills (SIGTERM, then SIGKILL after 500 ms), as do SIGINT and
SIGTERM sent to `run`.

How it runs: the executable acts as the Bun CLI when started with
`BUN_BE_BUN=1`. Each run gets a private directory in the storage home (it
counts towards the 1024-directory cap, as 0.8.1's compiled program did)
holding the library this binary carries (`jev-fabric.js`, one ESM file of
about 240 KB) and a preload; the child is
`BUN_BE_BUN=1 jev-fabric --preload <dir>/preload.js <program> [args...]`.
The preload removes `BUN_BE_BUN` from `process.env`, points durable jobs at
this executable and registers `jev-fabric` as a module bound to that library,
so `import ... from 'jev-fabric'` works with no `node_modules` (and wins over
one, or over Bun's auto-install) and always matches the binary running it.
Everything else is plain Bun: the program's other imports, `tsconfig.json`,
`bunfig.toml`, `import.meta.main` and top-level await work as with
`bun program.ts`. For editor types, install the package (`bun add -d jev-fabric`).

One caveat: `Bun.spawn`/`Bun.spawnSync` without an `env` option pass the
environment Bun started with, which still includes `BUN_BE_BUN=1`; a
Bun-compiled executable started that way (another `jev-fabric`, say) would
act as Bun. Pass `env: process.env`, or use the library's `exec`, `Session`
and `Job`, `node:child_process` or `Bun.$`, which all use `process.env`.

Outside `run`, a program imports the same library from npm and runs with
`bun program.ts`; durable jobs then re-enter the `jev-fabric` executable on
`PATH` (or the one `setExecutable()` names).

The program and its imports are trusted code: `run` is not a sandbox.

## Errors and results

Failures throw `FabricError`, whose `code` is the exit status the CLI uses for
the same failure (2 usage, 22 invalid input, 124 deadline, 1 or an errno for
the rest) and whose message is the CLI's. A process **report** is a value,
never an error:

```ts
type Report = {code: number; timedOut: boolean; cancelled: boolean; stdoutCut: boolean; stderrCut: boolean; stdout: string; stderr: string}
```

`receipt(report)` serializes it exactly as `exec` prints it; `report.code` is
the exit code (124 for a deadline, 128+n for a signal).

Concurrency is promises: start several calls and `await Promise.all(...)`.

## Shared deadlines: `Scope`

`examples/native/scoped.ts` is a complete example.

- `Scope.open()` starts one budget of the configured work limit;
  `Scope.withTimeout(ms)` one of `ms` (1..3600000).
- `scope.exec(argv, {input?, capMs?})` runs a buffered child with what is left,
  at most `capMs`, and returns its report.
- `scope.start(argv, {capMs?})` starts a `Session` whose lifetime is what is
  left. Close and wait it as usual.
- `jev.evaluate(request, {scope, capMs?})` and `jev.decide(request, {scope, capMs?})`
  spend the same budget (see Jev below).
- `scope.remaining(capMs?)` is the milliseconds left now.

Pass the **same** scope to successive or concurrent calls. Each operation uses
remaining time, capped by any local limit; Jev additionally keeps its client's
per-request maximum. Creating a new scope for each call defeats this sharing.
Session reads/writes do not refresh its lifetime. Jev credential acquisition and
HTTP share the capped request deadline; the client's settings and its updated
credential cache and call accounting are kept afterward.

An expired scope launches nothing: `exec` returns a timed-out report (124),
`start` and Jev throw code 124, and Jev neither retrieves credentials, reserves
a call nor dispatches HTTP.

**A scope is not an isolated resource/cancellation group.** `cancel()` still
cancels every child of the program. Scopes are sampled at dispatch;
validation/scheduling/launch latency is not a real-time theorem. They are
explicitly passed, not ambient: `run`'s outer deadline is **not automatically
inherited** by a scope inside the program. Cross-process hierarchical
cancellation and cleanup after a crash or SIGKILL are not promised. An outer
timeout is not proof of cleanup of nested groups.

## Processes

- `exec(argv, {input?, inheritStdin?, timeoutMs?, cwd?}) -> Promise<Report>` runs
  one child: buffered `input` (at most 128 KiB, then closed) or this program's
  own stdin (`inheritStdin`), within `timeoutMs` (default the work limit),
  started in the absolute directory `cwd`. It covers 0.8.1's `exec`,
  `exec_input`, `exec_stdin`, `run_input`, `run_stdin` and `run_in`.
- `capture(argv, {input?, timeoutMs?, limit?}) -> Promise<Captured>` is
  byte-preserving: the report's fields with `stdout`/`stderr` as `Uint8Array`,
  at most `limit` bytes each (default 1 MiB). Reject `stdoutCut`/`stderrCut`
  if you need every byte.
- `cancel()` cancels **every** child this program owns, and every later
  launch; it is sticky. Each supervisor sends SIGTERM to its group, then
  SIGKILL once 500 ms have passed; this is not a graceful-shutdown guarantee.
- `interrupted()` tells whether SIGINT, SIGTERM or `cancel()` interrupted the
  program. Once the library has started a child, those signals cancel the
  children instead of ending the program: check it in long loops.
- `receipt(report)` serializes a report.

32 concurrent child commands per process, 64 argv entries (including the
executable), 4096 UTF-8 bytes per entry, no embedded NUL. Reports retain
32 KiB tails per stream and flag truncation; text reports replace malformed
UTF-8. Binary consumers use `capture` or `job.read(stream, {base64: true})`.
Spools preserve the **first** 1 MiB; overflow is disclosed and draining
continues so a full log does not deadlock its child.

Shells, pipelines and heredocs are ordinary explicitly invoked executables;
there is no hidden shell expansion. SIGINT/SIGTERM stop owned groups (SIGTERM,
then SIGKILL after 500 ms); deadlines and foreign failures kill them at once;
direct children are reaped, and every owned group is killed when the program
exits. Intentionally escaped daemons, SIGKILL/crashes or overridden signal
handlers are outside the guarantee. Side effects are never rolled back.

## `Session`: interactive children

- `Session.open(argv, {timeoutMs?})` starts a child with an open stdin and
  returns before it completes. The lifetime (default the work limit) is chosen
  once; reads and writes never refresh it.
- `session.write(text)` writes at most 65536 characters, waiting while the
  child is not reading.
- `session.closeInput()` sends EOF; idempotent.
- `session.readStdout(offset, max?)` / `readStderr` return raw bytes from a
  byte offset (offset <= 1048576, max <= 65536, default 65536).
- `session.status()` returns `{stdout, stderr}`: bytes spooled so far.
- `session.wait()` closes stdin, joins the child and returns its report; a
  launch failure throws.

Empty live reads are not EOF. Each spool retains only its first 1 MiB; a size
at `Session.spoolLimit` means it may be clipped. Correlate/validate protocol
replies and stop/restart before that cap if you need lossless protocol
semantics. Final tails and truncation are separate. A session uses checked
private storage and the same 1024-directory cap. A write may be buffered before
an asynchronous launch failure becomes visible; `wait()` remains
authoritative. Child deadlines unblock a writer if its peer is not reading.
Always `wait()`: dropping a session is not a join.
`examples/native/persistent.ts` keeps one child alive across three stateful
JSONL requests.

## `Job`: durable jobs from a program

The CLI's job verbs as methods. Jobs live in the storage home and outlive the
program; other processes, and other jev-fabric binaries, can control them.

| Call | CLI | Returns |
| --- | --- | --- |
| `Job.start(argv, {timeoutMs?, label?, cwd?, input?: 'pipe'})` | `start` | a `Job` once its worker is ready |
| `Job.list()` | `list` | `{jobs, truncated}` |
| `new Job(id)` | | a handle to an existing job |
| `job.status()` | `status` | running state or final receipt |
| `job.wait({timeoutMs?})` | `wait` | the receipt, or the running state at the deadline |
| `job.stop()` | `stop` | the receipt once the worker has ended the group |
| `job.events({after?, timeoutMs?})` | `events` | retained events past the cursor (a long poll with `timeoutMs`) |
| `job.follow({after?, timeoutMs?})` | `follow` | an async iterator of events, `follow.loss`, then one `follow.end` |
| `job.write(text)` / `job.closeInput()` | `write` / `close-input` | a write record |
| `job.read(stream, {offset?, max?, waitMs?, base64?})` | `read` | a read record |

Records are exactly the CLI's JSON, parsed (see Durable observations below).
`Job.start` re-enters the jev-fabric executable as the detached worker: under
`run` that is the running binary; from source it is Bun with `src/main.ts`;
otherwise the `jev-fabric` on PATH, or what `setExecutable(argv)` names.
Batch jobs keep each stream's first 1 MiB; `input: 'pipe'` jobs the latest
1 MiB.

## Jev and decisions

```ts
const jev = Jev.connect({maxEvaluations: 1, maxTokens: 10000})
const {json, value} = await jev.evaluate({state: '...', questions: {healthy: {type: 'noul', instructions: '...'}}})
```

- `Jev.connect({maxEvaluations, maxTokens, timeoutMs?, env?})` is a client
  from the environment (`env`, default `process.env`): `JEV_PROVIDER`,
  `JEV_MODEL`, the provider key or `JEV_CREDENTIAL_COMMAND`, and the
  per-request maximum `timeoutMs` (default `JEV_FABRIC_JEV_TIMEOUT_MS`, else
  30 s). It covers 0.8.1's `connect` and `from_env`.
- `jev.evaluate(request, {scope?, capMs?})` is one legacy Jev evaluation.
- `jev.decide(request, {credential?, scope?, capMs?})` is one additive lossless
  decision on the **same** budget; inspect `value.status` and `value.budget`.
  `credential` is that request's key alone, never cached.
- `jev.budget` is `{remaining, evaluations, tokens, limit}`.

A request is JSON text or an object (serialized with `JSON.stringify`). An
answer is `{json, value}`: `json` is the exact validated encoding (numbers keep
their original lexemes), `value` the same parsed with `JSON.parse`. Use `json`
when exact decimals matter.

Calls on one client run one at a time, in call order, each with the budget the
previous one left (0.8.1 threaded an affine client for the same reason). Make
another client for independent budgets. Trusted code can construct more
clients; budgets are not a security policy against it.

Provider configuration:

| JEV_PROVIDER | Key environment variable | Default model |
| --- | --- | --- |
| `typesafe` (default) | `TYPESAFE_API_KEY` | `jev-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | `~typesafe/jev-latest` |
| `vercel` | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` |
| `subq` | `SUBQ_API_KEY` | `subq-snap-preview` |

Routes are fixed; `JEV_MODEL` overrides the default. A request's explicit model
takes precedence. `JEV_CREDENTIAL_COMMAND` is a JSON argv array, not a shell
fragment. It has a 5-second maximum (or the shorter request time), 16 KiB
output bound, strict UTF-8 and printable single-line credential checks.
Resolver failures are sanitized. Successful credentials cache only in the
client object; nothing writes them into job metadata.

The request is validated before resolution. Exhausted budgets prevent even the
credential command. Invalid requests/credentials consume no call; dispatched
HTTP failures do consume a call and are not retried. Credential time is deducted
from the same HTTP deadline. Reported token overshoot blocks later calls.
Legacy usage requires both `input_tokens` and `output_tokens`: absent or
malformed usage is rejected, not counted as zero. The final request may still
be billed above the token limit. Use call limits as well.

Legacy Jev HTTP is HTTPS only, ignores proxies, follows no redirects, verifies
TLS (`CURL_CA_BUNDLE` may name the trust anchors), bounds the response to
1 MiB and never retries. `JEV_FABRIC_HTTP` selects the transport:

| Value | Transport |
| --- | --- |
| `auto` (default, or unset) | `pooled`, falling back to `exec` only if it cannot run |
| `pooled` | Bun's `fetch` in-process; its connection pool keeps DNS, TLS sessions and connections warm for later calls |
| `exec` | A fresh `curl` process per request; key/body travel in escaped private stdin config and curl startup config is disabled |

Any other value fails closed before network access. `cancel()`, SIGINT and
SIGTERM abort in-flight transfers.

Decisions: the [lossless decisions reference](decisions.md) covers preset
defaults, provider options, images and exact-number examples.
`DECISION_PROVIDER`, `DECISION_MODEL`, `DECISION_ENDPOINT`, preset key variables
and `DECISION_CREDENTIAL_COMMAND` configure them; `custom` uses
`DECISION_API_KEY`. Results carry `status:ok|error`, typed answers, provenance
and a budget marker. Absent confidence/distributions are never synthesized. A
per-question refusal keeps successful siblings. Malformed successful provider
responses return `status:error` with captured raw text and usage. Usage is
accounted before answer validation. Unknown/invalid usage or uncertain dispatch
stops further shared evaluations. Reported token overshoot returns the original
result with `budget:{exhausted:true,reason:'reported-token-limit'}` and blocks
later calls. Zero limits, invalid preflight and credential failures cause no
model dispatch. Decision HTTP uses `fetch` with a 16 MiB response bound and no
retries, redirects or environment proxies. Plain HTTP requires exact
`127.0.0.1` or `[::1]` and `allowLocal:true`; `localhost`/DNS aliases do not
qualify. Endpoints and resolver/config overrides are trusted inputs. Explicit
gateway fallback options can bill multiple stages.

## Pure policy modules

Re-exported namespaces. None of them does IO; they are the code the CLI runs
and `laws/` proves:

| Namespace | Holds |
| --- | --- |
| `Codec` | strict bounded JSON (`read`, `encode`, `validate`, `readBytes`, `decodeUtf8`, the `*WithLimit` and `*Profile` variants), field accessors (`field`, `text`, `array`, `fromJs`) |
| `Wire` | the legacy Jev wire contract: `request`, `body`, `response`, `usage`, exact decimals |
| `DecisionWire` | the additive decision schema: request validation, bodies, replies, usage |
| `DecisionConfig` | decision presets and routes |
| `TimeCore` | timeout parsing, defaults, the shared-budget arithmetic |
| `JevCore` | Jev routes, the client value, budget reservation |
| `HttpCore` | HTTPS endpoint, key and response-bound policy |
| `CredentialCore` | credential command parsing and checks |

`Codec` values are an AST (`Json`) that keeps every number as its lexeme and
every object's members in order. The boundary rejects malformed UTF-8,
duplicate object keys, unknown request fields, incomplete JSON, malformed
numbers, invalid IDs, missing answers, extra answer/probability keys and
non-finite/out-of-range values. JSON limits: 1 MiB encoded UTF-8, depth 64,
32768 AST/work units, 256 keys/object and Unicode scalars/key, and 1 MiB
cumulative key-comparison charge. Requests require Choice criteria objects
(1..255), Noul instructions, or Score criteria arrays (2..10), not a `choices`
or `scale` field. See `examples/native/request.json`.

Wire validation uses **exact decimal arithmetic**, not floats: probability
bounds and mass tolerance [0.98,1.02] include long fractions and tiny exponents
without rounding invalid values into range. Numeric lexemes are capped at 1024
characters, exponent magnitude 4096, and usage counts at 281474976710655
(48 bits). These limits intentionally differ from JavaScript numbers.
Decision-specific entry points accept explicit byte limits up to 16 MiB; local
logprob replies alone use a structural work profile up to 524288. See
[decision limits](decisions.md#size-limits-and-evidence).

## Durable observations

The jobs driver (`src/jobs`) owns lifecycle/control flow; `src/store` wraps the checked
filesystem boundary. Storage root is `JEV_FABRIC_HOME` or `.jev-fabric-native`.
Roots/job directories require owner-only permissions. Directory traversal,
symlink components, unsafe marker files and non-private files fail closed.
Writes are atomic and bounded. Workers hold a live advisory lease; no persisted
PID is treated as authority. A dead worker can be reported failed, but execution
is not resumed after a crash/reboot.

### Storage format

A storage home records its format in `.jev-fabric-store.json`, `{"store":1}`,
private and written atomically. A home created by this release gets it at once;
a home from an earlier release gets it from the first verb that writes to it
(`start`, `status`, `wait`, `stop`, `run`, a session spawn), while verbs that
only read (`list`, `events`, `follow`, `watch`, `read`) leave such a home as they
found it. A home whose marker names a newer format, or an unreadable marker, is
refused by every verb that touches the store with exit code 22 (for example
`storage home uses store format 2; this jev-fabric supports store format 1`),
and is never rewritten. Within a store version, changes are additive: readers
ignore unknown fields. The marker is not a job: `list` never shows it and it
does not count toward the directory cap. `src/store/core.ts` holds the decision
and `laws/store.ts` its laws. Stores written by 0.8.1 are read and controlled
by this release, and jobs started by either binary are listed and stopped by the other.

### Job records

`start` writes a private `meta.json` (`schemaVersion`, wall-clock `startedAt` in
epoch milliseconds, optional `label`, `lifetime`) before it spawns the worker. A label is 1..120
Unicode scalars on one line; control characters (C0, DEL, C1) and U+2028/U+2029
are rejected with code 2. It appears as `"label"` after `"id"` in the running
state, in every receipt (including recovered and launch-failure receipts) and in
`list`; a job without one has no `label` member. The running state and every
receipt then carry `"lifetime"`: `"durable"` for a job, `"session"` for a serve
session child (whose id is `s-` followed by its directory).

When the default root `.jev-fabric-native` is created, a private `.gitignore`
containing `*` is written into it (best effort, never read back). An existing
root, or one named by `JEV_FABRIC_HOME`, is left as it is. Hidden entries (the
`.gitignore`, the store marker) count toward neither the directory cap nor `list`.

Each job retains 64 events, at most two 1 MiB first-byte raw spools, and final
32 KiB tails. Output previews coalesce to the latest 2048 available bytes per
stream/tick, reporting `offset`, `bytes`, `omittedBytes`, and decoded `text`.
UTF-8 partial characters carry across adjacent chunks and reset across loss.
`process.spool_limit` discloses the hard spool cap. The worker atomically rewrites
the event file at most every four 25 ms ticks: new events after an idle period
publish on the next tick, continuous output publishes about every 100 ms, and
the final replay is written before the receipt. Ticks are at least 25 ms apart
and exactly 25 ms while output is arriving or an event is unsaved, so an event
is on disk within 100 ms of the output it reports (and `follow` prints it within
25 ms more). A quiet worker ticks every 50 then 100 ms, and ticks again on the next 25 ms
boundary once output arrives or its child exits; a `stop` marker is noticed
within 100 ms. Cursors are monotonically
increasing within a job; if the first returned sequence skips your cursor,
older events were evicted. `events` is a snapshot, not a lossless subscriber.
A recovered crash receipt does not synthesize a missing final replay event.

Event lines, as `events` and `follow` print them:

```json
{"sequence":1,"type":"job.started","data":{"id":"<job>"}}
{"sequence":2,"type":"process.output","data":{"stream":"stdout","offset":0,"bytes":6,"omittedBytes":0,"text":"ready\n"}}
{"sequence":3,"type":"process.spool_limit","data":{"stream":"stderr","limitBytes":1048576,"mayBeTruncated":true}}
{"sequence":4,"type":"job.finished","data":{"receiptAvailable":true}}
```

`events --timeout-ms N` is a long poll: it prints the snapshot as soon as an
event past the cursor exists or the job has a terminal receipt, and otherwise
prints nothing once N ms pass.

`follow` polls the event file every 25 ms and prints each event past the cursor
once, in order, as soon as the worker publishes it. If the first available
sequence skips the cursor, `{"type":"follow.loss","after":A,"next":B}` comes
first. It ends with exactly one line:

```json
{"type":"follow.end","reason":"finished","next":4,"receipt":{"id":"<job>",...}}
```

`reason` is `finished` only after the terminal receipt exists and the final
replay has been printed (the receipt is read before the events, and the worker
publishes the replay before the receipt). On `timeout`, `receipt` is the running
state. `next` is the last sequence printed, or the input cursor. `follow` exits 0
in both cases and fails like the other controls (code 2, 22) for an unknown or
invalid job. It never cancels, renews or signals the job.

`list` prints one object, newest `startedAt` first (jobs from before 0.4.0 have
none and sort last):

```json
{"jobs":[{"id":"<job>","state":"running","label":"dev","startedAt":1790640000000},
  {"id":"<job>","state":"exited","startedAt":1790630000000,"exitCode":0}],"truncated":false}
```

`state` is `running` while the worker holds its lease, `starting` before the
worker has announced itself, and otherwise the receipt state (`exited`,
`failed`, `timed_out`, `cancelled`); a dead worker without a receipt is
`failed` with a null `exitCode`, as `status` reports it, but `list` does not
write the recovery receipt. Directories that are not jobs (`run` and Session
storage), serve session children, unsafe entries and unreadable job files are
left out. At most 1024 jobs are reported; `truncated` discloses more.

### Interactive jobs, `write`, `close-input` and `read`

`start --input pipe` starts a job whose stdin stays open. Writers never touch the
child directly: `write` appends to a private input queue in the job directory
(`input.queue`, under an advisory lock), and the worker drains the queue into
the child's stdin in arrival order: it watches the queue file and wakes as a
writer appends, and it also polls the queue, 1 ms after it last took
something and backing off to every 100 ms, so a write waits at most 100 ms on
an idle job even where a file watch is unavailable. The queue holds at most
1 MiB not yet handed to the child; a write that would pass it fails (code 1,
`job input queue is full`) and changes nothing, so a child that stops reading
pushes back on its writers. `close-input` ends input after everything queued
before it. A write to a job without `--input pipe` is refused (code 22), and a
write after `close-input` or after the child has finished is an error (code 1),
never a silent drop.

```sh
id=$(jev-fabric -- start --input pipe -- python3 -u -i | jq -r .id)
jev-fabric -- write "$id" -- 'print(6 * 7)'        # words, joined by spaces
printf 'print(1)\n' | jev-fabric -- write "$id" --stdin
jev-fabric -- read --wait-ms 5000 "$id" stdout 0   # → {"offset":0,"bytes":3,"text":"42\n","next":3,...}
jev-fabric -- close-input "$id"
```

`write` adds nothing to the text: include the newline a line-oriented child
expects (`--stdin` passes bytes as they are). A write takes at most 65536
characters of UTF-8 text and reports `{"id":…,"written":N,"closed":false}`, `N`
counting bytes; `close-input` reports `"written":0,"closed":true`.

An interactive job's streams keep the latest 1 MiB each (a rolling spool)
instead of the first 1 MiB; `events`, `follow` and `watch` work as for any
job, and loss shows as `omittedBytes`, not as `process.spool_limit`.

`read` returns raw bytes of any job's stream by byte offset: the read record of
[Shell composition](composition.md) (`offset`, `bytes`, `omittedBytes`, `text`
or with `--base64` `data`, `next`, `eof`, `state`). Offsets count every byte the
child wrote. A batch job's spool keeps the first 1 MiB, so a read past it returns
nothing; an interactive job's keeps the latest 1 MiB, so a read below it starts
at the oldest byte kept and discloses the gap. A partial UTF-8 character at the
end is held for the next read until the stream ends. `read` never writes to the
store.

If an interactive job's worker crashes, `status` reports it failed as for any
job. Its queued input is not replayed: nothing resumes the child, and writes
fail with `job has finished`.

Deleting old directories is an explicit user retention decision. Never delete
an active job's directory. There is a 1024-directory cap, not automatic GC.

## Not in the library

What 0.8.1's Bend modules offered that the library leaves out, and why:

| 0.8.1 | Why it is not here | Instead |
| --- | --- | --- |
| `Monitor.command` (`watch`) | a CLI verb with its own output protocol, not a program building block | `job.follow()` and filter in TypeScript, or `exec([jevFabric, '--', 'watch', ...])` |
| `Process.run_logged`, `Process.Native.exec_pipe`, `Process.stdin()`, the CLOEXEC pipe | raw file-descriptor plumbing for the job worker and sessions | `Session`, `Job.start(..., {input: 'pipe'})`, `Bun.stdin` |
| `Http.post` | a lower-level URL API; programs have `fetch` | `fetch`, or `jev.evaluate` for Jev's policy |
| `Credentials.resolve` | internal to an evaluation | `JEV_CREDENTIAL_COMMAND`, `decide(..., {credential})` |
| `DecisionGenerated`, `DecisionLocal`, `DecisionHttp`, `DecisionTargets` | internals of `decide` (offline target resolution stays the `resolve-decision` verb) | `jev.decide`, the CLI |
| `Session.cancel_scope` | the same as `cancel()` | `cancel()` |
| `Jev.Returned` and threading the affine `Jev.Client` | a `Jev` object serializes its calls and keeps its budget | `jev.budget` |
| `MonitorCore`, `ServeCore`, `Cli` | policy of CLI verbs, not of programs | the CLI |
| `IO.fork`/`IO.join` | promises do this | `Promise.all` |
