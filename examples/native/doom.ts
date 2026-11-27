// Jev plays ViZDoom through a persistent bridge process. The bridge renders the
// structured game state as a Jev request line; this orchestrator makes the typed
// decision and writes back the chosen action.
//
// Opt-in network demo: each decision is one billed Jev call (at most 400 here).
// DOOM_PYTHON selects an interpreter with `vizdoom` installed; see examples/doom/.
//   jev-fabric -- run examples/native/doom.ts
import {FabricError, Jev, Session} from 'jev-fabric'

const bridge = ['/bin/sh', '-c', 'exec "${DOOM_PYTHON:-python3}" "${DOOM_BRIDGE:-examples/doom/bridge.py}"']

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
  for (let fuel = 400; fuel > 0; fuel--) {
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
    const started = performance.now()
    let value
    try {
      value = (await jev.evaluate(message.request)).value
    } catch (e) {
      return `Jev failed: ${(e as Error).message}`
    }
    const ms = Math.round(performance.now() - started)
    const action = value.answers?.action
    if (typeof action?.choice !== 'string') return 'Jev answer had no action'
    console.log(`tick ${shown(message.tick)} -> ${action.choice} confidence=${shown(action.confidence)} ${ms}ms`)
    stats.decisions++
    stats.totalMs += ms
    stats.maxMs = Math.max(stats.maxMs, ms)
    try {
      await session.write(`${action.choice}\n`)
    } catch {
      return 'bridge write failed'
    }
  }
  return 'decision fuel exhausted'
}

const jev = Jev.connect({maxEvaluations: 400, maxTokens: 2000000})
const session = Session.open(bridge)
console.log(await play(jev, session))
console.log(`jev decisions=${stats.decisions} mean_ms=${Math.floor(stats.totalMs / Math.max(1, stats.decisions))} max_ms=${stats.maxMs}`)
await session.wait().catch(() => {})
console.log('bridge exited')
