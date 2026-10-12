Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.7.0

- Add [SubQ Snap](https://docs.subq.ai/), a System One model with the TypeSafe
  contract. Legacy `jev` routes to it with `JEV_PROVIDER=subq` and
  `SUBQ_API_KEY` (model `subq-snap-preview`); `serve` accepts
  `"provider":"subq"` per request.
- `decide` gains the `subq` preset (14 in all). It is the first SystemOne route
  that takes inline images: up to 4 PNG, JPEG or WebP images, 4 MiB decoded
  each and 8 MiB in total, sent as `{mediaType, base64}`.
- Unchanged: protocol 2, store format 1, and every existing route and default.
  A session that names `subq` needs this version on both ends.

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
`curl` and a CA store; compiling your own Bend programs needs Bend 2.0.36.
