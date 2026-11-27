// Whole writes to stdout and stderr, synchronously, so a line is out before
// the next poll and before the process exits. A pipe the reader closed is
// left alone (0.8.1 ignored SIGPIPE's EPIPE the same way).

import {writeSync} from 'node:fs'

export function writeAll(fd: number, text: string) {
  if (text === '') return
  const data = Buffer.from(text, 'utf8')
  let sent = 0
  while (sent < data.length) {
    try {
      sent += writeSync(fd, data, sent, data.length - sent)
    } catch (e) {
      const code = (e as {code?: unknown})?.code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') {
        Bun.sleepSync(1)
        continue
      }
      return
    }
  }
}

export const stdout = (text: string) => writeAll(1, text)
export const stderr = (text: string) => writeAll(2, text)
