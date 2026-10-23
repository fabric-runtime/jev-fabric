Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.8.1

- Built with Bend 2.0.38 (was 2.0.37). The native effect ABI and the project's
  C are unchanged.
- A single leading `--` is now optional: `jev-fabric -- exec ...` and
  `jev-fabric exec ...` are the same call, so existing scripts, the clients and
  `jev-fabric -- serve` launchers keep working.
- Bend runtime options now go between `+RTS` and `-RTS` (or in `BENDRTS`), and
  the runtime reads those words wherever they appear on jev-fabric's own
  command line. To pass them to a child, use `serve` or put them after `--RTS`,
  which passes everything after it through verbatim. Durable jobs, `serve` and
  `run` re-enter with `--RTS`, so a requested argv stays literal.
- Compiling your own `jev-fabric -- run` programs now needs Bend 2.0.38.
- The safety gate reads 2.0.38's grouped trust verdict: drivers pass only with
  the "foreign effects" group, and any `@unsafe` group fails the build.
- Unchanged: protocol 2, store format 1, every route, preset and default.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh | sh
npx skills add fabric-runtime/jev-fabric
```

| Archive | Platform |
| --- | --- |
| `jev-fabric-darwin-universal.tar.gz` | macOS 11+, Apple silicon and Intel |
| `jev-fabric-linux-x64.tar.gz` | Linux x86_64, glibc 2.28+ |
| `jev-fabric-linux-arm64.tar.gz` | Linux aarch64, glibc 2.28+ |

Update later with `jev-fabric -- update`, which reruns the installer.

Each archive holds the `jev-fabric` executable, the Bend library (`native/`) for
`jev-fabric -- run` programs, single-file Python and TypeScript clients
(`clients/`) for `jev-fabric -- serve` sessions, the examples and the agent skill. Verify with
`SHA256SUMS`; the installer does this for you. Jev calls need the system libcurl or
`curl` and a CA store; compiling your own Bend programs needs Bend 2.0.38.
