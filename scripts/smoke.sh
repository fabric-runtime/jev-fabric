#!/bin/sh
# Smoke-test a jev-fabric executable on the machine it was built for.
#
#   sh scripts/smoke.sh <binary> [version]
#
# Offline: no Jev call. Storage goes to a temporary JEV_FABRIC_HOME.
set -eu
[ $# -ge 1 ] || { echo 'usage: smoke.sh <binary> [version]' >&2; exit 2; }
cd "$(dirname "$0")/.."
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
home=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$home"' EXIT
export JEV_FABRIC_HOME="$home/store"
set -x

if [ -n "${2:-}" ]; then
  "$bin" -- --version | grep -q "^${2#v}-native"
fi
"$bin" -- --help | grep -q 'usage: jev-fabric'
"$bin" -- exec /bin/echo ok | grep -q '"stdout":"ok\\u000a"'
"$bin" exec /bin/echo ok | grep -q '"stdout":"ok\\u000a"'
"$bin" -- validate examples/native/request.json >/dev/null
id=$("$bin" -- start /bin/sh -c 'echo ready' | sed 's/.*"id":"\([0-9a-f]*\)".*/\1/')
"$bin" -- wait "$id" | grep -q '"state":"exited"'
printf '{"id":1,"op":"exec","argv":["/bin/echo","ok"]}\n' | "$bin" -- serve | grep -q '"id":1,"ok":true'
# `run` with the Bun inside the executable and the library it carries.
"$bin" -- run examples/native/pipeline.ts | grep -q 'HELLO JEV-FABRIC'
"$bin" -- exec --cwd /tmp /bin/pwd | grep -q '"stdout":"/\(private/\)\{0,1\}tmp'
