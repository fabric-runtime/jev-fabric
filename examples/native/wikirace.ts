// Wikirace: follow article links from a start page to a target page. Jev choice
// supports up to 255 options, so larger link sets run as a tournament: one
// choice per chunk of 255, then a final choice among the chunk winners.
//
// Opt-in network demo: reads Wikipedia with curl + jq and makes billed Jev calls
// (at most 120). Usage: jev-fabric -- run examples/native/wikirace.ts <from> <to>
import {FabricError, Jev, capture} from 'jev-fabric'

const FETCH = [
  'set -eu',
  "curl -fsS --max-time 15 --get https://en.wikipedia.org/w/api.php -A 'jev-fabric-wikirace-demo/0.1' " +
    '--data-urlencode action=parse --data-urlencode format=json --data-urlencode formatversion=2 ' +
    '--data-urlencode prop=links --data-urlencode redirects=1 --data-urlencode "page=$1" ' +
    "| jq -r '[.parse.links[] | select(.ns == 0 and .exists) | .title] | unique | .[]'",
].join('\n')

/** The article's existing main-namespace links, through a bounded byte-exact capture. */
async function links(title: string): Promise<string[]> {
  const r = await capture(['/bin/sh', '-c', FETCH, 'sh', title], {timeoutMs: 20000, limit: 1048576})
  if (r.code !== 0 || r.timedOut || r.cancelled || r.stdoutCut || r.stderrCut) throw new FabricError(r.code, 'link fetch failed')
  return new TextDecoder('utf-8', {fatal: true}).decode(r.stdout).split('\n').filter((line) => line !== '')
}

const shown = (value: unknown) => (value === undefined ? '?' : JSON.stringify(value))

async function ask(jev: Jev, target: string, context: string, options: string[]): Promise<string> {
  const started = performance.now()
  const {value} = await jev.evaluate({
    state: context,
    questions: {
      next: {
        type: 'choice',
        instructions: `Which of these Wikipedia links is most likely to reach the article "${target}" in the fewest further clicks? Pick the target itself if present; otherwise prefer a closely related or broad hub article.`,
        criteria: Object.fromEntries(options.map((title) => [title, null])),
      },
    },
  })
  const next = value.answers?.next
  console.log(`    jev: ${shown(next?.choice)} of ${options.length} (confidence ${shown(next?.confidence)}, ${Math.round(performance.now() - started)}ms)`)
  if (next === undefined) throw new FabricError(22, 'Jev answer had no choice')
  if (typeof next.choice !== 'string') throw new FabricError(22, 'Jev choice was not text')
  return next.choice
}

async function choose(jev: Jev, target: string, context: string, options: string[]): Promise<string> {
  const winners: string[] = []
  for (let i = 0; i < options.length; i += 255) winners.push(await ask(jev, target, context, options.slice(i, i + 255)))
  return winners.length === 1 ? winners[0]! : ask(jev, target, context, winners)
}

async function race(jev: Jev, target: string, path: string[]): Promise<string> {
  for (let clicks = 12; clicks > 0; clicks--) {
    const current = path[path.length - 1]!
    let titles
    try {
      titles = await links(current)
    } catch (e) {
      return `could not read "${current}": ${(e as Error).message}`
    }
    if (titles.includes(target)) {
      path.push(target)
      return 'reached'
    }
    const options = titles.filter((title) => !path.includes(title))
    if (!options.length) return 'dead end: every link was already visited'
    console.log(`  ${current}: ${options.length} unvisited links`)
    const context = `Wikipedia race. Target article: "${target}". Current article: "${current}". Path so far: ${path.join(' -> ')}.`
    try {
      path.push(await choose(jev, target, context, options))
    } catch (e) {
      return `stopped: ${(e as Error).message}`
    }
  }
  return 'click limit reached'
}

const [source, target] = process.argv.slice(2)
if (source === undefined || target === undefined) {
  console.error('usage: wikirace -- <start article> <target article>')
  process.exit(2)
}
const jev = Jev.connect({maxEvaluations: 120, maxTokens: 2000000})
const started = performance.now()
console.log(`race: ${source} -> ${target}`)
const path = [source]
const outcome = await race(jev, target, path)
console.log(`${outcome} in ${path.length - 1} clicks, ${Math.round(performance.now() - started)}ms`)
console.log(path.join(' -> '))
