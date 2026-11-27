// Test fixtures that need a process of their own (native/tests/io.bend,
// fail-fast.bend, session.bend and timers.bend): cancellation is sticky and
// process-wide, and exit reaps every owned group, so these run as
// `bun probe.test-main.ts <mode> [args...]` and print what the test checks.

import * as Process from './process.ts'
import {show} from './report.ts'
import * as Session from './session.ts'
import * as Scope from '../time/scope.ts'

Process.installSignalScope()

const [mode, ...args] = process.argv.slice(2)
const print = (line: string) => process.stdout.write(line + '\n')
const die = (code: number, message: string): never => {
  process.stderr.write(message + '\n')
  process.exit(code)
}
const check = (ok: boolean, what = 'assertion failed') => ok || die(1, what)
const must = <T>(r: {ok: true; value: T} | {ok: false; error: {code: number; message: string}}): T =>
  r.ok ? r.value : die(r.error.code, r.error.message)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function io(marker: string) {
  // If a child blocked the loop, the first would time out before the second creates the marker.
  const first = Process.runInput(['/bin/sh', '-c', 'while [ ! -f "$1" ]; do sleep 0.01; done; printf first', 'sh', marker], '', 1500)
  const second = Process.runInput(['/bin/sh', '-c', 'printf ready > "$1"; printf second', 'sh', marker], '', 1500)
  const [a, b] = [must(await first), must(await second)]
  check(a.code === 0 && a.stdout === 'first' && !a.timedOut && !a.cancelled)
  check(b.code === 0 && b.stdout === 'second' && !b.timedOut && !b.cancelled)
  const echo = must(await Process.runInput(['/bin/cat'], 'native stdin\n', 1000))
  check(echo.code === 0 && echo.stdout === 'native stdin\n')
  print('native IO assertions: 3')
}

async function failFast(marker: string) {
  // Records its pid, then sleeps until this process's exit reaps it.
  void Process.runInput(['/bin/sh', '-c', 'printf \'%s\\n\' "$$" > "$1"; exec sleep 60', 'sh', marker], '', 60000)
  must(await Process.runInput(['/bin/sh', '-c', 'while [ ! -s "$1" ]; do sleep 0.01; done', 'sh', marker], '', 1500))
  must(await Process.runInput(['/jev-fabric-native-intentionally-missing'], '', 1000))
  die(1, 'unreachable: missing command should fail')
}

// The CLI's `exec`: one report line, the child's exit code.
async function exec(ms: string, inherit: string, argv: string[]) {
  const r = must(await Process.runIn(argv, '', Number(ms), inherit === 'stdin', ''))
  print(show(r))
  process.exit(r.code)
}

async function send(s: Session.Session, text: string, expectError: boolean) {
  const r = await Session.write(s, text)
  check(r.ok !== expectError, `write ${expectError ? 'succeeded' : 'failed'}`)
}

async function awaitText(s: Session.Session, expected: string, fuel = 100) {
  for (; fuel > 0; fuel--) {
    const bytes = must(Session.readStdout(s, 0, 65536))
    if (new TextDecoder().decode(bytes).includes(expected)) return print(`live:${expected}`)
    await sleep(10)
  }
  die(1, 'live session reply missing')
}

const reported = (o: Session.Outcome) => print(o.ok ? show(o.value) : 'launch-failed')

const counter = ['/bin/sh', '-c', 'printf \'ready\\n\'; i=0; while IFS= read -r x; do i=$((i+1)); printf \'{"count":%s,"value":%s}\\n\' "$i" "$x"; done']

async function session(which: string) {
  if (which === 'handshake') {
    let s = must(Session.start(counter, 5000))
    await awaitText(s, 'ready')
    await send(s, '10\n', false)
    await awaitText(s, '"count":1')
    await send(s, '20\n', false)
    await awaitText(s, '"count":2')
    s = Session.closeInput(Session.closeInput(s))
    await send(s, '30\n', true)
    return reported(await Session.wait(s))
  }
  if (which === 'failures') {
    for (let i = 0; i < 96; i++) {
      const bad = must(Session.start([], 1000))
      await sleep(10)
      await send(bad, 'x', true)
      check(!(await Session.wait(bad)).ok, 'expected launch failure')
    }
    return print('failure-cleanup:96')
  }
  if (which === 'bytes') {
    const s = must(Session.start(['/bin/sh', '-c', "printf '\\000\\377\\012' >&2; read x"], 3000))
    await sleep(100)
    check(!Session.readStdout(s, 0, 65537).ok && !Session.readStdout(s, 1048577, 1).ok, 'expected read-bound errors')
    const raw = must(Session.readStderr(s, 0, 3))
    check(raw.length === 3 && raw[0] === 0 && raw[1] === 255 && raw[2] === 10, 'bytes differ')
    return reported(await Session.wait(s))
  }
  if (which === 'blocked') {
    const s = must(Session.start(['/bin/sleep', '10'], 150))
    let refused = false
    for (let i = 0; i < 32 && !refused; i++) refused = !(await Session.write(s, 'x'.repeat(65536))).ok
    check(refused, 'stdin never reached bounded backpressure')
    return reported(await Session.wait(s))
  }
  if (which === 'limits') {
    const s = must(Session.start(['/bin/sh', '-c', 'head -c 1100000 /dev/zero; read x'], 3000))
    await send(s, 'x'.repeat(65537), true)
    for (let fuel = 200; ; fuel--) {
      check(fuel > 0, 'spool cap was not reached')
      if (must(Session.status(s))[0] === Session.spoolLimit) break
      await sleep(10)
    }
    print('live:spool-cap')
    const r = must(await Session.wait(s))
    check(r.stdoutCut && r.stdout.length === 32768, 'tail not bounded')
    return print('bounded-tail:32768')
  }
  if (which === 'two' || which === 'cancel') {
    const a = must(Session.start(['/bin/cat'], 500))
    const b = must(Session.start(['/bin/cat'], 500))
    await send(a, 'one\n', false)
    await send(b, 'two\n', false)
    await awaitText(a, 'one', 30)
    await awaitText(b, 'two', 30)
    if (which === 'cancel') {
      Session.cancelScope()
      await sleep(40)
    }
    const [x, y] = [await Session.wait(a), await Session.wait(b)]
    reported(x)
    return reported(y)
  }
  die(2, 'unknown session probe')
}

const pidSleeper = ['/bin/sh', '-c', 'printf \'%s\\n\' "$$"; exec sleep 60']

async function timers(which: string, marker?: string) {
  if (which === 'defaults') {
    print(show(must(await Process.execInput(['/bin/cat'], 'buffered\n'))))
    const s = must(Session.open(['/bin/cat']))
    must(await Session.write(s, 'session\n'))
    print(show(must(await Session.wait(s))))
    const budget = must(Scope.open())
    print(String(budget.duration))
    return print(show(must(await Scope.exec(budget, ['/bin/echo', 'scoped-default']))))
  }
  if (which === 'scope') {
    const budget = must(Scope.withTimeout(1000))
    await sleep(100)
    print(show(must(await Scope.runFor(budget, pidSleeper, '', 100))))
    print(show(must(await Scope.exec(budget, pidSleeper))))
    await sleep(30)
    const touch = ['/bin/sh', '-c', 'touch "$1"', 'sh', marker!]
    print(show(must(await Scope.exec(budget, touch))))
    const started = Scope.start(budget, touch)
    check(!started.ok && started.error.code === 124, 'expired session unexpectedly launched')
    print('expired session: no launch')
    const active = must(Scope.withTimeout(600))
    await sleep(80)
    const s = must(Scope.start(active, pidSleeper))
    return print(show(must(await Session.wait(s))))
  }
  die(2, 'invalid timer fixture mode')
}

// Sticky cancellation: every running child is cancelled, and no later child starts.
async function cancelled() {
  const running = Process.runInput(['/bin/sh', '-c', 'printf "%s\\n" "$$"; exec sleep 60'], '', 60000)
  await sleep(200)
  Process.cancel()
  print(show(must(await running)))
  const later = await Process.runInput(['/bin/echo', 'late'], '', 1000)
  print(later.ok ? 'launched' : `refused:${later.error.code}`)
}

if (mode === 'io') await io(args[0]!)
else if (mode === 'fail-fast') await failFast(args[0]!)
else if (mode === 'exec') await exec(args[0]!, args[1]!, args.slice(2))
else if (mode === 'session') await session(args[0]!)
else if (mode === 'timers') await timers(args[0]!, args[1])
else if (mode === 'cancelled') await cancelled()
else die(2, 'unknown probe')
process.exit(0)
