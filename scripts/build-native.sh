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
if [ "$version" != 'bend 2.0.36' ]; then
  printf '%s\n' \
    'Native effect ABI tested with Bend 2.0.36; review before changing compiler versions.' >&2
  exit 1
fi
mkdir -p build
bun scripts/check-native-safety.ts
bend native/main.bend -o build/jev-fabric
