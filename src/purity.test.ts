// The pure/driver boundary (0.8.1's native/trust.json and
// scripts/check-native-safety.ts, which Bend's checker backed): every
// production module under src/ is classified pure or driver, and a pure module
// imports only pure modules (types aside) and touches no effect: no `node:`,
// `bun:` or package import, no driver, and no global that does IO, reads a
// clock or randomness, schedules work or reaches the process. Checked with the
// TypeScript compiler on what each module actually references, so a local
// named like a global is not a false alarm and a global reached any other way
// is not missed.

import {describe, expect, test} from 'bun:test'
import {Glob} from 'bun'
import {readFileSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..')

/**
 * The pure modules: 0.8.1's "pure" list ported (TimeCore, Cli, Core, Json and
 * the vendored strict JSON, Codec, Wire, Streams, MonitorCore, HttpCore,
 * CredentialCore, JevCore, DecisionWire, DecisionGenerated, DecisionConfig,
 * DecisionProfiles, DecisionCli, DecisionHttpCore, ServeCore, JobsCore,
 * StoreCore, SpoolCore), the codec's helpers it shared, and what became pure
 * in the port: decision math (a trusted C boundary in 0.8.1), the decision
 * and local-provider cores, the receipt half of Process.bend and `run`'s
 * argument parsing.
 */
const PURE = [
  'src/cli/core.ts', // Cli.bend
  'src/codec/codec.ts', // Codec.bend
  'src/codec/index.ts',
  'src/codec/json.ts', // Json.bend, vendor/strict-json/json.bend
  'src/codec/print.ts',
  'src/codec/result.ts',
  'src/codec/text.ts',
  'src/codec/wire.ts', // Wire.bend
  'src/decision/cli-core.ts', // DecisionCli.bend
  'src/decision/config.ts', // DecisionConfig.bend
  'src/decision/decision-core.ts',
  'src/decision/generated.ts', // DecisionGenerated.bend
  'src/decision/http-core.ts', // DecisionHttpCore.bend
  'src/decision/local-core.ts',
  'src/decision/math.ts', // DecisionMath.bend + decision_math.c, ordinary code now
  'src/decision/profiles.ts', // DecisionProfiles.bend
  'src/decision/targets-core.ts', // the pure half of DecisionTargets.bend
  'src/decision/w.ts',
  'src/decision/wire.ts', // DecisionWire.bend
  'src/jev/core.ts', // Core.bend
  'src/jev/credential-core.ts', // CredentialCore.bend
  'src/jev/http-core.ts', // HttpCore.bend
  'src/jev/jev-core.ts', // JevCore.bend
  'src/jobs/core.ts', // JobsCore.bend
  'src/jobs/streams.ts', // Streams.bend
  'src/monitor/core.ts', // MonitorCore.bend
  'src/proc/report.ts', // the pure half of Process.bend
  'src/run/args.ts',
  'src/serve/core.ts', // ServeCore.bend
  'src/serve/hub.ts', // the Hub/Child/Feeder state of Serve.bend
  'src/spool/core.ts', // SpoolCore.bend
  'src/store/core.ts', // StoreCore.bend
  'src/time/core.ts', // TimeCore.bend
]

/** Everything else that ships: the effects, as 0.8.1's "drivers" list. */
const DRIVERS = [
  'src/cli/cli.ts',
  'src/cli/index.ts',
  'src/cli/io.ts',
  'src/decision/cli.ts',
  'src/decision/decision.ts',
  'src/decision/http.ts',
  'src/decision/index.ts',
  'src/decision/local.ts',
  'src/decision/targets.ts', // reads the profiles file through jev/input.ts
  'src/jev/capture.ts',
  'src/jev/cli.ts',
  'src/jev/credentials.ts',
  'src/jev/http.ts',
  'src/jev/index.ts',
  'src/jev/input.ts',
  'src/jev/jev.ts',
  'src/jev/session.ts',
  'src/jobs/jobs.ts',
  'src/jobs/session.ts', // serve's session children, supervised in process, and their reaper
  'src/lib.ts',
  'src/main.ts',
  'src/monitor/index.ts',
  'src/monitor/monitor.ts',
  'src/proc/process.ts',
  'src/proc/session.ts',
  'src/proc/watchdog.ts', // stops in-process children once their owner is gone
  'src/run/bundle.ts',
  'src/run/embedded.ts',
  'src/run/index.ts',
  'src/serve/index.ts',
  'src/serve/serve.ts',
  'src/spool/spool.ts',
  'src/store/host.ts',
  'src/sys/exits.ts',
  'src/sys/libc.ts',
  'src/time/scope.ts',
  'src/time/time.ts',
]

/**
 * Globals a pure module may reference: exactly the language values and
 * computations the pure modules use today. Everything else the environment
 * provides (`Bun`, `process`, `fetch`, `setTimeout`, `performance`, `crypto`,
 * `console`, `globalThis`, `require`, `queueMicrotask`, `Date` …) fails the
 * check, as do `Math.random`, `Date.now`, `Date()` and `new Date()` with no
 * arguments; a new pure global is added here on purpose, never by accident.
 */
const PURE_GLOBALS = new Set([
  'Array',
  'BigInt',
  'Buffer', // byte arithmetic (Buffer.from, byteLength); no IO
  'Error',
  'Infinity',
  'JSON',
  'Map',
  'Math', // not Math.random, checked below
  'Number',
  'Object',
  'Set',
  'String',
  'TextEncoder',
  'TypeError',
  'Uint8Array',
  'WeakSet',
  'undefined',
])

/** Members of an allowed global that are effects. */
const IMPURE_MEMBERS: Record<string, ReadonlySet<string>> = {
  Math: new Set(['random']),
  Date: new Set(['now']),
  Buffer: new Set(['allocUnsafe', 'allocUnsafeSlow']), // uninitialised memory is not a value
}

/**
 * Justified exceptions: [module, global] pairs a pure module may use
 * although the global is not in PURE_GLOBALS. None today; an entry must say
 * why the use is not an effect.
 */
const EXCEPTIONS: ReadonlyArray<readonly [string, string, string]> = []

const isTest = (f: string) => /\.test(-main|-util)?\.ts$/.test(f)

function production(): string[] {
  return [...new Glob('src/**/*.ts').scanSync({cwd: ROOT})].filter((f) => !isTest(f)).sort()
}

function program(files: string[]) {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT)
  return ts.createProgram(
    files.map((f) => join(ROOT, f)),
    parsed.options,
  )
}

type Finding = {file: string; line: number; what: string}

const where = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** The runtime imports of a module: [specifier, node], type-only imports and exports left out. */
function runtimeImports(sf: ts.SourceFile): [string, ts.Node][] {
  const out: [string, ts.Node][] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) out.push([(node.moduleSpecifier as ts.StringLiteral).text, node])
      return
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly) out.push([(node.moduleSpecifier as ts.StringLiteral).text, node])
      return
    }
    if (ts.isImportEqualsDeclaration(node)) {
      out.push([node.moduleReference.getText(sf), node])
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      out.push([arg && ts.isStringLiteralLike(arg) ? arg.text : '<computed>', node])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Whether an identifier is read as a value here (not a name being declared, a member name, or a type). */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p as ts.PropertyAccessExpression).name === id) return false
  if (ts.isPropertyAssignment(p) && p.name === id) return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  if (ts.isMetaProperty(p)) return false
  const named = p as {name?: ts.Node}
  if (named.name === id && (ts.isDeclarationStatement(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionExpression(p) || ts.isClassElement(p) || ts.isEnumMember(p) || ts.isBindingElement(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isTypeParameterDeclaration(p)))
    return false
  return true
}

const fromEnvironment = (program: ts.Program, decl: ts.Declaration) => {
  const file = decl.getSourceFile()
  return program.isSourceFileDefaultLibrary(file) || file.fileName.includes('/node_modules/') || !resolve(file.fileName).startsWith(join(ROOT, 'src') + '/')
}

/** Every effect a pure module reaches directly: an import out of the pure set, or an impure global. */
function audit(files: string[], pure: ReadonlySet<string>): {findings: Finding[]; globals: Map<string, Set<string>>} {
  const prog = program(files)
  const checker = prog.getTypeChecker()
  const findings: Finding[] = []
  const globals = new Map<string, Set<string>>()
  for (const file of files) {
    const sf = prog.getSourceFile(join(ROOT, file))!
    for (const [spec, node] of runtimeImports(sf)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        findings.push({file, line: where(sf, node), what: `imports '${spec}' (only pure modules of src/ may be imported)`})
        continue
      }
      const target = relative(ROOT, resolve(dirname(join(ROOT, file)), spec))
      if (!pure.has(target)) findings.push({file, line: where(sf, node), what: `imports the non-pure module ${target}`})
    }
    const used = new Set<string>()
    const visit = (node: ts.Node) => {
      // Types never run: skip them, and whole type declarations.
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        findings.push({file, line: where(sf, node), what: 'uses import.meta'})
      }
      if (ts.isIdentifier(node) && isValueReference(node)) {
        const symbol = checker.getSymbolAtLocation(node)
        const decls = symbol?.declarations ?? []
        const global = node.text === 'undefined' || (decls.length > 0 && decls.every((d) => fromEnvironment(prog, d)))
        if (global) {
          const name = node.text
          used.add(name)
          const excepted = EXCEPTIONS.some(([f, g]) => f === file && g === name)
          if (!PURE_GLOBALS.has(name) && !excepted) findings.push({file, line: where(sf, node), what: `uses the global ${name}`})
          const parent = node.parent
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node && IMPURE_MEMBERS[name]?.has(parent.name.text)) {
            findings.push({file, line: where(sf, node), what: `uses ${name}.${parent.name.text}`})
          }
          if (name === 'Date' && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node && (parent.arguments?.length ?? 0) === 0) {
            findings.push({file, line: where(sf, node), what: `reads the clock (${ts.isNewExpression(parent) ? 'new Date()' : 'Date()'})`})
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    globals.set(file, used)
  }
  return {findings, globals}
}

/** The pure modules each pure module reaches, transitively (runtime imports only). */
function closure(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
    graph.set(
      file,
      runtimeImports(sf)
        .map(([spec]) => spec)
        .filter((spec) => spec.startsWith('.'))
        .map((spec) => relative(ROOT, resolve(dirname(join(ROOT, file)), spec))),
    )
  }
  const reach = new Map<string, string[]>()
  for (const file of files) {
    const seen = new Set<string>()
    const stack = [file]
    while (stack.length) {
      const at = stack.pop()!
      for (const next of graph.get(at) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        if (graph.has(next)) stack.push(next)
      }
    }
    reach.set(file, [...seen].sort())
  }
  return reach
}

let pureAudit: ReturnType<typeof audit> | undefined
const auditPure = () => (pureAudit ??= audit(PURE, new Set(PURE)))

const show = (fs: Finding[]) => fs.map((f) => `${f.file}:${f.line}: ${f.what}`).join('\n')

describe('pure modules', () => {
  test('every production module under src/ is classified pure or driver, once', () => {
    const files = production()
    const listed = [...PURE, ...DRIVERS]
    expect(new Set(listed).size).toBe(listed.length)
    expect(files.filter((f) => !listed.includes(f))).toEqual([])
    expect(listed.filter((f) => !files.includes(f))).toEqual([])
  })

  test('pure modules import only pure modules and touch no effect', () => {
    const {findings} = auditPure()
    expect(show(findings)).toBe('')
  }, 60000)

  test('the transitive import closure of every pure module stays pure', () => {
    const pure = new Set(PURE)
    const reach = closure(PURE)
    const escapes = [...reach].flatMap(([file, deps]) => deps.filter((d) => !pure.has(d)).map((d) => `${file} reaches ${d}`))
    expect(escapes).toEqual([])
  })

  test('every allowed global and justified exception is still needed', () => {
    const {globals} = auditPure()
    const used = new Set([...globals.values()].flatMap((g) => [...g]))
    expect([...PURE_GLOBALS].filter((g) => !used.has(g))).toEqual([])
    for (const [file, name] of EXCEPTIONS) expect(globals.get(file)?.has(name)).toBe(true)
  }, 60000)

  // The check itself: a driver, as if it were pure, is caught.
  test('the check catches a driver posing as pure', () => {
    const {findings} = audit(['src/time/time.ts'], new Set(PURE))
    const text = show(findings)
    expect(text).toContain('uses the global process')
    expect(text).toContain('uses the global performance')
    const io = audit(['src/cli/io.ts'], new Set(PURE))
    expect(show(io.findings)).toContain("imports 'node:fs'")
    expect(show(io.findings)).toContain('uses the global Bun')
    const clock = audit(['src/monitor/monitor.ts'], new Set(PURE))
    expect(show(clock.findings)).toContain('imports the non-pure module src/store/host.ts')
    expect(show(clock.findings)).toContain('uses the global setTimeout')
    expect(show(clock.findings)).toContain('uses the global Date')
  }, 60000)
})
