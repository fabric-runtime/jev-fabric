#!/bin/sh
# Build release executables with `bun build --compile` and package each one
# into dist/jev-fabric-<platform>.tar.gz, then write dist/SHA256SUMS.
#
#   sh scripts/build-release.sh                  # every platform
#   sh scripts/build-release.sh linux-x64 ...    # some of them
#
# Platforms: linux-x64, linux-arm64, darwin-arm64, darwin-x64 and
# darwin-universal (the two macOS builds joined by lipo). Bun cross-compiles,
# so one machine builds them all; the macOS ones need macOS (lipo, codesign).
# Each target's flags live in package.json (`build:<platform>`).
set -eu
cd "$(dirname "$0")/.."

platforms=${*:-linux-x64 linux-arm64 darwin-arm64 darwin-x64 darwin-universal}

# Ad hoc signature, as Reflex signs its Bun-compiled daemon. lipo leaves a
# universal file whose slices' signatures no longer cover it, so every macOS
# binary is signed again after it is final.
sign() {
  codesign --force --sign - --entitlements scripts/bun.entitlements "$1"
  codesign --verify --strict "$1"
}

built=' '
build() {
  case $built in *" $1 "*) return 0 ;; esac
  bun run --silent "build:$1" >/dev/null
  case $1 in darwin-*) sign "build/$1/jev-fabric" ;; esac
  built="$built$1 "
}

rm -rf dist
mkdir -p dist
for platform in $platforms; do
  case $platform in
    linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64)
      build "$platform"
      ;;
    darwin-universal)
      build darwin-arm64
      build darwin-x64
      mkdir -p build/darwin-universal
      lipo -create build/darwin-arm64/jev-fabric build/darwin-x64/jev-fabric \
        -output build/darwin-universal/jev-fabric
      sign build/darwin-universal/jev-fabric
      ;;
    *) echo "unknown platform: $platform" >&2; exit 2 ;;
  esac
  sh scripts/package-release.sh "$platform" "build/$platform/jev-fabric"
done

cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum jev-fabric-*.tar.gz > SHA256SUMS
else
  shasum -a 256 jev-fabric-*.tar.gz > SHA256SUMS
fi
cat SHA256SUMS
