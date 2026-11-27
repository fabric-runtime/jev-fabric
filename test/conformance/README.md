# Conformance suite

Black-box tests of the `jev-fabric` executable: every CLI verb, the `serve`
JSONL protocol and the on-disk store, checked byte for byte against what the
0.8.1 Bend binary (the oracle) does. The TypeScript port must pass it
unchanged.

## Running

```sh
bun test test/conformance                                   # the oracle, .tmp/oracle-0.8.1/jev-fabric
JEV_FABRIC_BIN=build/jev-fabric bun test test/conformance    # another binary
JEV_FABRIC_OTHER_BIN=.tmp/oracle-0.8.1/jev-fabric \
  JEV_FABRIC_BIN=build/jev-fabric bun test test/conformance  # plus store compatibility
```

`JEV_FABRIC_BIN` names the binary under test (relative paths resolve from the
repository root). `JEV_FABRIC_OTHER_BIN` turns on `compat.test.ts`: jobs started
by one binary are listed, read, written to, stopped and recovered by the other,
and a store root made by one is accepted by the other, in both directions.
Without it that group is skipped.

The whole suite takes about 20 s on an M-series Mac. Tests inside each file run
concurrently (`describe.concurrent`); each file gets one root
`.tmp/conformance-<file>-XXXXXX` with a separate storage home per test, and the
root is removed after the file, once every job it started has been stopped.
`.tmp/oracle-0.8.1/jev-fabric` is the macOS arm64 build; on Linux, put the
0.8.1 release's `jev-fabric-linux-x64` (or `-arm64`) there instead. Errno-valued
exit codes are tabled per platform in `harness.ts`.

`run` is the one verb whose behaviour changed on purpose: 0.8.1 compiled Bend
sources, later builds run TypeScript or JavaScript with their embedded Bun. The
harness's `BEND_RUN` (the binary's `--version` names Bend) selects 0.8.1's
expectations for the oracle and the new ones otherwise.

## Files

| File | Covers |
| --- | --- |
| `cli.test.ts` | `--version`, `--help`, `capabilities`, `--` vs bare spelling, unknown commands, `run` argument errors, `update` (fake curl) |
| `exec.test.ts` | receipts and their exact escaping, exit codes, 32 KiB tails, stdin, literal argv, `--cwd`, timer configuration, argv bounds, deadlines killing the whole group (grandchild and TERM-ignorers included), SIGTERM then SIGKILL after 500 ms, SIGINT |
| `jobs.test.ts` | `start`/`status`/`wait`/`stop`/`events`/`list` records, job files and modes, labels, day-long lifetimes, deadline and stop group kills, detached workers surviving their caller, 1 MiB spools, 64-event ring, UTF-8 framing, crash and orphan recovery, unsafe ids and files |
| `observe.test.ts` | `follow` (live, cursors, timeout, `follow.loss`), `events --timeout-ms`, `watch` (filter, dedup, 32-line batches, 4096 clipping, deadline, `monitor.loss` for eviction, omitted bytes and spool caps) |
| `interactive.test.ts` | `start --input pipe`, `write`, `close-input`, `read` from separate processes, the 1 MiB input queue, rolling rings and their header, partial UTF-8, crashed workers |
| `store.test.ts` | the `.jev-fabric-store.json` marker, adoption, newer/unreadable formats, the default root's `.gitignore`, `--cwd` |
| `serve.test.ts` | banner, options, strict request errors, id echo, framing, the 16 MiB line limit, concurrency, the session deadline, job operations over serve |
| `sessions.test.ts` | `spawn` children: write/read/closeInput records, ordering, base64, rolling windows, session listings, foreign connections, the 64-request queue, 16-child limit, shutdown, owner death (SIGKILL: children forced, cancelled receipts published), SIGTERM/SIGINT, leases seen by the CLI, children that never start, request latency while a child floods |
| `jev.test.ts` | `validate`, legacy `jev`, `decide`, `validate-decision`, `resolve-decision`, `decision-providers` and their serve ops |
| `compat.test.ts` | two binaries on one store (only with `JEV_FABRIC_OTHER_BIN`) |

## What is normalised

Only what truly varies between runs: job ids (taken from `start`'s output),
`s-` session ids, process ids (children print their own), `startedAt`
(checked to be epoch milliseconds within five minutes of now), `elapsedMs`,
the binary's version string and platform (checked by shape; the feature list
must start with the 0.8.1 features in order) and temporary paths.

Everything else is exact. CLI output is compared byte for byte with an encoder
that escapes every control character as `\u00XX` and nothing else (as the CLI
does for receipts, events, read records and lists); `serve` lines and the
offline validation/decision verbs are compared with `JSON.stringify` (short
escapes such as `\n`). Key order is part of the comparison. Error messages on
stderr and in serve error objects are compared exactly, with their exit codes.

## Jev without the network

No test reaches the network. Every environment is built from scratch (no
inherited provider keys), `JEV_FABRIC_HTTP=exec` is always set, and the first
directory on `PATH` holds a guard `curl` that records any attempt; the suite
fails if one is recorded.

- Legacy `jev` routes are fixed HTTPS URLs (no endpoint override), so it can only
  be exercised through its documented exec transport: `JEV_FABRIC_HTTP=exec` with a
  fake `curl` on `PATH` that reads the private stdin config (`url`, `header`,
  `data-binary`, `max-time`) and answers `<body>\n<status>`. A port that keeps
  `JEV_FABRIC_HTTP=exec` must speak that contract; if it drops the exec transport,
  those tests (marked "exec transport") need a replacement interception point.
- `decide` accepts an explicit endpoint, so it is tested against a local fake
  server on `http://127.0.0.1:<port>` with `allowLocal:true` (plain HTTP to exact
  loopback is the documented local opt-in). That path is transport-agnostic.
- Offline paths need nothing: validation before credentials, missing and malformed
  credentials, credential-command failures and deadlines, zero budgets,
  provider/route preflight, profiles and `resolve-decision`.

## Oracle behaviour that differs from the docs

The oracle wins; these are asserted as the oracle does them, with a comment:

- Unsafe-store refusals exit with the errno of the failing check, not 22: a
  symlinked root or job directory exits 20 (ENOTDIR), a symlinked receipt ELOOP
  (62 on macOS), an oversized one 27 (EFBIG), a world-readable one 1.
- `follow 300 <id>` (the positional-timeout form its usage line shows) is not
  supported: `300` is read as the id.
- Events replace an invalid UTF-8 sequence such as `ED A0 80` with one U+FFFD;
  `exec` receipts replace it with three.
- A `read --base64` of a live stream also holds back a trailing partial UTF-8
  character.
- serve: a line that is not strict JSON gets an error code equal to the parser's
  failure position (1, 3, 22, 27 …), not a code from the documented table; a line
  of spaces is not blank.
- serve: `watch` with an empty literal answers `ok:true` with `[]` (the CLI step's
  usage error is swallowed); `exec` accepts `stdin` beyond the documented 128 KiB.
- serve's "unknown op" message does not list `resolveDecision`, though it is
  supported.
- `serve` accepts a bogus `JEV_FABRIC_HTTP` at startup; only `jev` fails on it.
- A missing argv command in `exec` exits 2 "native subprocess request failed";
  too many or too long argv entries exit 22 with the same message.
- Legacy `jev` with `JEV_PROVIDER=openrouter` posts to
  `https://openrouter.ai/api/alpha/decisions`, while the `openrouter` decision
  preset uses `https://openrouter.ai/api/v1/systemone`.
- `decide` without a key says "Missing provider key or JEV_CREDENTIAL_COMMAND"
  although decisions use `DECISION_CREDENTIAL_COMMAND`.
- `resolve-decision --profile x` with no profile document fails with
  "missing wire field"; malformed `DECISION_PROFILES` exits 1 ("unexpected end").
- `start --input pipe` rings live in `stdout.ring`/`stderr.ring` (16-byte header:
  bytes written, little-endian u64, then an ended flag), `input.queue` and
  `input.closed`; batch jobs use `stdout.bin`/`stderr.bin`. The tests pin these
  names because other binaries read them.
