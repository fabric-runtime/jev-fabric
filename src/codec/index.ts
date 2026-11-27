// Encoding in jev-fabric: strict bounded JSON, UTF-8, the Jev wire format,
// and the hand-built JSON of process reports and job records.
//
//   Codec.read(text) / encode(value) / validate(value)          1 MiB, depth 64, 32768 work
//   Codec.readWithLimit / encodeWithLimit / validateWithLimit    up to 16 MiB (decisions)
//   Codec.readProfile / encodeProfile / validateProfile          high-work profile (local top_logprobs)
//   Codec.decodeUtf8 / decodeUtf8WithLimit / readBytes*          strict UTF-8
//   Codec.field / findField / text / array / fromJs              reading and building the AST
//   Wire.request / validateRequest / body / response / reply / replyUsage / usage / scalar / decimal
//   Print.quote / Print.boolean                                  Json.bend's \u00xx-everywhere escaping
//   died(err): {stderr, exit}                                    what 0.8.1 printed and exited with
//
// Every error is {code, message}; a JSON parse error's code is its position
// (in code points), and the CLI exits with it (see died()).

export * as Codec from './codec.ts'
export * as Wire from './wire.ts'
export * as Print from './print.ts'
export * as Text from './text.ts'
export type {Json, Member} from './json.ts'
export type {Err, Result} from './result.ts'
export {attempt, died, done, fail, Failure, guard, unwrap} from './result.ts'
