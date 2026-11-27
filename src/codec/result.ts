// Results as the native modules carried them: a value, or an error code with
// a message. The code is what the CLI exits with (a JSON parse error's code
// is the character position where it failed, as 0.8.1's is), so it is kept
// exactly, not normalized.

export type Err = {code: number; message: string}
export type Result<T> = {ok: true; value: T} | {ok: false; error: Err}

export const done = <T>(value: T): Result<T> => ({ok: true, value})
export const fail = (code: number, message: string): {ok: false; error: Err} => ({ok: false, error: {code, message}})

// Inside a module a failure is thrown and caught once at its entry point, so
// long validations read top to bottom like the Bend `do` blocks they port.
export class Failure extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export function guard(ok: boolean, message: string, code = 22): void {
  if (!ok) throw new Failure(code, message)
}

export function raise(code: number, message: string): never {
  throw new Failure(code, message)
}

// The value of a result, or its error thrown as a Failure.
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value
  throw new Failure(r.error.code, r.error.message)
}

// Runs a throwing body and catches only Failures (a bug still throws).
export function attempt<T>(body: () => T): Result<T> {
  try {
    return done(body())
  } catch (e) {
    if (e instanceof Failure) return fail(e.code, e.message)
    throw e
  }
}

export async function attemptAsync<T>(body: () => Promise<T>): Promise<Result<T>> {
  try {
    return done(await body())
  } catch (e) {
    if (e instanceof Failure) return fail(e.code, e.message)
    throw e
  }
}

// What 0.8.1's IO.die / IO.pass printed and exited with for an error: the
// message and a newline on stderr, and the code as the exit status. Bend
// refused a status outside 0..255 with a second line and exit 1; a code of 0
// (a parse error at the first character) exits 0 with the message printed.
export function died(e: Err): {stderr: string; exit: number} {
  if (e.code >= 0 && e.code <= 255) return {stderr: `${e.message}\n`, exit: e.code}
  return {stderr: `${e.message}\nbend: exit code must be in 0..255\n`, exit: 1}
}
