# Bend to TypeScript

jev-fabric 0.8.1 was the last release written in Bend. From 0.9.0 the
executable is TypeScript on Bun, compiled to one file with
`bun build --compile`, and every law of its pure core is proven with
gdp-wired (`bun run laws`). This page lists what that means for you.

## Unchanged

- **The CLI.** Every verb, option, legacy positional form, exit code and
  error message, and the JSON each prints, byte for byte, except `run` and
  the version banner (below). `test/conformance/` checks the new binary
  against the 0.8.1 binary.
- **`serve`.** The JSONL protocol, its banner, options, error codes and
  limits ([serve protocol](serve-protocol.md)). The Python and TypeScript
  clients in `clients/` work unchanged.
- **The store.** The storage home, `.jev-fabric-store.json`, job directories,
  `meta.json`, receipts, events, spools and rings, leases and input queues
  keep their names and formats. Stores written by 0.8.1 are read and
  controlled by 0.9.0, and jobs started by either binary are listed, read,
  written to, stopped and recovered by the other.
- **Process semantics.** Each child in its own process group, deadlines that
  kill the group, SIGTERM then SIGKILL after 500 ms, detached workers that
  re-enter the executable, advisory leases.
- **Jev and decisions.** Validation before credentials, a call reserved
  before dispatch, complete answer validation, no retries, the same
  providers, routes, environment variables and limits.

## Changed: programs are TypeScript

0.8.1 had a third way in besides the CLI and `serve`: Bend programs that
imported the installed `native/*.bend` modules and ran with
`jev-fabric -- run program.bend`. That way is now a TypeScript library:

```ts
// examples/native/persistent.ts
import {Session, receipt} from 'jev-fabric'

const session = Session.open(['/bin/sh', '-c', 'while IFS= read -r v; do echo "got $v"; done'])
for (const value of ['10', '20', '30']) await session.write(`${value}\n`)
console.log(receipt(await session.wait()))
```

```sh
jev-fabric -- run examples/native/persistent.ts
```

`run` executes a `.ts` or `.js` program with the Bun built into the
executable: no Bend, no compiler, no `node_modules` needed. Bun runs it as
`bun program.ts` would, and `jev-fabric` resolves to the library that binary
carries. The same library runs under plain `bun program.ts` (Bun only: it
uses `bun:ffi` for process groups and locks). See
[the library API](native-api.md).

The `examples/native/*.bend` programs are now `examples/native/*.ts`:
`pipeline`, `scoped`, `persistent`, `judge`, `browse`, `doom` and `wikirace`.

### Bend modules and their TypeScript names

| 0.8.1 (Bend) | 0.9.0 (`import ... from 'jev-fabric'`) |
| --- | --- |
| `Scope.open()`, `Scope.with_timeout(ms)` | `Scope.open()`, `Scope.withTimeout(ms)` |
| `Scope.exec`, `Scope.run`, `run_for(scope, argv, input, cap)` | `scope.exec(argv, {input, capMs})` |
| `Scope.start`, `start_for` | `scope.start(argv, {capMs})` |
| `Scope.evaluate`, `evaluate_for` | `jev.evaluate(request, {scope, capMs})` |
| `Process.exec`, `exec_input`, `exec_stdin`, `run_input`, `run_stdin`, `run_in` | `exec(argv, {input, inheritStdin, timeoutMs, cwd})` |
| `Process.capture` | `capture(argv, {input, timeoutMs, limit})` |
| `Process.cancel`, `Session.cancel_scope` | `cancel()`; `interrupted()` |
| `Process.show`, `Process.exit_code` | `receipt(report)`, `report.code` |
| `Session.open`, `Session.start` | `Session.open(argv, {timeoutMs})` |
| `Session.write`, `close_input`, `read_stdout`, `read_stderr`, `status`, `wait` | `session.write`, `closeInput`, `readStdout`, `readStderr`, `status`, `wait` |
| `Session.spool_limit()` | `Session.spoolLimit` |
| the job verbs through the CLI | `Job.start`, `Job.list`, `job.status`, `wait`, `stop`, `events`, `follow`, `write`, `closeInput`, `read` |
| `Jev.connect(calls, tokens)`, `Jev.from_env(ms, calls, tokens)` | `Jev.connect({maxEvaluations, maxTokens, timeoutMs})` |
| `Jev.evaluate(client, json)` → `(client, result)` | `await jev.evaluate(request)` → `{json, value}` |
| `Decision.evaluate(client, json, credential)` | `await jev.decide(request, {credential})` |
| `Decision.encode`, `Codec.encode` | `answer.json` (or `Codec.encode`) |
| `IO.fork` / `IO.join` | `Promise.all` |
| `Codec`, `Wire`, `DecisionWire`, `DecisionConfig`, `TimeCore`, `JevCore`, `HttpCore`, `CredentialCore` | the same names, re-exported |
| `Monitor.command`, `Http.post`, `Credentials.resolve`, `Process.run_logged`, `Process.stdin`, the pipe | not exported; see [Not in the library](native-api.md#not-in-the-library) |

Idioms that changed:

- **Errors.** A recoverable `Result` is now an exception: `FabricError` with
  the same `code` and message. A process report is still a value; check
  `report.code`.
- **Affine handles.** You no longer thread a returned session or client into
  the next call. A `Session` is an object; a `Jev` client runs its calls one
  at a time in call order and keeps its own budget (`jev.budget`). Use two
  clients for two budgets.
- **Answers.** `evaluate` and `decide` resolve to `{json, value}`: `json` is
  the exact validated encoding, numbers as their original lexemes; `value` is
  `JSON.parse(json)`.
- **Arguments.** `process.argv.slice(2)` is what follows the program, where
  Bend's `IO.args()` started with the program itself.
- **Signals.** Once the library has started a child, SIGINT and SIGTERM cancel
  the program's children instead of ending it (as the Bend runtime did);
  `interrupted()` tells a long loop to stop.

### `run`

- The program is a `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs` or
  `.jsx` file. A `.bend` source now exits 2 with
  `run executes TypeScript or JavaScript programs; Bend programs are no longer supported (see docs/bend-to-typescript.md)`.
  Any other path, or one that looks like an option, exits 2 with
  `run requires 1..3600000 ms and a .ts or .js program path (not an option)`
  (0.8.1 said `a .bend source path`). Every other `run` argument error is
  unchanged, in the same order.
- There is no compile step: the whole deadline is the program's. The receipt,
  the exit code, `native program did not complete successfully` and 124 on
  the deadline are as before. A missing program shows up the same way a
  missing `.bend` source did: a failed receipt carrying the runtime's error
  (`error: Module not found ...`) and exit 1.
- Each run still takes one private directory in the storage home (counted
  towards the 1024-directory cap). It now holds `preload.js` and, from the
  compiled binary, `jev-fabric.js` (the library, about 240 KB) instead of a
  compiled program.
- The child is `BUN_BE_BUN=1 jev-fabric --preload <dir>/preload.js <program>`,
  so a program gets four fewer argv entries than the 64-entry limit allows
  (0.8.1's `<program> --RTS` took two).
- `Bun.spawn` without `env` passes `BUN_BE_BUN=1` on to its children; see
  [the caveat](native-api.md#run).

## Changed: the version banner and help

- `--version` prints `0.9.0-native (Bun <version>; <platform>)` where 0.8.1
  printed `0.8.1-native (Bend 2.0.38)`. Parse `capabilities` instead.
- `--help` starts with `jev-fabric native (TypeScript on Bun)` and no longer
  mentions system libcurl.
- `capabilities` keeps 0.8.1's feature list in order; later releases only
  append.

## Every deviation from 0.8.1

Behaviour of the new binary and library that differs from 0.8.1, besides
`run` and the banner above:

- **Jev HTTP.** The `pooled` (and `auto`) transport is Bun's `fetch` instead
  of system libcurl, under the same policy: HTTPS only, no proxy, no
  redirects, TLS verified with `CURL_CA_BUNDLE` honoured, 1 MiB bound, the
  whole request deadline, no retries. `exec` still runs one `curl` per
  request. The `unavailable` message still says libcurl could not be loaded.
- **Decision HTTP.** `fetch` by default instead of the `curl` executable
  (7.82+), with the same policy and a 16 MiB bound that fails rather than
  truncates. Decisions no longer need curl.
- **Label softmax math** (local logprob readouts) is plain TypeScript instead
  of a C helper; `Math.exp` may differ from C's `exp` in the last bit.
- **Out-of-range caps.** A scope cap outside 1..3600000 for a Jev evaluation
  or decision is an error (code 2) instead of ending the process.
- **The Jev client.** Instead of an affine value, an immutable value that an
  evaluation consumes; reusing a consumed client throws. The library's `Jev`
  class hides this.
- **`--RTS`.** 0.8.1's Bend runtime treated `+RTS ... -RTS` and a `--RTS`
  anywhere as runtime options. Now only a leading `--RTS` (the job worker's and
  serve child's re-entry) is dropped; every later argument is literal.
- **Additions.** Process capture, `watch` (used by `serve`), Jev and decision
  evaluations take an `AbortSignal` that cancels one call alone; a cancelled
  `watch` ends with a `monitor.end` whose reason is `cancelled`. The CLI never
  uses them.
- **Library limits.** `Session.write` and `job.write` refuse more than 65536
  characters by throwing, as the CLI exits 2; the library validates `cwd` and
  labels before starting a job, with the CLI's messages.

### 0.8.1 behaviour kept although its docs said otherwise

The new binary does what 0.8.1 did, not what its docs said
(test/conformance/README.md):

- Unsafe-store refusals exit with the errno of the failing check, not 22: a
  symlinked root or job directory 20 (ENOTDIR), a symlinked receipt ELOOP (62
  on macOS), an oversized one 27 (EFBIG), a world-readable one 1.
- `follow 300 <id>` (the positional form its usage line shows) is not
  supported: `300` is read as the id.
- Events replace an invalid UTF-8 sequence such as `ED A0 80` with one U+FFFD;
  `exec` receipts replace it with three.
- `read --base64` of a live stream holds back a trailing partial UTF-8
  character.
- serve: a line that is not strict JSON gets the parser's failure position as
  its error code; a line of spaces is not blank.
- serve: `watch` with an empty literal answers `ok:true` with `[]`; `exec`
  accepts `stdin` beyond 128 KiB; the "unknown op" message omits
  `resolveDecision`; a bogus `JEV_FABRIC_HTTP` is accepted at startup (only
  `jev` fails on it).
- `exec` with a missing argv command exits 2 `native subprocess request
  failed`; too many or too long argv entries exit 22 with the same message.
- Legacy `jev` with `JEV_PROVIDER=openrouter` posts to
  `https://openrouter.ai/api/alpha/decisions`; the `openrouter` decision preset
  uses `https://openrouter.ai/api/v1/systemone`.
- `decide` without a key says `Missing provider key or JEV_CREDENTIAL_COMMAND`
  although decisions use `DECISION_CREDENTIAL_COMMAND`.
- `resolve-decision --profile x` with no profile document fails with
  `missing wire field`; malformed `DECISION_PROFILES` exits 1
  (`unexpected end`).
- An exit status outside 0..255 prints a second line,
  `bend: exit code must be in 0..255`, and exits 1; a code of 0 (a parse error
  at the first character) exits 0 with the message printed.
- `watch`'s `omitted` count is always 0.
- Labels and ids count UTF-16 units, while a model's `maxLength` counts
  Unicode scalars.
- Interactive jobs keep `stdout.ring`/`stderr.ring` (a 16-byte header: bytes
  written as a little-endian u64, then an ended flag), `input.queue` and
  `input.closed`; batch jobs `stdout.bin`/`stderr.bin`.

## Installing

The release archive and `install.sh` still install one `jev-fabric`
executable; it carries the library, so `run` needs nothing else. The Bend
sources (`native/`) are no longer installed or needed. For editor types and
for running programs with plain Bun, install the `jev-fabric` package.
