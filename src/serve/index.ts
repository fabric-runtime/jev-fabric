// `serve` (native/ServeCore.bend and native/Serve.bend): the JSONL session.
//
//   serveMain(args)        `jev-fabric -- serve …` with the arguments after
//                          `serve`; resolves to the exit code (a nonzero
//                          code's message already on stderr).
//   serve(timeout, args)   the same with the deadline already chosen and
//                          `args` = `[max-evaluations [max-tokens]]`.
//   capabilities(v, p)     what `jev-fabric -- capabilities` prints.

export {serve, serveMain, Session, VERSION} from './serve.ts'
export {capabilities, banner, FEATURES, PROTOCOL} from './core.ts'
export * as Core from './core.ts'
export * as Hub from './hub.ts'
