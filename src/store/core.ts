// Pure storage-format policy (native/StoreCore.bend). A storage home records
// its format in `.jev-fabric-store.json`; src/store/host.ts reads and writes
// it, and this decides whether this binary may use the home. Within one store
// version changes are additive, so any binary whose version is at least the
// home's may use it: store 1 is this binary's, a newer one is refused (and
// never rewritten), and store 0 is not a format any release wrote.

import * as Codec from '../codec/codec.ts'
import {readNat} from '../time/core.ts'

/** The store format this binary reads and writes. */
export const version = 1
/** The marker written into a new home, or adopted by a home that lacks one. */
export const marker = '{"store":1}\n'
/** The exit code of a refused home, as for other unsafe job access. */
export const refusedCode = 22

export type Decision = {d: 'accept'} | {d: 'adopt'} | {d: 'refuse'; message: string}

export const accept: Decision = {d: 'accept'}
export const adopt: Decision = {d: 'adopt'}
export const unreadable: Decision = {d: 'refuse', message: 'storage home marker .jev-fabric-store.json is not readable by this jev-fabric'}
export const newer = (shown: string): Decision => ({
  d: 'refuse',
  message: `storage home uses store format ${shown}; this jev-fabric supports store format 1 (upgrade jev-fabric to use it)`,
})

/** StoreCore.versioned: 0 unreadable, 1 accepted, anything above refused as newer. */
export const versioned = (found: number, shown: string): Decision => (found === 0 ? unreadable : found === 1 ? accept : newer(shown))

/** StoreCore.number: the store field's lexeme read as a natural, else unreadable. */
export function number(lex: string): Decision {
  const n = readNat(lex)
  return n === null ? unreadable : versioned(n, lex)
}

/** StoreCore.parsed: a strict JSON document whose "store" member is a number. */
export function parsed(text: string): Decision {
  const doc = Codec.read(text)
  if (!doc.ok) return unreadable
  const store = Codec.field(doc.value, 'store')
  return store?.t === 'num' ? number(store.lex) : unreadable
}

/**
 * StoreCore.missing: a home without a marker is adopted when this call
 * created it, or when the verb writes to it anyway; a read-only verb leaves
 * an old home as it found it.
 */
export const missing = (mutating: boolean, created: boolean): Decision => (mutating || created ? adopt : accept)

export const marked = (text: string, created: boolean, mutating: boolean): Decision => (text === '' ? missing(mutating, created) : parsed(text))

/** StoreCore.decide over Host's answer: "+" when it just created the root, else "=", then the marker. */
export function decide(answer: string, mutating: boolean): Decision {
  if (answer === '') return missing(mutating, false)
  return marked(answer.slice(1), answer[0] === '+', mutating)
}
