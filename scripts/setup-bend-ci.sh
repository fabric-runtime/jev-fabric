#!/bin/sh
set -eu
# CI-only, project-owned installation. Never alters ~/.bend or shell profiles.
# Archive hashes are from https://github.com/bendlang/bend/releases/tag/v2.0.37 for Bend 2.0.37.
[ "${CI:-}" = true ] || { echo 'This setup script is CI-only.' >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64; sum=846d25ccf0c12d5d1e5e648c0b3ba4c8397fdb852812ac00ef8135998f8e194b ;;
  Darwin-x86_64) platform=darwin-x64; sum=93eea3f54b7b91f28ea15a1b9f2d825afa58c1fcd417c11024a62f8c3506b813 ;;
  Linux-aarch64) platform=linux-arm64; sum=b65d452e5c68a4c486e353220d4298ba5d76f535db47109a7d76ffdf72efafb1 ;;
  Linux-x86_64) platform=linux-x64; sum=84c32465a39bc9ac315eade23f470cb8db03153dc860f89564fcfec153c3e445 ;;
  *) echo 'Unsupported native CI platform.' >&2; exit 1 ;;
esac
root="${RUNNER_TEMP:?}/jev-bend-2.0.37"
mkdir -p "$root"
archive="$root/compiler.tar.gz"
trap 'rm -f "$archive"' EXIT
release='https://github.com/bendlang/bend/releases/download/v2.0.37'
curl --proto '=https' --tlsv1.2 -fsSL "$release/bend-2.0.37-$platform.tar.gz" -o "$archive"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$sum" "$archive" | sha256sum -c -
else
  printf '%s  %s\n' "$sum" "$archive" | shasum -a 256 -c -
fi
tar -xzf "$archive" -C "$root"
case "$platform" in
  darwin-*)
    codesign --verify --strict "$root/bend/bin/bend" || {
      echo 'Upstream compiler signature is invalid.' \
        'Use a trusted local build; do not bypass macOS signature checks.' >&2
      exit 1
    }
    ;;
esac
printf '%s\n' "$root/bend/bin" >> "${GITHUB_PATH:?}"
