#!/bin/sh
# Install jev-fabric from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/fabric-runtime/jev-fabric/main/install.sh | sh
#
# Environment:
#   JEV_FABRIC_VERSION  release tag to install, e.g. v0.1.0 (default: latest)
#   JEV_FABRIC_PREFIX   install prefix (default: ~/.local)
#   JEV_FABRIC_ARCHIVE_DIR  install from a local directory holding the release
#                       archive and SHA256SUMS instead of downloading (offline use)
#
# Layout:
#   $PREFIX/bin/jev-fabric                      -> ../share/jev-fabric/current/bin/jev-fabric
#   $PREFIX/share/jev-fabric/<version>/         binary, serve clients, examples, docs, skill
#   $PREFIX/share/jev-fabric/current            -> <version>
set -eu

repo='fabric-runtime/jev-fabric'
prefix="${JEV_FABRIC_PREFIX:-$HOME/.local}"
version="${JEV_FABRIC_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'jev-fabric install: %s\n' "$*" >&2; exit 1; }

# Archives to try, in order: the first one SHA256SUMS lists is installed.
# macOS releases from 0.9.0 on also ship one archive per architecture; older
# ones have only darwin-universal.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platforms='darwin-arm64 darwin-universal' ;;
  Darwin-x86_64)
    # A shell under Rosetta reports x86_64 on Apple silicon.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
      platforms='darwin-arm64 darwin-universal'
    else
      platforms='darwin-x64 darwin-universal'
    fi
    ;;
  Darwin-*) platforms='darwin-universal' ;;
  Linux-x86_64 | Linux-amd64) platforms=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) platforms=linux-arm64 ;;
  *) fail "unsupported platform $(uname -s) $(uname -m); build from source instead" ;;
esac

[ -n "${JEV_FABRIC_ARCHIVE_DIR:-}" ] || command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum -c -; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 -c -; }
else
  fail 'sha256sum or shasum is required to verify the download'
fi

if [ "$version" = latest ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -n "${JEV_FABRIC_ARCHIVE_DIR:-}" ]; then
  cp "$JEV_FABRIC_ARCHIVE_DIR/SHA256SUMS" "$work/" \
    || fail "missing SHA256SUMS in $JEV_FABRIC_ARCHIVE_DIR"
else
  curl --proto '=https' --tlsv1.2 -fsSL "$base/SHA256SUMS" -o "$work/SHA256SUMS" \
    || fail "could not download $base/SHA256SUMS"
fi

asset=''
for platform in $platforms; do
  expected="$(grep " \*\{0,1\}jev-fabric-$platform\.tar\.gz\$" "$work/SHA256SUMS" || true)"
  if [ -n "$expected" ]; then
    asset="jev-fabric-$platform.tar.gz"
    break
  fi
done
[ -n "$asset" ] || fail "SHA256SUMS has no archive for this platform (looked for: $platforms)"

if [ -n "${JEV_FABRIC_ARCHIVE_DIR:-}" ]; then
  say "Installing $asset from $JEV_FABRIC_ARCHIVE_DIR..."
  cp "$JEV_FABRIC_ARCHIVE_DIR/$asset" "$work/" \
    || fail "missing $asset in $JEV_FABRIC_ARCHIVE_DIR"
else
  say "Downloading $asset ($version)..."
  curl --proto '=https' --tlsv1.2 -fsSL "$base/$asset" -o "$work/$asset" \
    || fail "could not download $base/$asset"
fi

(cd "$work" && printf '%s\n' "$expected" | checksum >/dev/null) \
  || fail 'checksum mismatch; refusing to install'

tar -xzf "$work/$asset" -C "$work"
[ -f "$work/jev-fabric/VERSION" ] || fail 'archive is missing VERSION'
installed="$(cat "$work/jev-fabric/VERSION")"

share="$prefix/share/jev-fabric"
mkdir -p "$share" "$prefix/bin"
rm -rf "${share:?}/$installed"
mv "$work/jev-fabric" "$share/$installed"
ln -sfn "$installed" "$share/current"
ln -sf "$share/current/bin/jev-fabric" "$prefix/bin/jev-fabric"

"$prefix/bin/jev-fabric" -- --version >/dev/null 2>&1 \
  || fail "installed binary does not run on this system: $prefix/bin/jev-fabric"

say "Installed jev-fabric $installed to $prefix/bin/jev-fabric"
say "Examples and docs: $share/current/examples, $share/current/docs"
say "Python/TypeScript clients: $share/current/clients"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) say "Add $prefix/bin to your PATH, e.g.: export PATH=\"$prefix/bin:\$PATH\"" ;;
esac
say ''
say 'Next:'
say '  jev-fabric -- --help'
say '  jev-fabric -- update                     # later: reinstall the latest release'
say '  npx skills add fabric-runtime/jev-fabric   # teach your coding agent'
