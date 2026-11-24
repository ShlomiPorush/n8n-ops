import { splitEntries } from "@n8n-ops/shared"

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

export function pasteInto(text: string, pasted: string, start: number, end: number): string {
  return text.slice(0, start) + pasted + text.slice(end)
}

export function finishedEntries(text: string): { done: string; rest: string } {
  const last = Math.max(text.lastIndexOf(","), text.lastIndexOf(";"))
  if (last < 0) return { done: "", rest: text }
  return { done: text.slice(0, last), rest: text.slice(last + 1).trimStart() }
}
