// The storage format marker (src/store/core.ts and host.ts, the store parts
// of native/tests/policy-proofs.bend): a home written by a newer jev-fabric
// is refused and never adopted or rewritten, whatever the verb; the current
// format is used as is; an unmarked home is adopted by a writing verb (or the
// call that created it) and left as it was by a read. Held to StoreCore on
// every combination, and to the real host on real roots.

import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {bool, fun, nat, oneOf} from 'gdp-wired'
import * as Host from '../src/store/host.ts'
import * as Store from '../src/store/core.ts'
import type {Agreement, Entry} from './kit.ts'
import {rand} from './kit.ts'

const MARKERS = ['none', 'unreadable', 'zero', 'current', 'newer'] as const

// StoreCore.decide over Host's answer: what the home's marker says (none at
// all, unreadable, store 0, store 1 or a newer store), whether the verb
// writes, and whether this call just created the root.
const decideFun = (sloppy = false) =>
  fun('store decision')
    .inputs({marker: oneOf(...MARKERS), mutating: bool, created: bool})
    .returns(({marker, mutating, created}) => {
      const none = marker.is('none')
      const refuse = marker.is('unreadable').or(marker.is('zero')).or(marker.is('newer'))
      return {
        adopt: sloppy ? none.and(mutating.or(created)).or(marker.is('newer').and(mutating)) : none.and(mutating.or(created)),
        refuse: sloppy ? refuse.and(mutating.not().or(marker.is('newer').not())) : refuse,
      }
    })
const decideLaws = (f: ReturnType<typeof decideFun>) => [
  f.law('newer_store_is_refused: by every verb, never adopted', ({marker}) => [marker.is('newer')], ({refuse, adopt}) => refuse.and(adopt.not())),
  f.law('current_store_is_accepted: used as is', ({marker}) => [marker.is('current')], ({refuse, adopt}) => refuse.not().and(adopt.not())),
  f.law('writer_adopts_unmarked_home', ({marker, mutating}) => [marker.is('none'), mutating], ({adopt}) => adopt),
  f.law('reader_leaves_old_home_unmarked', ({marker, mutating, created}) => [marker.is('none'), mutating.not(), created.not()], ({adopt, refuse}) => adopt.not().and(refuse.not())),
  f.law('a marked home is never adopted (never rewritten)', ({marker}) => [marker.is('none').not()], ({adopt}) => adopt.not()),
]
const decide = decideLaws(decideFun())

const TEXT: Record<(typeof MARKERS)[number], string[]> = {
  none: [''],
  // A leading zero is not JSON: {"store":0001} is unreadable, not store 1.
  unreadable: ['not json', '{"store":1.0}', '{"store":"1"}', '{"other":1}', '{"store":1,"store":1}', '[1]', '{"store":-1}', '{"store":0001}'],
  zero: ['{"store":0}', ' {"store":0} '],
  current: [Store.marker, '{"store":1}', ' {"store":1,"note":"x"} ', '{"note":"x","store":1}'],
  newer: ['{"store":2}\n', '{"store":3,"note":"later"}', '{"store":281474976710655}'],
}
const asDecided = (d: Store.Decision) => ({adopt: d.d === 'adopt', refuse: d.d === 'refuse'})

// Every combination, each with every marker text of its kind.
function decideHeld(): Agreement {
  let checked = 0
  for (const variant of [0, 1, 2, 3, 4, 5, 6]) {
    const a = decideFun().compare(({marker, mutating, created}) => {
      const texts = TEXT[marker]
      return asDecided(Store.decide((created ? '+' : '=') + texts[variant % texts.length]!, mutating))
    })
    if (a.failure) return a
    checked += a.checked
  }
  return {checked, exhaustive: true}
}

// StoreCore.versioned over every store number: 0 unreadable, 1 accepted, any later one refused as newer.
const versionFun = (sloppy = false) =>
  fun('store version')
    .inputs({n: nat})
    .returns(({n}) => ({accept: n.eq(1), refuse: sloppy ? n.eq(0) : n.eq(1).not()}))
const versionLaws = (f: ReturnType<typeof versionFun>) => [
  f.law('newer_store_is_refused: every store number past 1', ({n}) => [n.atLeast(2)], ({refuse, accept}) => refuse.and(accept.not())),
  f.law('store 0 is not a format any release wrote', ({n}) => [n.eq(0)], ({refuse}) => refuse),
]
const versionHeld = () =>
  versionFun().compare(({n}) => ({accept: Store.versioned(n, String(n)).d === 'accept', refuse: Store.versioned(n, String(n)).d === 'refuse'}), {
    trials: 3000,
    draw: (r) => ({n: [0, 1, 2, 3, 2 ** 32, 281474976710655, r(10 ** 9)][r(7)]!}),
  })

// The real host on real roots: a refused home's marker is never touched by
// any check, read or writing; an unmarked one gains the marker exactly when
// the verb writes or the call created the root.
function hostHeld(): Agreement {
  const base = join(import.meta.dir, '..', '.tmp', `laws-store-${process.pid}`)
  const saved = process.env.JEV_FABRIC_HOME
  const r = rand(7)
  let checked = 0
  try {
    for (let t = 0; t < 60; t++) {
      const kind = MARKERS[r(MARKERS.length)]!
      const text = TEXT[kind][r(TEXT[kind].length)]!
      const mutating = r(2) === 0
      const fresh = kind === 'none' && r(2) === 0
      const home = join(base, String(t))
      if (!fresh) {
        mkdirSync(home, {recursive: true, mode: 0o700})
        if (kind !== 'none') writeFileSync(join(home, '.jev-fabric-store.json'), text, {mode: 0o600})
      }
      process.env.JEV_FABRIC_HOME = home
      const got = Host.storeAttempt(mutating)
      const want = decideFun().run({marker: kind, mutating, created: fresh})
      const marker = join(home, '.jev-fabric-store.json')
      const after = existsSync(marker) ? readFileSync(marker, 'utf8') : null
      const fail = (what: string) => ({checked, failure: `${kind} ${JSON.stringify(text)} mutating=${mutating} fresh=${fresh}: ${what}`})
      if (got.ok === want.refuse) return fail(`answered ${JSON.stringify(got)}`)
      if (!got.ok && got.error.code !== 22) return fail(`refused with ${got.error.code}`)
      if (want.adopt ? after !== Store.marker : after !== (kind === 'none' ? null : text)) return fail(`marker is now ${JSON.stringify(after)}`)
      checked++
    }
    return {checked}
  } finally {
    if (saved === undefined) delete process.env.JEV_FABRIC_HOME
    else process.env.JEV_FABRIC_HOME = saved
    rmSync(base, {recursive: true, force: true})
  }
}

export const entries: Entry[] = [
  {
    area: 'store',
    decisions: decide,
    broken: [{what: 'a writing verb that adopts (rewrites) a newer home', decision: decideLaws(decideFun(true))[0]!}],
    held: [
      {against: 'StoreCore.decide on every combination and marker text', run: decideHeld, exhaustive: true},
      {against: 'Host.storeAttempt on real roots (the marker untouched unless adopted)', run: hostHeld},
    ],
  },
  {
    area: 'store',
    decisions: versionLaws(versionFun()),
    broken: [{what: 'store numbers past 1 accepted', decision: versionLaws(versionFun(true))[0]!}],
    held: [{against: 'StoreCore.versioned (fun.compare)', run: versionHeld}],
  },
]
