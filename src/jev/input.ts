// Bounded UTF-8 input files (native/Input.bend): a `cat` child gives special
// files (a FIFO, a device) the same 5 s outside deadline as any subprocess.
// Literal argv; no stderr or content in failure messages.

import type {CaptureFn} from './capture.ts'
import {capture as defaultCapture} from './capture.ts'
import * as Codec from '../codec/codec.ts'
import type {Result} from '../codec/result.ts'
import {fail} from '../codec/result.ts'

export const READ_LIMIT = 1048577

// Input.read: at most 1 MiB of UTF-8 (one byte more is read to tell).
export async function read(path: string, capture: CaptureFn = defaultCapture): Promise<Result<string>> {
  const raw = await capture(['/bin/cat', '--', path], '', 5000, READ_LIMIT)
  if (!raw.ok) return fail(1, 'Unable to read input file')
  if (raw.value.code !== 0 || raw.value.flags !== 0) return fail(1, 'Unable to read bounded UTF-8 input file')
  return Codec.decodeUtf8(raw.value.stdout)
}

// Input.read_limit: at most `limit` bytes (decision files allow 16 MiB).
export async function readLimit(path: string, limit: number, capture: CaptureFn = defaultCapture): Promise<Result<string>> {
  const raw = await capture(['/bin/cat', '--', path], '', 5000, limit)
  if (!raw.ok) return fail(1, 'Unable to read input file')
  if (raw.value.code !== 0 || raw.value.flags !== 0) return fail(1, 'Unable to read bounded UTF-8 input file')
  return Codec.decodeUtf8WithLimit(raw.value.stdout, limit)
}
