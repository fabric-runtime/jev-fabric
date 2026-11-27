#!/bin/sh
# Package a built executable into dist/jev-fabric-<platform>.tar.gz.
#
#   sh scripts/package-release.sh <platform> <path-to-binary>
#
# The archive holds one top-level jev-fabric/ directory: the executable, the
# Python and TypeScript `serve` clients, the examples (TypeScript programs for
# `jev-fabric -- run`), the agent skill, the docs, VERSION and BUILD-PROVENANCE.
# The library `run` programs import is inside the executable.
set -eu

[ $# -eq 2 ] || { echo 'usage: package-release.sh <platform> <binary>' >&2; exit 2; }
platform=$1
binary=$2
cd "$(dirname "$0")/.."

version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json)
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "unexpected package.json version: $version" >&2; exit 1 ;;
esac
# A binary this machine can run must report the same version (cross-compiled
# ones are checked on their own platform by the release smoke test).
if reported=$("$binary" -- --version 2>/dev/null); then
  case "$reported" in
    "$version"-native*) ;;
    *) echo "binary reports $reported, package.json says $version" >&2; exit 1 ;;
  esac
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/jev-fabric"
mkdir -p "$root/bin" "$root/examples"

cp "$binary" "$root/bin/jev-fabric"
chmod 755 "$root/bin/jev-fabric"
cp -R examples/native examples/doom examples/browser examples/clients "$root/examples/"
cp examples/decision-profiles.json "$root/examples/"
cp -R docs "$root/docs"
# Clients ship without their tests.
mkdir -p "$root/clients/python" "$root/clients/typescript"
cp clients/python/jev_fabric.py "$root/clients/python/"
cp clients/typescript/jev-fabric.ts "$root/clients/typescript/"
cp clients/README.md "$root/clients/"
cp -R skills "$root/skills"
cp README.md LICENSE "$root/"
find "$root" -name __pycache__ -type d -prune -exec rm -rf {} +
printf 'v%s\n' "$version" > "$root/VERSION"

if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$root/bin/jev-fabric" | cut -d' ' -f1)
else
  digest=$(shasum -a 256 "$root/bin/jev-fabric" | cut -d' ' -f1)
fi
commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
[ -z "$(git status --porcelain 2>/dev/null)" ] || commit="$commit (uncommitted changes)"
{
  printf 'jev-fabric %s for %s\n' "$version" "$platform"
  printf 'source: https://github.com/fabric-runtime/jev-fabric commit %s\n' "$commit"
  printf 'compiled: bun build --compile --minify --bytecode --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/main.ts (package.json build:%s)\n' "$platform"
  printf 'bun: %s\n' "$(bun --version 2>/dev/null || echo unknown)"
  printf 'built: %s on %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(uname -sm)"
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf 'workflow: %s/%s/actions/runs/%s\n' "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_REPOSITORY:-}" "$GITHUB_RUN_ID"
  fi
  printf 'sha256 bin/jev-fabric: %s\n' "$digest"
} > "$root/BUILD-PROVENANCE"

mkdir -p dist
# macOS's bsdtar would add extended attributes that GNU tar warns about.
set --
if tar --version 2>/dev/null | grep -q bsdtar; then set -- --no-mac-metadata --no-xattrs; fi
COPYFILE_DISABLE=1 tar "$@" -czf "dist/jev-fabric-$platform.tar.gz" -C "$stage" jev-fabric
echo "dist/jev-fabric-$platform.tar.gz (v$version)"
