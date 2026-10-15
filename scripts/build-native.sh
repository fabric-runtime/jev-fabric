#!/bin/sh
set -eu
export BEND_NO_TELEMETRY=1
# Bend's code generator runs on Bun's JavaScriptCore, whose heap otherwise grows
# to ~12 GB on this program and pages to swap on a 16 GB Mac. Capping the RAM
# JSC assumes keeps it in memory; the emitted C is byte-identical.
export BUN_JSC_forceRAMSize=${BUN_JSC_forceRAMSize:-4294967296}
cd "$(dirname "$0")/.."
version=$(bend version) || {
  printf '%s\n' 'Bend could not run; verify the compiler installation.' >&2
  exit 1
}
if [ "$version" != 'bend 2.0.37' ]; then
  printf '%s\n' \
    'Native effect ABI tested with Bend 2.0.37; review before changing compiler versions.' >&2
  exit 1
fi
mkdir -p build
if [ "${JEV_FABRIC_BEND:-local}" != modal ]; then
  bun scripts/check-native-safety.ts
  bend native/main.bend -o build/jev-fabric
  exit 0
fi

# JEV_FABRIC_BEND=modal: Bend generates each target's C on Modal (see
# scripts/modal-bend.py) while the safety gate runs here, and local clang
# compiles it. Targets land in build/modal-out first and are installed only
# when both succeed. JEV_FABRIC_MODAL_TARGETS adds <file.bend>=<binary> pairs.
command -v modal >/dev/null 2>&1 || {
  printf '%s\n' 'JEV_FABRIC_BEND=modal needs the Modal CLI (`uv tool install modal`, then `modal setup`).' >&2
  exit 1
}
rm -rf build/modal-out
mkdir -p build/modal-out
staged=''
installs=''
for pair in native/main.bend=build/jev-fabric ${JEV_FABRIC_MODAL_TARGETS:-}; do
  src=${pair%%=*}
  out=${pair#*=}
  stage=build/modal-out/$(basename "$out")
  staged="$staged $src=$stage"
  installs="$installs $stage=$out"
done
modal run scripts/modal-bend.py --targets "$staged" &
remote=$!
trap 'kill "$remote" 2>/dev/null || true' EXIT
bun scripts/check-native-safety.ts
wait "$remote"
trap - EXIT
for pair in $installs; do
  mv "${pair%%=*}" "${pair#*=}"
done
