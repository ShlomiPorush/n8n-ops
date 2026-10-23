import { splitEntries } from "@n8n-ops/shared"

/**
 * Adds typed or pasted text to a list of values (FS-15): it may hold several, separated by commas, semicolons,
 * spaces or lines (SV-12). Each is trimmed, and one already in the list, compared without case, is not added
 * again. A value that is not valid is still added, so it stays in sight and its field names it.
 */
export function addEntries(list: readonly string[], text: string): string[] {
  const seen = new Set(list.map((v) => v.toLowerCase()))
  const next = [...list]
  for (const entry of splitEntries(text)) {
    if (seen.has(entry.toLowerCase())) continue
    seen.add(entry.toLowerCase())
    next.push(entry)
  }
  return next
}

/**
 * The Add field's text after a paste: the pasted text takes the place of the selection, or goes in at the
 * cursor, as a browser pastes it. `start` and `end` are the field's selection when the paste came.
 */
export function pasteInto(text: string, pasted: string, start: number, end: number): string {
  return text.slice(0, start) + pasted + text.slice(end)
}

/**
 * Splits what is in an Add field after a key or a paste: the entries before the last separator are done, and
 * the rest is still being typed.
 */
export function finishedEntries(text: string): { done: string; rest: string } {
  const last = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"))
  if (last < 0) return { done: "", rest: text }
  return { done: text.slice(0, last), rest: text.slice(last + 1).trimStart() }
}
