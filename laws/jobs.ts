// Durable jobs (src/jobs/core.ts, the job parts of native/tests/
// policy-proofs.bend and the Jobs.bend ledger): the worker's event ring keeps
// the 64 newest events under sequence numbers never reused; its save cadence
// publishes a pending change within one interval, and its rests between
// ticks never hold a pending change back (and only an announced job, never
// a polling worker, rests until rung); follow never prints an
// event twice and discloses gaps; a terminal receipt finishes a follow; the
// interactive input queue refuses every write once ended and anything past
// its bound, keeps arrival order and drains empty; `list` never probes the
// lease of a job still starting and leaves out what it cannot read; a
// rejected label is never stored. Held to the real functions, and the queue
// to the real host's locked queue files.

import {rmSync} from 'node:fs'
import {join} from 'node:path'
import {bool, fun, min, nat, oneOf, rule, when} from 'gdp-wired'
import * as Core from '../src/jobs/core.ts'
import * as Host from '../src/store/host.ts'
import * as L from '../src/sys/libc.ts'
import type {Agreement, Entry} from './kit.ts'
import {mapsHold, rand} from './kit.ts'

// ---------------------------------------------------------------------------
// The event ring (Core.event): one event a step.

const ringRule = (sloppy = false) =>
  rule('event ring')
    .inputs({tick: nat})
    .state({next: 1, kept: 0})
    .step(({next, kept}) => ({next: next.plus(1), kept: sloppy ? kept.plus(1) : when(kept.lt(Core.ringSize), kept.plus(1), kept)}))
const ringLaws = (r: ReturnType<typeof ringRule>) => ({
  laws: [
    r.law('at most 64 events are retained', ({kept}) => kept.atMost(Core.ringSize)),
    r.law('only events made are retained', ({kept, next}) => kept.plus(1).atMost(next)),
  ],
  steps: [r.stepLaw('a sequence number is never reused: the next one only grows', ({next}, after) => after.next.eq(next.plus(1)))],
})
const ring = ringRule()
// The real ring beside the rule; its retained sequences must also be the newest, contiguous.
const ringHeld = (): Agreement =>
  mapsHold(ring, 200, 0, (s) => {
    s.init({})
    let real: Core.Ring = {next: 1, newest: []}
    for (let i = 0; i < 150; i++) {
      real = Core.event(real, 'x', '{}')
      const failure = s.step({tick: 0}, {next: real.next, kept: real.newest.length}, {})
      if (failure) return failure
      const seqs = real.newest.map((l) => Core.sequence(l)!).reverse()
      if (seqs.some((n, j) => n !== real.next - seqs.length + j)) return `retained sequences ${seqs.join(',')} are not the newest`
    }
    return undefined
  })

// ---------------------------------------------------------------------------
// The save cadence (Core.saveDue, Core.afterTick) and the rest after each
// tick (Core.restFor, Core.restMs): each tick may change the ring and may be
// the finishing one. Ticks are at least Core.tickMs apart, and a pending
// change never waits behind a longer rest, so the tick-counted cadence is a
// bound in time: a change is saved within (saveInterval - 1) * tickMs of the
// tick that saw it. A job whose every reason to look again is announced
// (`announced`: serve's in-process session children, whose output, result
// and stop ring the observer) rests until rung once it is quiet with nothing
// unsaved; `rest` 0 stands for that. A worker process, which polls its stop
// marker and owner, never does.

type CadenceBug = 'late' | 'idle' | 'deaf'
const UNTIL_RUNG = 0
const cadenceRule = (bug?: CadenceBug) =>
  rule('save cadence')
    .inputs({changed: bool, finished: bool, announced: bool})
    .state({unsaved: bool.from(false), age: Core.saveInterval, saved: bool.from(false), quiet: 0, rest: Core.tickMs})
    .flags(({unsaved, changed, finished, age}) => ({due: unsaved.or(changed).and(finished.not()).and(bug === 'late' ? age.gt(Core.saveInterval) : age.atLeast(Core.saveInterval))}))
    .step(({unsaved, changed, announced, age, quiet, due}) => {
      const pending = unsaved.or(changed).and(due.not())
      const still = when(changed, 0, min(quiet.plus(1), Core.quietMax))
      // The bug backs off while a change waits to be saved.
      const short = bug === 'idle' ? still.eq(0) : pending.or(still.eq(0))
      // The deaf bug rests until rung though nothing announces a stop.
      const rung = (bug === 'deaf' ? announced.or(announced.not()) : announced).and(pending.not()).and(still.eq(Core.quietMax))
      return {
        unsaved: pending,
        age: when(due, 1, min(age.plus(1), Core.saveInterval)),
        saved: due,
        quiet: still,
        rest: when(rung, UNTIL_RUNG, when(short, Core.tickMs, when(still.eq(1), 2 * Core.tickMs, Core.restMaxMs))),
      }
    })
const cadenceLaws = (r: ReturnType<typeof cadenceRule>) => ({
  laws: [
    r.law('the ticks since the last save are counted up to one interval', ({age}) => age.atLeast(1).and(age.atMost(Core.saveInterval))),
    r.law('a timed rest is one tick (25 ms) at least and 100 ms at most', ({rest}) => rest.eq(UNTIL_RUNG).or(rest.atLeast(Core.tickMs).and(rest.atMost(Core.restMaxMs)))),
    r.law('a change waiting to be saved rests only one tick, so it is on disk within 75 ms', ({unsaved, rest}) => unsaved.implies(rest.eq(Core.tickMs))),
    r.law('only a quiet job rests until rung', ({rest, quiet}) => rest.eq(UNTIL_RUNG).implies(quiet.eq(Core.quietMax))),
  ],
  steps: [
    r.stepLaw(
      'a pending change one interval old is saved on the next tick that does not finish',
      (_, after) => after.saved.and(after.unsaved.not()).and(after.age.eq(1)),
      ({unsaved, changed, finished, age}) => unsaved.or(changed).and(finished.not()).and(age.atLeast(Core.saveInterval)),
    ),
    r.stepLaw('saves come at most once an interval', ({age}, after) => after.saved.implies(age.atLeast(Core.saveInterval))),
    r.stepLaw('a change is never forgotten unsaved', ({changed}, after) => changed.implies(after.saved.or(after.unsaved))),
    r.stepLaw('a tick that saw output rests one tick: output keeps the 25 ms cadence', ({changed}, after) => changed.implies(after.rest.eq(Core.tickMs))),
    r.stepLaw(
      'a worker that polls its stop marker and owner never rests until rung: a stop is seen within 100 ms',
      (_, after) => after.rest.gt(UNTIL_RUNG),
      ({announced}) => announced.not(),
    ),
  ],
})
const cadence = cadenceRule()
const cadenceHeld = () =>
  cadence.compare(
    {
      init: () => ({unsaved: false as boolean, age: Core.saveInterval as number, saved: false as boolean, quiet: 0 as number, rest: Core.tickMs as number}),
      step: (_, st, {changed, finished, announced}) => {
        const p = {unsaved: st.unsaved as boolean, age: st.age as number, quiet: st.quiet as number}
        const due = Core.saveDue(p, changed, finished)
        const next = Core.afterTick(p, changed, due)
        return {unsaved: next.unsaved, age: next.age, saved: due, quiet: next.quiet, rest: Core.restFor(next, announced) ?? UNTIL_RUNG}
      },
    },
    {trials: 500, depth: 24},
  )

// Long random tick sequences, the real cadence beside the compiled rule.
function cadenceRuns(): Agreement {
  const r = rand(47)
  return mapsHold(cadence, 300, 0, (s) => {
    s.init({})
    let p: Core.Pending = Core.firstPending
    // A run is a worker process's (polled) or an in-process session child's (announced) throughout.
    const announced = r(2) === 0
    for (let i = 0; i < 40; i++) {
      const changed = r(3) === 0
      const finished = r(10) === 0
      const due = Core.saveDue(p, changed, finished)
      p = Core.afterTick(p, changed, due)
      const rest = Core.restFor(p, announced) ?? UNTIL_RUNG
      const failure = s.step({changed, finished, announced}, {unsaved: p.unsaved ? 1 : 0, age: p.age, saved: due ? 1 : 0, quiet: p.quiet, rest}, {})
      if (failure) return failure
    }
    return undefined
  })
}

// ---------------------------------------------------------------------------
// follow (Core.followLine): one retained line a step, with a sequence (`has`)
// or not, from a cursor.

const followRule = (sloppy = false) =>
  rule('follow cursor')
    .params({after: nat})
    .inputs({has: bool, next: nat})
    .state({cursor: ({after}) => after, printed: 0, losses: 0})
    .flags(({has, next, cursor}) => ({fresh: has.and(sloppy ? next.atLeast(cursor) : next.gt(cursor))}))
    .step(({cursor, printed, losses, fresh, next}) => ({
      cursor: when(fresh, next, cursor),
      printed: when(fresh, printed.plus(1), printed),
      losses: when(fresh.and(next.gt(cursor.plus(1))), losses.plus(1), losses),
    }))
const followLaws = (r: ReturnType<typeof followRule>) => ({
  laws: [r.law('the cursor never goes back past where it started', ({cursor, after}) => cursor.atLeast(after))],
  steps: [
    r.stepLaw('followed_event_is_never_repeated: nothing at or before the cursor prints', ({printed}, after) => after.printed.eq(printed), ({next, cursor}) => next.atMost(cursor)),
    r.stepLaw('the cursor never goes back', ({cursor}, after) => after.cursor.atLeast(cursor)),
    r.stepLaw('a gap is disclosed before the event past it', ({losses}, after) => after.losses.eq(losses.plus(1)), ({has, next, cursor}) => has.and(next.gt(cursor.plus(1)))),
  ],
})
const follow = followRule()
const line = (n: number) => `{"sequence":${n},"type":"x","data":{}}`
const followHeld = () =>
  follow.compare(
    {
      init: ({after}) => ({cursor: after, printed: 0, losses: 0}),
      step: (_, st, {has, next}) => {
        const f = Core.followLine(has ? line(next) : 'not an event', st.cursor as number)
        const losses = f.outs.filter((o) => o.startsWith('{"type":"follow.loss"')).length
        return {cursor: f.cursor, printed: (st.printed as number) + f.outs.length - losses, losses: (st.losses as number) + losses}
      },
    },
    {trials: 500, depth: 16, bound: 20, params: (r) => ({after: r(10)})},
  )

const endFun = (sloppy = false) =>
  fun('follow end')
    .inputs({finished: bool, expired: bool})
    .returns(({finished, expired}) => ({
      finish: sloppy ? finished.and(expired.not()) : finished,
      timeout: sloppy ? expired : finished.not().and(expired),
    }))
const endLaws = (f: ReturnType<typeof endFun>) => [
  f.law('receipt_finishes_follow: even at its ceiling', ({finished}) => [finished], ({finish, timeout}) => finish.and(timeout.not())),
  f.law('expired_follow_without_receipt_times_out', ({finished, expired}) => [finished.not(), expired], ({timeout}) => timeout),
]
const endHeld = () =>
  endFun().compare(({finished, expired}) => {
    const d = Core.followDecision(finished, expired)
    return {finish: d === 'finished', timeout: d === 'expired'}
  })

// ---------------------------------------------------------------------------
// The interactive input queue: writes (`close` writes then ends input), and
// the worker's drain. `start` is where the last admitted write landed.

const queueRule = (sloppy = false) =>
  rule('input queue')
    .params({max: nat})
    .inputs({op: oneOf('write', 'close', 'drain'), bytes: nat})
    .state({pending: 0, closed: bool.from(false), start: 0})
    .flags(({op, bytes, pending, closed, max}) => ({
      admitted: op.is('drain').not().and(sloppy ? pending.plus(bytes).atMost(max) : closed.not().and(pending.plus(bytes).atMost(max))),
    }))
    .step(({op, bytes, pending, closed, start, admitted}) => ({
      pending: when(admitted, pending.plus(bytes), when(op.is('drain'), 0, pending)),
      closed: closed.or(admitted.and(op.is('close'))),
      start: when(admitted, pending, start),
    }))
const queueLaws = (r: ReturnType<typeof queueRule>) => ({
  laws: [r.law('the queue never holds more than its bound', ({pending, max}) => pending.atMost(max))],
  steps: [
    r.stepLaw('closed_queue_refuses_writes', ({pending}, after) => after.pending.atMost(pending).and(after.closed), ({closed}) => closed),
    r.stepLaw('queue_keeps_arrival_order: a write lands after everything before it', ({pending, bytes}, after) => after.start.eq(pending).and(after.pending.eq(pending.plus(bytes))), ({admitted}) => admitted),
    r.stepLaw('draining_empties_the_queue', (_, after) => after.pending.eq(0), ({op}) => op.is('drain')),
  ],
})
const queue = queueRule()

const admitFun = (sloppy = false) =>
  fun('queue admit')
    .inputs({closed: bool, total: nat, max: nat})
    .returns(({closed, total, max}) => ({ok: sloppy ? closed.not().and(total.atMost(max.plus(1))) : closed.not().and(total.atMost(max))}))
const admitLaws = (f: ReturnType<typeof admitFun>) => [
  f.law('queue_admits_up_to_its_bound: a queue filled exactly', ({closed, total, max}) => [closed.not(), total.eq(max)], ({ok}) => ok),
  f.law('queue_refuses_past_its_bound: one byte more is refused', ({total, max}) => [total.gt(max)], ({ok}) => ok.not()),
  f.law('closed_queue_refuses_writes: whatever the size', ({closed}) => [closed], ({ok}) => ok.not()),
]
const admitHeld = () =>
  admitFun().compare(({closed, total, max}) => ({ok: Core.admit(closed, total, max)}), {
    trials: 4000,
    draw: (r) => {
      const max = r(3) === 0 ? Core.queueMax : r(100)
      return {closed: r(2) === 0, total: Math.max(0, max + r(5) - 2), max}
    },
  })

// The real host: enqueue and dequeue on a real job directory's locked queue files.
function queueHostHeld(): Agreement {
  const base = join(import.meta.dir, '..', '.tmp', `laws-queue-${process.pid}`)
  const saved = process.env.JEV_FABRIC_HOME
  process.env.JEV_FABRIC_HOME = base
  try {
    const r = rand(53)
    let trial = 0
    return mapsHold(queue, 40, 0, (s) => {
      const max = 1 + r(40)
      s.init({max})
      const made = Host.make(1024)
      if (!made.ok) return `make: ${made.error.code}`
      const id = made.value
      let real = {pending: 0, closed: false, start: 0}
      trial++
      for (let i = 0; i < 24; i++) {
        const op = (['write', 'write', 'close', 'drain'] as const)[r(4)]!
        const bytes = op === 'drain' ? 0 : r(12)
        if (op === 'drain') {
          const got = Host.dequeue(id, Core.queueMax)
          if (!got.ok) return `dequeue: ${got.error.code}`
          const q = Core.taken(got.value)
          if (q.closed !== real.closed || q.text.length !== real.pending) return `dequeue gave ${JSON.stringify(got.value)} with ${real.pending} pending`
          real = {...real, pending: 0}
        } else {
          const got = Host.enqueue(id, 'x'.repeat(bytes), op === 'close', max)
          if (got.ok) real = {pending: Number(got.value), closed: real.closed || op === 'close', start: Number(got.value) - bytes}
          else if (got.error.code !== (real.closed ? L.E.EPIPE : L.E.ENOSPC)) return `enqueue failed with ${got.error.code}`
        }
        const failure = s.step({op, bytes}, {pending: real.pending, closed: real.closed ? 1 : 0, start: real.start}, {})
        if (failure) return `${failure} (trial ${trial})`
      }
      return undefined
    })
  } finally {
    if (saved === undefined) delete process.env.JEV_FABRIC_HOME
    else process.env.JEV_FABRIC_HOME = saved
    rmSync(base, {recursive: true, force: true})
  }
}

// ---------------------------------------------------------------------------
// `list` (Core.classify): what one directory's three files allow.

const READ = ['unreadable', 'empty', 'present'] as const
const classifyFun = (sloppy = false) =>
  fun('list classify')
    .inputs({meta: oneOf(...READ), receipt: oneOf(...READ), ready: oneOf(...READ), session: bool, sessions: bool})
    .returns(({meta, receipt, ready, session, sessions}) => {
      const unreadable = meta.is('unreadable').or(receipt.is('unreadable')).or(ready.is('unreadable'))
      const foreign = meta.is('empty').and(receipt.is('empty')).and(ready.is('empty')).or(session.and(meta.is('present')).and(sessions.not())).or(session.and(meta.is('present')).not().and(sessions))
      const skip = unreadable.or(foreign)
      const probed = skip.not().and(receipt.is('empty'))
      const lease = sloppy ? probed : probed.and(ready.is('present'))
      return {skip, lease, known: skip.not().and(lease.not())}
    })
const classifyLaws = (f: ReturnType<typeof classifyFun>) => [
  f.law('a job still starting is never lease-probed', ({ready}) => [ready.is('empty')], ({lease}) => lease.not()),
  f.law('any unreadable or unsafe job file leaves the directory out', ({meta, receipt, ready}) => [meta.is('unreadable').or(receipt.is('unreadable')).or(ready.is('unreadable'))], ({skip}) => skip),
  f.law("the store's list leaves out session children", ({session, meta, sessions}) => [session, meta.is('present'), sessions.not()], ({skip}) => skip),
  f.law('a terminal receipt is reported without a probe', ({receipt}) => [receipt.is('present')], ({lease}) => lease.not()),
]
const classifyHeld = () => {
  const bad = {ok: false as const, error: {code: 1, message: 'x'}}
  const text = (kind: (typeof READ)[number], present: string) => (kind === 'unreadable' ? bad : {ok: true as const, value: kind === 'empty' ? '' : present})
  const a = classifyFun().compare(({meta, receipt, ready, session, sessions}) => {
    const m = Core.meta('', '1', session ? 'session' : 'durable', false)
    const p = Core.classify('a'.repeat(32), text(meta, m), text(receipt, '{"state":"exited","exitCode":0}'), text(ready, 'ready'), sessions)
    return {skip: p.p === 'skip', lease: p.p === 'lease', known: p.p === 'known'}
  })
  return {...a, exhaustive: true}
}

// ---------------------------------------------------------------------------
// Labels (Core.labelChecked).

const labelFun = (sloppy = false) =>
  fun('label')
    .inputs({length: nat, printable: bool})
    .returns(({length, printable}) => ({ok: length.atLeast(1).and(length.atMost(sloppy ? Core.labelMax + 1 : Core.labelMax)).and(printable)}))
const labelLaws = (f: ReturnType<typeof labelFun>) => [
  f.law('rejected_label_is_never_stored: an unprintable one', ({printable}) => [printable.not()], ({ok}) => ok.not()),
  f.law('nor one past 120 characters, nor an empty one', ({length}) => [length.gt(Core.labelMax).or(length.eq(0))], ({ok}) => ok.not()),
]
function labelHeld(): Agreement {
  const r = rand(61)
  const chars = ['a', 'é', '🙂', ' ', '\t', '\n', '\u007f', '\u0085', ' ', ' ', 'Z', ' ']
  let checked = 0
  for (let t = 0; t < 4000; t++) {
    const n = [0, 1, 119, 120, 121, r(130)][r(6)]!
    const text = Array.from({length: n}, () => (r(8) === 0 ? chars[r(chars.length)] : chars[r(2)])).join('')
    const codes = [...text].map((c) => c.codePointAt(0)!)
    const want = labelFun().run({length: codes.length, printable: codes.every(Core.printable)})
    if (Core.labelChecked(text).ok !== want.ok) return {checked, failure: `labelChecked(${JSON.stringify(text)})`}
    checked++
  }
  return {checked}
}

// ---------------------------------------------------------------------------
// Which session children start (Core.reachesWorker): 0.8.1 passed a session
// child's command in its worker's argv, whose every entry the supervisor
// bounds; serve's in-process supervision refuses exactly what that refused.

const reachFun = (sloppy = false) =>
  fun('session child reaches its worker')
    .inputs({longest: nat, nul: bool})
    .returns(({longest, nul}) => ({starts: longest.atMost(sloppy ? Core.workerArgMax + 1 : Core.workerArgMax).and(nul.not())}))
const reachLaws = (f: ReturnType<typeof reachFun>) => [
  f.law('a command with an entry past 4096 bytes never starts', ({longest}) => [longest.gt(Core.workerArgMax)], ({starts}) => starts.not()),
  f.law('nor one with a NUL in an entry', ({nul}) => [nul], ({starts}) => starts.not()),
  f.law('every other command starts', ({longest, nul}) => [longest.atMost(Core.workerArgMax), nul.not()], ({starts}) => starts),
]
function reachHeld(): Agreement {
  const r = rand(67)
  const chars = ['a', 'é', '€', '🙂']
  let checked = 0
  for (let t = 0; t < 3000; t++) {
    const argv = Array.from({length: 1 + r(4)}, () => {
      const c = chars[r(chars.length)]!
      const per = Buffer.byteLength(c)
      const n = Math.floor([0, 1, 4095, 4096, 4097, r(5000)][r(6)]! / per)
      return c.repeat(n) + (r(40) === 0 ? '\0' : '')
    })
    const longest = Math.max(...argv.map((a) => Buffer.byteLength(a)))
    const want = reachFun().run({longest, nul: argv.some((a) => a.includes('\0'))})
    if (Core.reachesWorker(argv) !== want.starts) return {checked, failure: `reachesWorker of entries ${argv.map((a) => Buffer.byteLength(a)).join(',')}`}
    checked++
  }
  return {checked}
}

export const entries: Entry[] = [
  {
    area: 'jobs',
    rule: ring,
    ...ringLaws(ring),
    from: 'any',
    broken: [{what: 'a ring that keeps every event', rule: ringRule(true), ...ringLaws(ringRule(true))}],
    held: [{against: 'Core.event (the real ring, 150 events a run)', run: ringHeld}],
  },
  {
    area: 'jobs',
    rule: cadence,
    ...cadenceLaws(cadence),
    from: 'any',
    broken: [
      {what: 'a cadence that waits past its interval', rule: cadenceRule('late'), ...cadenceLaws(cadenceRule('late'))},
      {what: 'a worker that rests longer while a change waits to be saved', rule: cadenceRule('idle'), ...cadenceLaws(cadenceRule('idle'))},
      {what: 'a worker process that rests until rung, though nothing rings it for a stop', rule: cadenceRule('deaf'), ...cadenceLaws(cadenceRule('deaf'))},
    ],
    held: [
      {against: 'Core.saveDue, Core.afterTick and Core.restFor (rule.compare)', run: cadenceHeld},
      {against: 'Core.saveDue, Core.afterTick and Core.restFor over 40-tick runs, polled and announced', run: cadenceRuns},
    ],
  },
  {
    area: 'jobs',
    rule: follow,
    ...followLaws(follow),
    from: 'any',
    broken: [{what: 'a follow that prints the event at its cursor again', rule: followRule(true), ...followLaws(followRule(true))}],
    held: [{against: 'Core.followLine (rule.compare)', run: followHeld}],
  },
  {
    area: 'jobs',
    decisions: endLaws(endFun()),
    broken: [{what: 'a follow that times out with its receipt in hand', decision: endLaws(endFun(true))[0]!}],
    held: [{against: 'Core.followDecision on every combination', run: () => ({...endHeld(), exhaustive: true}), exhaustive: true}],
  },
  {
    area: 'jobs',
    rule: queue,
    ...queueLaws(queue),
    from: 'any',
    broken: [{what: 'a queue that takes writes after input ended', rule: queueRule(true), ...queueLaws(queueRule(true))}],
    held: [{against: 'Host.enqueue and Host.dequeue on real queue files', run: queueHostHeld}],
  },
  {
    area: 'jobs',
    decisions: admitLaws(admitFun()),
    broken: [{what: 'an admit one byte past its bound', decision: admitLaws(admitFun(true))[1]!}],
    held: [{against: 'Core.admit at its bound (fun.compare)', run: admitHeld}],
  },
  {
    area: 'jobs',
    decisions: classifyLaws(classifyFun()),
    broken: [{what: 'list probing the lease of a job still starting', decision: classifyLaws(classifyFun(true))[0]!}],
    held: [{against: 'Core.classify on every combination', run: classifyHeld, exhaustive: true}],
  },
  {
    area: 'jobs',
    decisions: labelLaws(labelFun()),
    broken: [{what: 'a 121-character label accepted', decision: labelLaws(labelFun(true))[1]!}],
    held: [{against: 'Core.labelChecked on random text', run: labelHeld}],
  },
  {
    area: 'jobs',
    decisions: reachLaws(reachFun()),
    broken: [{what: 'a 4097-byte entry let through', decision: reachLaws(reachFun(true))[0]!}],
    held: [{against: 'Core.reachesWorker on random argv around the bound', run: reachHeld}],
  },
]
