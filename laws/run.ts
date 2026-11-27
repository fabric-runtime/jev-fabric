// Every law of jev-fabric's pure core, proven with gdp-wired, each with the
// bug it rules out refused and its rule held to the real code. `bun run laws`
// prints the table and ALL LAWS PROVEN only when every row holds.
//
// Each laws/<area>.ts exports `entries: Entry[]`; this picks them all up.

import {readdirSync} from 'node:fs'
import type {Entry, Row} from './kit.ts'
import {run} from './kit.ts'

export async function allRows(): Promise<Row[]> {
  const dir = new URL('.', import.meta.url).pathname
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !['kit.ts', 'run.ts'].includes(f)).sort()
  const entries: Entry[] = []
  for (const f of files) entries.push(...((await import(`./${f}`)).entries as Entry[]))
  return entries.flatMap(run)
}

if (import.meta.main) {
  const t0 = performance.now()
  const rows = await allRows()
  let area = ''
  for (const r of rows) {
    if (r.area !== area) {
      area = r.area
      console.log(`\n${area}`)
    }
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.law}\n         ${r.how}: ${r.verdict}`)
  }
  const bad = rows.filter((r) => !r.ok)
  console.log(`\n${rows.length} rows in ${Math.round(performance.now() - t0)} ms`)
  console.log(bad.length === 0 ? 'ALL LAWS PROVEN' : `${bad.length} ROWS FAILED`)
  process.exit(bad.length === 0 ? 0 : 1)
}
