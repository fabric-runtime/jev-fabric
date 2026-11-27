// serve (src/serve/core.ts and src/serve/hub.ts, ServeCore.bend's claims and
// the session ledger Serve.bend kept): every accepted request is answered
// exactly once, and before the session exits; no request is answered twice;
// nothing is accepted once the session is ending; a connection runs at most
// 16 session children and queues at most 64 requests per child; the one Jev
// client is held by one evaluation at a time, in arrival order, so a session
// has one budget; ids are echoed verbatim; argv is bounded; and no CLI child
// or session child is given more time than the session has left less the
// receipt grace; and, with session children supervised in process, every
// child's process group is reaped at most once, a child leaves supervision
// only once its group is reaped, and so no child survives the session's
// conclusion (none is left for the watchdog). Each rule is held to the real
// code: the hub's bookkeeping functions, the real JevSession and ServeCore's
// own decisions.

import {bool, forall, fun, min, nat, oneOf, rule, when} from 'gdp-wired'
import * as Codec from '../src/codec/codec.ts'
import type {Json} from '../src/codec/json.ts'
import type {Client} from '../src/jev/jev.ts'
import {JevSession} from '../src/jev/session.ts'
import * as Core from '../src/serve/core.ts'
import * as Hub from '../src/serve/hub.ts'
import type {Agreement, Entry} from './kit.ts'
import {mapsHold, rand} from './kit.ts'

const G = Core.GRACE

// ---------------------------------------------------------------------------
// The hub: one event a step.
//   line    a request line arrives (accepted only while the session serves)
//   answer  a request's answer is written
//   spawn   a session child `c` starts (a fresh directory)
//   launch  child `c`'s process group starts (listed with the watchdog)
//   reap    child `c`'s group is reaped
//   finish  child `c`'s receipt is published
//   exit    child `c`'s supervision ends
//   queue   a write, close or stop is queued for child `c`
//   fed     one queued for child `c` is applied
//   end     the session begins to end (end of input, deadline, overflow)
//   settle  the session concludes if it can

const KINDS = ['line', 'answer', 'spawn', 'launch', 'reap', 'finish', 'exit', 'queue', 'fed', 'end', 'settle'] as const
type Kind = (typeof KINDS)[number]
type HubBugs = {twice?: boolean; overChildren?: boolean; overPending?: boolean; early?: boolean; late?: boolean; reapTwice?: boolean; orphan?: boolean}

const hubRule = (bug: HubBugs = {}) =>
  rule('serve hub')
    .inputs({kind: oneOf(...KINDS), c: nat})
    .state({open: 0, accepted: 0, answered: 0, running: 0, ending: bool.from(false), concluded: bool.from(false)})
    .maps({Live: 0, Run: 0, Pending: 0, Listed: 0, Reaps: 0})
    .flags(({kind, c, open, running, ending, Live, Run, Pending, Listed, Reaps}) => ({
      accepting: kind.is('line').and(bug.late ? ending.or(ending.not()) : ending.not()),
      answering: kind.is('answer').and(bug.twice ? open.atLeast(0) : open.gt(0)),
      spawning: kind.is('spawn').and(ending.not()).and(Live.at(c).eq(0)).and(Run.at(c).eq(0)).and(bug.overChildren ? running.atLeast(0) : running.lt(Core.CHILDREN_MAX)),
      launching: kind.is('launch').and(Live.at(c).eq(1)).and(Listed.at(c).eq(0)).and(Reaps.at(c).eq(0)),
      reaping: kind.is('reap').and(bug.reapTwice ? Listed.at(c).eq(1).or(Reaps.at(c).eq(1)) : Listed.at(c).eq(1)),
      finishing: kind.is('finish').or(kind.is('exit').and(bug.orphan ? Listed.at(c).atLeast(0) : Listed.at(c).eq(0))).and(Run.at(c).gt(0)),
      exiting: kind.is('exit').and(bug.orphan ? Listed.at(c).atLeast(0) : Listed.at(c).eq(0)),
      queueing: kind.is('queue').and(bug.overPending ? Pending.at(c).atMost(Core.PENDING_MAX) : Pending.at(c).lt(Core.PENDING_MAX)),
      feeding: kind.is('fed').and(Pending.at(c).gt(0)),
      settling: kind.is('settle').and(ending).and(bug.early ? open.atLeast(0) : open.eq(0)).and(Live.sum().eq(0)).and(Pending.sum().eq(0)),
    }))
    .step(({kind, c, open, accepted, answered, running, ending, concluded, Live, Run, Pending, Listed, Reaps, accepting, answering, spawning, launching, reaping, finishing, exiting, queueing, feeding, settling}) => ({
      open: when(accepting, open.plus(1), when(answering, open.minus(1), open)),
      accepted: when(accepting, accepted.plus(1), accepted),
      answered: when(answering, answered.plus(1), answered),
      running: when(spawning, running.plus(1), when(finishing, running.minus(1), running)),
      ending: ending.or(kind.is('end')),
      concluded: concluded.or(settling),
      Live: Live.set(c, when(spawning, 1, when(exiting, 0, Live.at(c)))),
      Run: Run.set(c, when(spawning, 1, when(finishing, 0, Run.at(c)))),
      Pending: Pending.set(c, when(queueing, Pending.at(c).plus(1), when(feeding, Pending.at(c).minus(1), Pending.at(c)))),
      Listed: Listed.set(c, when(launching, 1, when(reaping, 0, Listed.at(c)))),
      Reaps: Reaps.set(c, when(reaping, Reaps.at(c).plus(1), Reaps.at(c))),
    }))

const hubLaws = (r: ReturnType<typeof hubRule>) => ({
  laws: [
    r.law('no request is answered twice: answers and open requests add up to the requests accepted', ({answered, open, accepted}) => answered.plus(open).eq(accepted)),
    r.law('a connection runs at most 16 session children', ({running}) => running.atMost(Core.CHILDREN_MAX)),
    r.law('a session child queues at most 64 writes, closes and stops', ({Pending}) => forall((k) => Pending.at(k).atMost(Core.PENDING_MAX))),
    r.law('the session concludes only once it is ending', ({concluded, ending}) => concluded.implies(ending)),
    r.law('every accepted request is answered before the session exits', ({concluded, answered, accepted}) => concluded.implies(answered.eq(accepted))),
    r.law("a child's group is listed until it is reaped, and reaped at most once", ({Listed, Reaps}) => forall((k) => Listed.at(k).plus(Reaps.at(k)).atMost(1))),
    r.law('a child leaves supervision only once its group is reaped', ({Live, Listed}) => forall((k) => Live.at(k).eq(0).implies(Listed.at(k).eq(0)))),
    r.law('no session child is still supervised once the session has concluded', ({concluded, Live}) => forall((k) => concluded.implies(Live.at(k).eq(0)))),
    r.law('no child survives the conclusion: every group started was reaped exactly once, none is left for the watchdog', ({concluded, Listed}) => forall((k) => concluded.implies(Listed.at(k).eq(0)))),
  ],
  steps: [
    r.stepLaw('nothing is accepted once the session is ending', ({accepted}, after) => after.accepted.eq(accepted), ({ending}) => ending),
    r.stepLaw('an answer is written only for an open request', ({answered, open}, after) => after.answered.gt(answered).implies(open.gt(0))),
    r.stepLaw('the first ending wins: an ending is never undone', ({ending}, after) => ending.implies(after.ending)),
  ],
})
const hubR = hubRule()

/** The real hub (src/serve/hub.ts) beside the rule, over random runs; children are `d<c>`. */
const hubHeld = (): Agreement => {
  const r = rand(71)
  let full = 0
  let crowded = 0
  const a = mapsHold(hubR, 400, 0, (s) => {
    s.init({})
    const h = Hub.hub()
    const spawned: number[] = []
    let fresh = 0
    // Some runs press on the bounds: mostly spawns, or mostly queueing for one child.
    const press = r(3)
    for (let i = 0; i < 120; i++) {
      const drawn: Kind = press === 1 && r(4) > 0 ? 'spawn' : press === 2 && r(5) > 0 ? (r(8) === 0 ? 'fed' : 'queue') : KINDS[r(KINDS.length)]!
      // Requests for a child are made only for one this connection has.
      const kind: Kind = spawned.length === 0 && ['launch', 'reap', 'finish', 'exit', 'queue', 'fed'].includes(drawn) ? 'line' : drawn
      // A spawn takes a fresh directory; the rest address one already made (or none yet).
      const c = kind === 'spawn' ? fresh : spawned.length === 0 ? 0 : press === 2 ? spawned[0]! : spawned[r(spawned.length)]!
      const dir = `d${c}`
      if (kind === 'line') {
        if (Hub.serving(h)) Hub.accept(h)
        else if (!throws(() => Hub.accept(h))) return 'an accept after the ending was taken'
      } else if (kind === 'answer') {
        if (h.open > 0) Hub.answer(h)
        else if (!throws(() => Hub.answer(h))) return 'an answer without an open request was taken'
      } else if (kind === 'spawn') {
        if (Hub.room(h) && Hub.serving(h)) {
          Hub.starting(h, dir)
          spawned.push(c)
          fresh++
        } else if (!throws(() => Hub.starting(h, dir))) return 'a spawn past the bound was taken'
      } else if (kind === 'launch') {
        const x = h.children.get(dir)!
        if (x.live && x.group === 'none') Hub.spawned(h, dir)
        else if (!throws(() => Hub.spawned(h, dir))) return 'a second start of a group (or one after supervision) was taken'
      } else if (kind === 'reap') {
        if (h.children.get(dir)!.group === 'listed') Hub.reaped(h, dir)
        else if (!throws(() => Hub.reaped(h, dir))) return 'a reap of a group not running was taken'
      } else if (kind === 'finish') Hub.finished(h, dir)
      else if (kind === 'exit') {
        if (h.children.get(dir)!.group !== 'listed') Hub.exited(h, dir)
        else if (!throws(() => Hub.exited(h, dir))) return 'a child left supervision with its group unreaped'
      }
      else if (kind === 'queue') Hub.queue(h, dir)
      else if (kind === 'fed') Hub.fed(h, dir)
      else if (kind === 'end') Hub.end(h, 0, '')
      else Hub.conclude(h)
      const cells = (f: (c: Hub.Child) => number) => new Map(spawned.map((k) => [k, f(h.children.get(`d${k}`)!)]))
      const failure = s.step(
        {kind, c},
        {
          open: h.open,
          accepted: h.accepted,
          answered: h.answered,
          running: Hub.running(h),
          ending: h.ending ? 1 : 0,
          concluded: h.concluded ? 1 : 0,
        },
        {
          Live: cells((x) => (x.live ? 1 : 0)),
          Run: cells((x) => (x.live && !x.finished ? 1 : 0)),
          Pending: cells((x) => x.pending),
          Listed: cells((x) => (x.group === 'listed' ? 1 : 0)),
          Reaps: cells((x) => (x.group === 'reaped' ? 1 : 0)),
        },
      )
      if (failure) return failure
      // The watchdog's list is exactly the groups the hub still supervises.
      if (Hub.listed(h).length !== spawned.filter((k) => h.children.get(`d${k}`)!.group === 'listed').length) return 'Hub.listed disagrees with the children'
      if (h.concluded && Hub.listed(h).length !== 0) return 'concluded with a group still listed'
      if (Hub.running(h) === Core.CHILDREN_MAX) crowded++
      if ([...h.children.values()].some((x) => x.pending === Core.PENDING_MAX)) full++
    }
    return undefined
  })
  if (!a.failure && (full === 0 || crowded === 0)) return {...a, failure: `the runs never reached a bound (16 children: ${crowded} steps, 64 queued: ${full} steps)`}
  return a
}

function throws(f: () => void): boolean {
  try {
    f()
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// The session's one Jev client (JevSession): evaluations hold it one at a
// time, in arrival order; each gets the client the one before handed back.

const jevRule = (race = false) =>
  rule('serve jev client')
    .inputs({kind: oneOf('arrive', 'return')})
    .state({holding: 0, waiting: 0, arrived: 0, returned: 0})
    .flags(({kind, holding}) => ({
      starts: kind.is('arrive').and(race ? holding.atLeast(0) : holding.eq(0)),
      queues: kind.is('arrive').and(race ? holding.lt(0) : holding.gt(0)),
      returns: kind.is('return').and(holding.gt(0)),
    }))
    .step(({holding, waiting, arrived, returned, starts, queues, returns}) => ({
      holding: when(starts, holding.plus(1), when(returns.and(waiting.eq(0)), holding.minus(1), holding)),
      waiting: when(queues, waiting.plus(1), when(returns.and(waiting.gt(0)), waiting.minus(1), waiting)),
      arrived: when(starts.or(queues), arrived.plus(1), arrived),
      returned: when(returns, returned.plus(1), returned),
    }))
const jevLaws = (r: ReturnType<typeof jevRule>) => ({
  laws: [
    r.law('one evaluation holds the session client at a time', ({holding}) => holding.atMost(1)),
    r.law('no evaluation waits while the client is free', ({holding, waiting}) => holding.eq(0).implies(waiting.eq(0))),
    r.law('every evaluation that arrived runs once, in turn', ({arrived, returned, holding, waiting}) => arrived.eq(returned.plus(holding).plus(waiting))),
  ],
  steps: [r.stepLaw('a request arriving while the client is held waits its turn', ({holding}, after) => after.holding.eq(holding), ({kind, holding}) => kind.is('arrive').and(holding.gt(0)))],
})
const jevR = jevRule()

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** The real JevSession beside the rule: random arrivals and returns, each body checking it got the client the last one returned. */
async function jevHeldRun(): Promise<Agreement> {
  const g = jevR.compiled()
  const r = rand(73)
  let checked = 0
  for (let t = 0; t < 150; t++) {
    let version = 0
    const session = new JevSession({version} as unknown as Client)
    let holding = 0
    let started = 0
    let arrived = 0
    let returned = 0
    let latest = 0
    let failure: string | undefined
    const release: (() => void)[] = []
    const ps = jevR.encodeParams({})
    let st = g.init(ps)
    const trace: string[] = []
    for (let i = 0; i < 40 && !failure; i++) {
      const kind = r(2) === 0 ? 'arrive' : 'return'
      trace.push(kind)
      if (kind === 'arrive') {
        arrived++
        void session.use(async (c) => {
          const got = (c as unknown as {version: number}).version
          if (got !== latest) failure = `an evaluation got client ${got}, not the latest ${latest}`
          holding++
          started++
          if (holding > 1) failure = 'two evaluations held the client at once'
          await new Promise<void>((done) => release.push(done))
          holding--
          returned++
          latest = ++version
          return [{version: latest} as unknown as Client, null]
        })
      } else if (release.length > 0) release.shift()!()
      await flush()
      st = g.step(ps, st, jevR.encodeInput({kind}))
      checked++
      const want = jevR.decode(st) as Record<string, number>
      const real = {holding, waiting: arrived - started, arrived, returned}
      for (const [k, v] of Object.entries(real)) if (want[k] !== v) failure ??= `${k} is ${want[k]} in the rule, ${v} in JevSession, after ${trace.join(',')}`
    }
    while (release.length > 0) {
      release.shift()!()
      await flush()
    }
    if (failure) return {checked, failure}
  }
  return {checked}
}
const jevHeldResult = await jevHeldRun()

// ---------------------------------------------------------------------------
// Ids (ServeCore.id, id_valid): a string or number is echoed verbatim;
// anything else is answered as null; a string past 128 characters is refused.

const ID_KINDS = ['str', 'num', 'other', 'absent'] as const
const idFun = (sloppy = false) =>
  fun('id echo')
    .inputs({kind: oneOf(...ID_KINDS), length: nat})
    .returns(({kind, length}) => ({
      echoed: kind.is('str').or(kind.is('num')),
      refused: kind.is('other').or(kind.is('str').and(length.gt(sloppy ? 129 : 128))),
    }))
const idLaws = (f: ReturnType<typeof idFun>) => [
  f.law('a string or number id is echoed verbatim', ({kind}) => [kind.is('str').or(kind.is('num'))], ({echoed}) => echoed),
  f.law('any other id, or none, is answered as null', ({kind}) => [kind.is('other').or(kind.is('absent'))], ({echoed}) => echoed.not()),
  f.law('an id of more than 128 characters is refused', ({kind, length}) => [kind.is('str'), length.gt(128)], ({refused}) => refused),
  f.law('an id of at most 128 characters is never refused for its id', ({kind, length}) => [kind.is('str'), length.atMost(128)], ({refused}) => refused.not()),
]
const idValue = (kind: (typeof ID_KINDS)[number], length: number, variant: number): Json | undefined => {
  if (kind === 'absent') return undefined
  if (kind === 'str') return Codec.jstr(['x', 'é', '🙂'][variant % 3]!.repeat(length))
  if (kind === 'num') return Codec.jnum(['0', '-3', '1.50', '1e3', String(length)][variant % 5]!)
  return [Codec.NULL, Codec.jbool(true), Codec.jarr([]), Codec.jobj([['a', Codec.jnum('1')]])][variant % 4]!
}
function idHeld(): Agreement {
  let checked = 0
  for (const kind of ID_KINDS)
    for (let length = 0; length <= 140; length++)
      for (let variant = 0; variant < 4; variant++) {
        const id = idValue(kind, length, variant)
        const value = Codec.jobj([...(id === undefined ? [] : ([['id', id]] as [string, Json][])), ['op', Codec.jstr('capabilities')]])
        const want = idFun().run({kind, length}) as {echoed: boolean; refused: boolean}
        const echo = Core.id(value)
        const echoed = id !== undefined && echo.t !== 'null' && echo === id
        if (!echoed && echo.t !== 'null') return {checked, failure: `id ${JSON.stringify(id)} echoed as something else`}
        const refused = !Core.request(value).ok
        if (echoed !== want.echoed || refused !== want.refused) return {checked, failure: `${kind} id of ${length}: echoed ${echoed}, refused ${refused}`}
        checked++
      }
  return {checked, exhaustive: true}
}

// ---------------------------------------------------------------------------
// argv (ServeCore.argv): 1..57 literal entries, the first naming a command.

const argvFun = (sloppy = false) =>
  fun('argv bounds')
    .inputs({count: nat, empty: bool})
    .returns(({count, empty}) => ({accepted: count.atLeast(1).and(count.atMost(sloppy ? Core.ARGV_MAX + 1 : Core.ARGV_MAX)).and(empty.not())}))
const argvLaws = (f: ReturnType<typeof argvFun>) => [
  f.law('a command with no argv is refused', ({count}) => [count.eq(0)], ({accepted}) => accepted.not()),
  f.law('more than 57 entries are refused (64 per child, less the CLI prefix)', ({count}) => [count.gt(Core.ARGV_MAX)], ({accepted}) => accepted.not()),
  f.law('an empty command name is refused', ({empty}) => [empty], ({accepted}) => accepted.not()),
  f.law('1..57 entries naming a command are accepted', ({count, empty}) => [count.atLeast(1), count.atMost(Core.ARGV_MAX), empty.not()], ({accepted}) => accepted),
]
function argvHeld(): Agreement {
  let checked = 0
  for (let count = 0; count <= 64; count++)
    for (const empty of [false, true]) {
      if (count === 0 && empty) continue
      const argv = Array.from({length: count}, (_, i) => Codec.jstr(i === 0 && empty ? '' : 'x'))
      const value = Codec.jobj([['op', Codec.jstr('exec')], ['argv', Codec.jarr(argv)]])
      const want = argvFun().run({count, empty}) as {accepted: boolean}
      if (Core.request(value).ok !== want.accepted) return {checked, failure: `argv of ${count} (empty first: ${empty})`}
      checked++
    }
  return {checked, exhaustive: true}
}

// ---------------------------------------------------------------------------
// The session deadline (ServeCore.inner, timed, control, child_lifetime).

const cutFun = (sloppy = false) =>
  fun('deadline cut')
    .inputs({requested: nat, remaining: nat})
    .returns(({requested, remaining}) => {
      const left = sloppy ? remaining : when(remaining.gt(G), remaining.minus(G), 0)
      const ms = min(requested, left)
      return {ms, expired: ms.eq(0), timeout: ms.plus(G)}
    })
const cutLaws = (f: ReturnType<typeof cutFun>) => [
  f.law('a child step and its receipt grace fit in what the session has left', (_i, {expired}) => [expired.not()], ({timeout}, {remaining}) => timeout.atMost(remaining)),
  f.law('a request is never cut while the session has time for it', ({requested, remaining}) => [requested.plus(G).atMost(remaining)], ({ms}, {requested}) => ms.eq(requested)),
  f.law('with no time left past the grace, no child is started', ({requested, remaining}) => [requested.gt(0), remaining.atMost(G)], ({expired}) => expired),
]
function cutHeld(): Agreement {
  let checked = 0
  const values = [0, 1, 2, 1000, 1999, 2000, 2001, 2500, 3999, 4000, 30000, 3599999, 3600000]
  for (const requested of values.filter((v) => v > 0))
    for (const remaining of values) {
      const want = cutFun().run({requested, remaining}) as {ms: number; expired: boolean; timeout: number}
      const ms = Core.inner(requested, 30000, remaining)
      const call = Core.timed(['x'], '', ms, false)
      const got = {ms, expired: !call.ok, timeout: call.ok ? call.value.timeout : ms + G}
      if (got.ms !== want.ms || got.expired !== want.expired || got.timeout !== want.timeout) return {checked, failure: `inner(${requested}, ${remaining}) = ${JSON.stringify(got)}`}
      checked++
    }
  return {checked, exhaustive: true}
}

const controlFun = (sloppy = false) =>
  fun('control step')
    .inputs({remaining: nat})
    .returns(({remaining}) => ({expired: remaining.atMost(G), timeout: sloppy ? remaining : min(remaining, Core.CONTROL_MAX)}))
const controlLaws = (f: ReturnType<typeof controlFun>) => [
  f.law('status, events, stop, list and a start handshake wait at most 15 s', ({remaining}) => [remaining.atLeast(0)], ({timeout}) => timeout.atMost(Core.CONTROL_MAX)),
  f.law('and never past the session', ({remaining}) => [remaining.atLeast(0)], ({timeout}, {remaining}) => timeout.atMost(remaining)),
]
function controlHeld(): Agreement {
  let checked = 0
  for (const remaining of [0, 1, 1999, 2000, 2001, 14999, 15000, 15001, 3600000]) {
    const want = controlFun().run({remaining}) as {expired: boolean; timeout: number}
    const call = Core.control(['x'], remaining, false)
    if (call.ok === want.expired || (call.ok && call.value.timeout !== want.timeout)) return {checked, failure: `control(${remaining})`}
    checked++
  }
  return {checked, exhaustive: true}
}

const lifetimeFun = (sloppy = false) =>
  fun('session child lifetime')
    .inputs({given: bool, requested: nat, left: nat})
    .returns(({given, requested, left}) => ({lifetime: when(given, sloppy ? requested : min(requested, left), left)}))
const lifetimeLaws = (f: ReturnType<typeof lifetimeFun>) => [
  f.law('a session child never outlives its connection less the receipt grace', ({left}) => [left.atLeast(0)], ({lifetime}, {left}) => lifetime.atMost(left)),
  f.law('a child without its own timeoutMs lives for the rest of the connection', ({given}) => [given.not()], ({lifetime}, {left}) => lifetime.eq(left)),
]
function lifetimeHeld(): Agreement {
  let checked = 0
  for (const given of [false, true])
    for (const requested of [1, 300, 5000, 86400000])
      for (const left of [1, 299, 300, 50000, 86398000]) {
        const want = lifetimeFun().run({given, requested, left}) as {lifetime: number}
        if (Core.childLifetime(given ? requested : null, left) !== want.lifetime) return {checked, failure: `childLifetime(${given ? requested : null}, ${left})`}
        checked++
      }
  return {checked, exhaustive: true}
}

export const entries: Entry[] = [
  {
    area: 'serve',
    rule: hubR,
    ...hubLaws(hubR),
    broken: [
      {what: 'a hub that writes an answer with no open request', rule: hubRule({twice: true}), ...hubLaws(hubRule({twice: true}))},
      {what: 'a hub that spawns a 17th child', rule: hubRule({overChildren: true}), ...hubLaws(hubRule({overChildren: true}))},
      {what: 'a hub that queues a 65th write', rule: hubRule({overPending: true}), ...hubLaws(hubRule({overPending: true}))},
      {what: 'a hub that exits with a request in flight', rule: hubRule({early: true}), ...hubLaws(hubRule({early: true}))},
      {what: 'a hub that accepts lines after its ending', rule: hubRule({late: true}), ...hubLaws(hubRule({late: true}))},
      {what: 'a hub that reaps a group twice', rule: hubRule({reapTwice: true}), ...hubLaws(hubRule({reapTwice: true}))},
      {what: 'a hub that lets a child go with its group unreaped (and concludes over it)', rule: hubRule({orphan: true}), ...hubLaws(hubRule({orphan: true}))},
    ],
    held: [{against: 'src/serve/hub.ts (accept, answer, starting, spawned, reaped, finished, exited, queue, fed, end, conclude) over 120-event runs, some pressing on the bounds', run: hubHeld}],
  },
  {
    area: 'serve',
    rule: jevR,
    ...jevLaws(jevR),
    broken: [{what: 'a session that lets a second evaluation take the client', rule: jevRule(true), ...jevLaws(jevRule(true))}],
    held: [{against: 'the real JevSession (each evaluation handed the client the last returned)', run: () => jevHeldResult}],
  },
  {
    area: 'serve',
    decisions: idLaws(idFun()),
    broken: [{what: 'a 129-character id accepted', decision: idLaws(idFun(true))[2]!}],
    held: [{against: 'Core.id and Core.request on every id kind and length 0..140', run: idHeld, exhaustive: true}],
  },
  {
    area: 'serve',
    decisions: argvLaws(argvFun()),
    broken: [{what: 'a 58-entry argv accepted', decision: argvLaws(argvFun(true))[1]!}],
    held: [{against: 'Core.request on argv of 0..64 entries', run: argvHeld, exhaustive: true}],
  },
  {
    area: 'serve',
    decisions: cutLaws(cutFun()),
    broken: [{what: 'a cut that forgets the receipt grace', decision: cutLaws(cutFun(true))[0]!}],
    held: [{against: 'Core.inner and Core.timed', run: cutHeld, exhaustive: true}],
  },
  {
    area: 'serve',
    decisions: controlLaws(controlFun()),
    broken: [{what: 'a control step with no 15 s bound', decision: controlLaws(controlFun(true))[0]!}],
    held: [{against: 'Core.control', run: controlHeld, exhaustive: true}],
  },
  {
    area: 'serve',
    decisions: lifetimeLaws(lifetimeFun()),
    broken: [{what: 'a session child that keeps its own timeoutMs past the connection', decision: lifetimeLaws(lifetimeFun(true))[0]!}],
    held: [{against: 'Core.childLifetime', run: lifetimeHeld, exhaustive: true}],
  },
]
