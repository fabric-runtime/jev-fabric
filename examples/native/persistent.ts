// One persistent child keeps state across three JSONL requests.
// Protocol clients should correlate/validate replies and stay below spool limits.
import {Session, receipt} from 'jev-fabric'

const session = Session.open([
  '/bin/sh',
  '-c',
  `i=0; while IFS= read -r value; do i=$((i+1)); printf '{"count":%s,"value":%s}\\n' "$i" "$value"; done`,
])
for (const value of ['10', '20', '30']) await session.write(`${value}\n`)
console.log(receipt(await session.wait()))
