Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.9.0

jev-fabric is now TypeScript on Bun, compiled to one executable with
`bun build --compile`. Bend is gone from the build, the release and the repo.

- Unchanged: every CLI verb, its arguments, exit codes and JSON; the `serve`
  protocol (2); the store format (1). Stores and jobs are shared both ways with
  0.8.1: either binary lists, reads, writes to and stops jobs the other started.
- The pure policy core's laws are proven with
  [gdp-wired](https://www.npmjs.com/package/gdp-wired) and held to the code that
  runs (`bun run laws`; [docs/laws.md](docs/laws.md) lists them).
- `jev-fabric -- run program.ts` runs TypeScript or JavaScript with the Bun
  inside the executable; `import {Scope, Session, Job, Jev, exec} from 'jev-fabric'`
  needs no `node_modules`. Bend programs are no longer supported: see
  [Bend to TypeScript](docs/bend-to-typescript.md).
- `+RTS`, `-RTS` and `--RTS` are no longer runtime options: they reach your
  command as ordinary arguments (a leading `--RTS` is still dropped).
- Performance against 0.8.1, on an M-series Mac:
  - faster: `exec` (about 11 ms vs 14.5), `serve` throughput (2000 requests in
    30 ms vs 166), a `serve` child's spawn (about 2 ms vs 9);
  - slower to start: a bare command (`--version`, `status`) takes about 6 ms vs
    2, and `start` + `wait` about 48 ms vs 38;
  - idle jobs use less CPU than before.
- `serve` session children are supervised inside the `serve` process, with one
  small shell watchdog per session that still stops them if `serve` is killed.
  16 idle children take about 15 MB (0.8.1: about 32 MB).
- Each durable job's worker is a Bun process: about 4 MB of system memory per
  idle job on Linux and about 8 MB on macOS (0.8.1: about 2 MB). The executable
  is about 90 MB (0.8.1: 5 MB).
- The executable ignores `.env` and `bunfig.toml` in the directory it runs from.
- Linux builds need glibc 2.17 or newer (was 2.28); x64 builds run on CPUs
  without AVX2.
- npm: `jev-fabric` also ships the library as TypeScript source. Under Bun,
  `import ... from 'jev-fabric'` is the library plus `binaryPath()`; under Node
  it is the locator, as before (`jev-fabric/locate` either way).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh | sh
npx skills add fabric-runtime/jev-fabric
```

| Archive | Platform |
| --- | --- |
| `jev-fabric-darwin-arm64.tar.gz` | macOS 11+, Apple silicon (new) |
| `jev-fabric-darwin-x64.tar.gz` | macOS 11+, Intel (new) |
| `jev-fabric-darwin-universal.tar.gz` | macOS 11+, both (twice the download) |
| `jev-fabric-linux-x64.tar.gz` | Linux x86_64, glibc 2.17+ |
| `jev-fabric-linux-arm64.tar.gz` | Linux aarch64, glibc 2.17+ |

The installer picks the archive for your Mac's architecture and falls back to
the universal one for releases that lack it. Update later with
`jev-fabric -- update`, which reruns the installer.

Each archive holds the `jev-fabric` executable, single-file Python and
TypeScript clients (`clients/`) for `jev-fabric -- serve` sessions, the
examples, the docs, the agent skill and `BUILD-PROVENANCE` (commit, Bun version,
build run, the executable's SHA-256). Verify with `SHA256SUMS`; the installer
does this for you. The `native/` Bend library is gone: `run` programs import
the library the executable carries.
