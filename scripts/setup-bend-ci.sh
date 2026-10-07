#!/bin/sh
set -eu
# CI-only, project-owned installation. Never alters ~/.bend or shell profiles.
# Archive hashes are from https://github.com/bendlang/bend/releases/tag/v2.0.36 for Bend 2.0.36.
[ "${CI:-}" = true ] || { echo 'This setup script is CI-only.' >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64; sum=2876687ceb0aba836abc98b3f62c8fc9fb612d124ae2af6814d5ec937760878d ;;
  Darwin-x86_64) platform=darwin-x64; sum=925bb306c60260e1cdde56c2b8e4ba0e1eb4cbc88a76372cc0bb389a172dccdf ;;
  Linux-aarch64) platform=linux-arm64; sum=a14a311e39bad45f9669d4eab39d156b578c945f13a2b7bae20d9c23567a4664 ;;
  Linux-x86_64) platform=linux-x64; sum=02089dc0eed0fd5fd6d73c74cc9cffcb2c6638dd3b02ae83f7b8cc57fbe381ba ;;
  *) echo 'Unsupported native CI platform.' >&2; exit 1 ;;
esac
root="${RUNNER_TEMP:?}/jev-bend-2.0.36"
mkdir -p "$root"
archive="$root/compiler.tar.gz"
trap 'rm -f "$archive"' EXIT
release='https://github.com/bendlang/bend/releases/download/v2.0.36'
curl --proto '=https' --tlsv1.2 -fsSL "$release/bend-2.0.36-$platform.tar.gz" -o "$archive"
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
