# Writing jev-fabric programs in TypeScript

Use a program when a task needs a loop: many Jev calls with one client, a
persistent child process, or processes and decisions sharing one deadline.

## Setup

```bash
jev-fabric -- run bot.ts some-arg                 # one deadline, prints the receipt
jev-fabric -- run --timeout-ms 600000 bot.ts      # a longer ceiling (max 1 h)
```

`run` uses the Bun inside the jev-fabric binary: no Bun, Node or `node_modules`
needed, and `import ... from 'jev-fabric'` always resolves to the library that
binary carries. Everything else is plain Bun (top-level await, other imports,
`tsconfig.json`). For editor types, `bun add -d jev-fabric`. The same library
runs under plain `bun bot.ts` with the package installed (Bun only).

```ts
import {Jev, Job, Scope, Session, capture, exec, receipt, FabricError} from 'jev-fabric'
```

`process.argv.slice(2)` is what follows the program. Failures throw
`FabricError` (`code` is the CLI's exit code); a process report is a value:
check `report.code`, `timedOut`, `cancelled`.

## Processes

```ts
const report = await exec(['/bin/echo', 'hi'])
await exec(['/bin/cat'], {input: 'buffered stdin'})
await exec(argv, {timeoutMs: 5000, cwd: '/abs/dir'})
console.log(receipt(report))                       // the JSON receipt `exec` prints
const raw = await capture(argv, {limit: 1048576})  // stdout/stderr as Uint8Array
```

At most 32 concurrent children per process, 64 argv entries. Concurrency is
`Promise.all`. `cancel()` stops every child; `interrupted()` tells a long loop
that SIGINT/SIGTERM arrived.

## Session: a persistent child

```ts
const session = Session.open(['python3', 'bridge.py'])
await session.write('move\n')
const bytes = session.readStdout(offset, 65536)         // raw bytes from a byte offset
const report = await session.wait()                     // closes stdin, joins
```

An empty read is not EOF: poll with a short sleep and a bound until your
protocol's line terminator arrives, advancing `offset` by the bytes received.
Each stream spools its first 1 MiB; restart the child before that if the
protocol is long-lived. Always `wait()` at the end.

## Jev

```ts
const jev = Jev.connect({maxEvaluations: 200, maxTokens: 1000000})
const answer = await jev.evaluate({
  state: 'Synthetic build: 12 tests passed.',
  questions: {healthy: {type: 'noul', instructions: 'Do the tests look healthy?'}},
})
answer.value.answers.healthy.noul      // parsed; answer.json keeps exact number lexemes
jev.budget                             // {remaining, evaluations, tokens, limit}
```

Calls on one client run one at a time, in order. The first call resolves the
credential; later calls reuse it and the warm TLS connection. A failed
dispatch still counts and is never retried. `jev.decide(request, {credential?})`
is a lossless decision on the same budget; inspect `value.status` and
`value.budget`.

## Scope: one shared deadline

```ts
const scope = Scope.open()                       // or Scope.withTimeout(ms)
const [a, b] = await Promise.all([scope.exec(['make', 'lint']), scope.exec(['make', 'test'])])
const answer = await jev.evaluate(request, {scope})
```

Every operation uses the remaining time; an expired scope launches nothing
(`exec` reports 124, Jev and `start` throw 124).

## Jobs from a program

```ts
const job = await Job.start(['npm', 'run', 'dev'], {label: 'dev'})
for await (const event of job.follow({timeoutMs: 30000})) if (event.type === 'follow.end') break
await job.stop()
```

The CLI's job verbs as methods; records are exactly the CLI's JSON. Jobs outlive
the program and are visible to `jev-fabric -- list`.

## Environment

| Variable | Effect |
| --- | --- |
| `JEV_PROVIDER` | `typesafe` (default), `openrouter`, `vercel` or `subq` |
| `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` / `SUBQ_API_KEY` | Provider key |
| `JEV_CREDENTIAL_COMMAND` | JSON argv printing the key, e.g. `["pass","show","jev"]` |
| `JEV_MODEL` | Model override |
| `JEV_FABRIC_HTTP` | `auto` (default: in-process `fetch`, curl fallback), `pooled` or `exec` |
| `JEV_FABRIC_TIMEOUT_MS` / `JEV_FABRIC_JEV_TIMEOUT_MS` | Default ceilings |
| `JEV_FABRIC_HOME` | Job storage root (default `.jev-fabric-native`) |

Full reference: `docs/native-api.md` in the installed share directory or the
repository.
