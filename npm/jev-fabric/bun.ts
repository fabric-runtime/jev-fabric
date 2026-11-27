// `import ... from 'jev-fabric'` under Bun: the library (src/lib.ts, the same
// one `jev-fabric -- run` binds) and this package's locator in one module.
// Node gets the locator alone (index.js); `jev-fabric/locate` is the locator
// and `jev-fabric/lib` the library under either name.
//
// Durable jobs started from here re-enter src/main.ts with this Bun, so the
// library needs no executable on PATH; setExecutable() picks another one, such
// as binaryPath().
export * from './src/lib.ts'
export {binaryPath, clientsDirectory, platformPackage, version} from './index.js'
