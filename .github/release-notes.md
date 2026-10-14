Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.7.1

- Built with Bend 2.0.37 (was 2.0.36). No source change was needed: the native
  effect ABI (`io_eff`) is unchanged, and 2.0.37's breaking change, a `Nat`
  crossing to a JavaScript host as a plain number, does not touch the native
  build.
- Compiling your own `jev-fabric -- run` programs now needs Bend 2.0.37.
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
`curl` and a CA store; compiling your own Bend programs needs Bend 2.0.37.
