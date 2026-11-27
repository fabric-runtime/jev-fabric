// JSON output for hand-built records (native/Json.bend): process reports,
// job records and session lines are written field by field with these.
//
// Not the codec's escaping: every control below 32 is \u00xx here (a newline
// is \u000a, not \n), as 0.8.1 printed them. Everything else, non-ASCII
// included, is written as is.

export function quote(text: string): string {
  let out = '"'
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c !== 34 && c !== 92 && c >= 32) continue
    out += text.slice(from, i)
    from = i + 1
    out += c === 34 ? '\\"' : c === 92 ? '\\\\' : `\\u00${c.toString(16).padStart(2, '0')}`
  }
  return `${out + text.slice(from)}"`
}

export const boolean = (value: boolean): string => (value ? 'true' : 'false')
