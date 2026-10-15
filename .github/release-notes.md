Native process orchestration with typed, explicit Jev decisions.

## Changes in 0.8.0

TypeSafe's Jev 1.14 features, in `decide`. TypeSafe calls them experimental
("danger zone"): opt-in, less reliable than text and liable to change, so don't
rely on them for production decisions.

- Images for TypeSafe. Give each image a `ref`, text written into the state,
  instructions or criteria where the image belongs: TypeSafe puts the image
  there. PNG and JPEG. jev-fabric sends them as TypeSafe's referenced `assets`
  with the `TypeSafe-Danger-Zone-Images: true` header. Jev 1.13 and 1.14 both
  take images. Other adapters attach images whole and ignore `ref`.
- `box` questions: one bounding box around what the instructions name in an
  image, answered as `box: {top, bottom, left, right}` (fractions of the image
  from its top-left corner) with an optional `confidence`. TypeSafe only, Jev
  1.14 (`jev-preview` or `jev-1.14.0` until TypeSafe moves `jev-latest`).
  A Box question needs an image; other providers refuse it before any call.
- Long context: `providerOptions: {"longContext": true}` sends
  `TypeSafe-Danger-Zone-Long-Context: true`, raising Jev's limit from 64k tokens
  a request (32k a question) to 262k.
- OpenRouter's default model is now `~typesafe/jev-latest`, which follows the
  newest Jev, for both `decide` and `jev` (was `typesafe/jev-1.13`). OpenCode
  stays on `jev-1.13`: it serves no other Jev yet.
- The TypeScript client types `box` questions and answers and image `ref`s.
- Unchanged: protocol 2, store format 1, the legacy `jev` request schema, and
  every other route and default.

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
