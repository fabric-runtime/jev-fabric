Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.6.0

- Add lossless `decide` results across native decision, gateway, local llama.cpp,
  and explicitly opted-in generated-decision protocols. Preserve raw evidence,
  distributions, refusals, provenance and unknown usage rather than inventing it.
- Support inline images on verified image-capable routes; reject unsupported
  combinations before credentials or dispatch.
- Add portable named profiles, immutable TypeScript/Python target handles,
  offline `resolve-decision` preflight and CLI target-selection flags.
- Keep model switches within the same session and shared evaluation/token budget.
  Explicit targets do not inherit another provider's ambient model or endpoint.
- Add checked universal decision-policy laws, retain foreign/serialization/host
  boundary tests, and consolidate pure-policy fixture compilation.
- Preserve legacy `jev` behavior, protocol 2 and store format 1. New operations
  are advertised through capability negotiation. Requires Bend 2.0.36 to compile.

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
