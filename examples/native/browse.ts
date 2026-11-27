// Jev drives a browser through a persistent bridge process (examples/browser/).
// Each step the bridge renders the page's guarded candidates as one Jev request
// with speculative operation/target/text questions; this orchestrator makes the
// typed decision and writes the whole validated evaluation back.
//
// Opt-in network demo: each step is one billed Jev call (at most 40 here).
// Node 24+ runs the TypeScript bridge; BROWSER_HARNESS_SDK points at browser-harness-js.
//   jev-fabric -- run examples/native/browse.ts
import {FabricError, Jev, Session} from 'jev-fabric'

const bridge = ['/bin/sh', '-c', 'exec "${BROWSE_NODE:-node}" "${BROWSE_BRIDGE:-examples/browser/bridge.ts}"']

/** The next complete line from `offset`, polling every millisecond for up to 30 s. */
async function nextLine(session: Session, offset: number): Promise<{line: string; next: number}> {
  let pending = Buffer.alloc(0)
  for (let fuel = 30000; fuel > 0; fuel--) {
    pending = Buffer.concat([pending, session.readStdout(offset + pending.length)])
    const end = pending.indexOf(10)
    if (end >= 0) return {line: pending.subarray(0, end).toString('utf8'), next: offset + end + 1}
    await Bun.sleep(1)
  }
  throw new FabricError(124, 'bridge produced no line')
}

const stats = {decisions: 0, totalMs: 0, maxMs: 0}
const shown = (value: unknown) => (value === undefined ? '?' : JSON.stringify(value))

async function play(jev: Jev, session: Session): Promise<string> {
  let offset = 0
  for (let fuel = 40; fuel > 0; fuel--) {
    let message
    try {
      const {line, next} = await nextLine(session, offset)
      offset = next
      message = JSON.parse(line)
    } catch (e) {
      return e instanceof SyntaxError ? `bridge sent invalid JSON: ${e.message}` : `bridge read failed: ${(e as Error).message}`
    }
    if (message.done !== undefined) return `done ${shown(message.done)}`
    if (message.request === undefined) return `bridge: ${shown(message)}`
    console.log(`  ${shown(message.log)}`)
    const started = performance.now()
    let answer
    try {
      answer = await jev.evaluate(message.request)
    } catch (e) {
      return `Jev failed: ${(e as Error).message}`
    }
    const ms = Math.round(performance.now() - started)
    const action = answer.value.answers?.operation
    if (typeof action?.choice !== 'string') return 'Jev answer had no operation'
    console.log(`step ${shown(message.step)} -> ${action.choice} confidence=${shown(action.confidence)} ${ms}ms`)
    stats.decisions++
    stats.totalMs += ms
    stats.maxMs = Math.max(stats.maxMs, ms)
    try {
      await session.write(`${answer.json}\n`)
    } catch {
      return 'bridge write failed'
    }
  }
  return 'decision fuel exhausted'
}

const jev = Jev.connect({maxEvaluations: 40, maxTokens: 1000000})
const session = Session.open(bridge)
console.log(await play(jev, session))
console.log(`jev decisions=${stats.decisions} mean_ms=${Math.floor(stats.totalMs / Math.max(1, stats.decisions))} max_ms=${stats.maxMs}`)
await session.wait().catch(() => {})
console.log('bridge exited')
