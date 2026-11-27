# Testing

Four layers, each checking something the others can't:

```sh
bun install --frozen-lockfile
bun run typecheck          # tsc over src/, laws/, test/, the TypeScript client and examples
bun run test:unit          # bun test src: the pure modules and their drivers
bun run laws               # gdp-wired: every law of the pure core, ends ALL LAWS PROVEN
bun run test:conformance   # builds build/jev-fabric, then runs test/conformance against it
bun run test               # all four, plus a check that docs/laws.md is current
```

## Unit tests

`src/<area>/*.test.ts`, next to the code. Pure modules are tested by value;
drivers against real processes, temporary stores under `.tmp/` and local fake
HTTP endpoints. They run from source, so no build is needed.

## Laws

`laws/<area>.ts` states each pure rule as a [gdp-wired](https://github.com/monotykamary/gdp-wired)
rule, proves its laws, refuses a broken variant of each, and runs the rule
beside the real code. `bun run laws` prints one row per item and ends with
`ALL LAWS PROVEN` only when every row holds (about 20 s). [Laws](laws.md) lists
them; `bun run laws:doc` regenerates that page from the same entries, and
`bun run test` fails if it is stale.

A law is not a reason to delete a test case unless the case's obligation is a
proven law about the code it tested, or the same boundary is already
witnessed elsewhere. The laws don't reach the drivers (processes, files,
clocks, `fetch`, libc), so those keep their tests.

## Conformance

`test/conformance/` is a black-box suite of the executable: every CLI verb,
the `serve` protocol and the on-disk store, compared byte for byte with what
the 0.8.1 Bend binary did. `JEV_FABRIC_BIN` names the binary under test
(`bun run test:conformance` sets it to `build/jev-fabric`); with no
`JEV_FABRIC_BIN`, `bun test test/conformance` runs the 0.8.1 oracle at
`.tmp/oracle-0.8.1/jev-fabric`. `JEV_FABRIC_OTHER_BIN` adds the compatibility
group: jobs started by one binary listed, read, written to, stopped and
recovered by the other, in both directions. See
[its README](../test/conformance/README.md) for what is normalised and where
0.8.1 differs from its own docs.

No test reaches the network or uses a real credential: Jev and decision calls
go to a local fake endpoint or a fake `curl` on `PATH`.

## Clients

The Python client has its own offline suite against a built binary:

```sh
JEV_FABRIC_BIN=build/jev-fabric python3 clients/python/test_jev_fabric.py
```

## CI

`.github/workflows/ci.yml` runs typecheck, unit tests, laws and conformance
(and the Python client suite) on Ubuntu and macOS for every push and pull
request. A release builds every platform's binary and smoke-tests each on its
own runner before anything is published.
