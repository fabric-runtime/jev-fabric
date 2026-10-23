#!/bin/sh
set -eu
# CI-only, project-owned installation. Never alters ~/.bend or shell profiles.
# Archive hashes are from https://github.com/bendlang/bend/releases/tag/v2.0.38 for Bend 2.0.38.
[ "${CI:-}" = true ] || { echo 'This setup script is CI-only.' >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64; sum=9d5331d01e82dac40dd012953e78221f533f7df7ad7e16b07f1f7bd0dcd088dd ;;
  Darwin-x86_64) platform=darwin-x64; sum=870be3b91290e14259dba432788c71d7190d8984f8606255e5333c3a03896d5a ;;
  Linux-aarch64) platform=linux-arm64; sum=1f7c6e74a6ef7412cf08eee0e4d45fe5960f89d66fdaca2466f6a4856f0d400a ;;
  Linux-x86_64) platform=linux-x64; sum=f19d088b079c9e1a8834ecd153b7d58c11a5f8f9ab1bdb78dbc96a6bf49aaa81 ;;
  *) echo 'Unsupported native CI platform.' >&2; exit 1 ;;
esac
root="${RUNNER_TEMP:?}/jev-bend-2.0.38"
mkdir -p "$root"
archive="$root/compiler.tar.gz"
trap 'rm -f "$archive"' EXIT
release='https://github.com/bendlang/bend/releases/download/v2.0.38'
curl --proto '=https' --tlsv1.2 -fsSL "$release/bend-2.0.38-$platform.tar.gz" -o "$archive"
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
