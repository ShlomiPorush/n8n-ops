import { useState } from "react"

type Values = Record<string, unknown>
type Differs = (a: unknown, b: unknown, name: string) => boolean
export type Edit = { value: unknown; over: unknown }
export type Saved = { value: unknown; at: number }

export function storedNow(read: Values, saved: Record<string, Saved>, readAt: number): Values {
  const since = Object.entries(saved).filter(([, s]) => s.at > readAt)
  return { ...read, ...Object.fromEntries(since.map(([name, s]) => [name, s.value])) }
}

export function editsLeft(edits: Record<string, Edit>, stored: Values, differs: Differs): Record<string, Edit> {
  return Object.fromEntries(
    Object.entries(edits).filter(
      ([name, e]) =>
        !differs(stored[name], e.over, name) ||
        (differs(e.value, e.over, name) && differs(e.value, stored[name], name)),
    ),
  )
}

export function useEdits(read: Values | undefined, readAt: number, differs: Differs) {
  const [held, setHeld] = useState<Record<string, Edit>>({})
  const [saved, setSaved] = useState<Record<string, Saved>>({})
  const stored = storedNow(read ?? {}, saved, readAt)
  const edits = read ? editsLeft(held, stored, differs) : held
  if (Object.keys(edits).length < Object.keys(held).length) setHeld(edits)
  const edited: Values = Object.fromEntries(Object.entries(edits).map(([name, e]) => [name, e.value]))
  return {
    stored,
    edited,
    values: { ...stored, ...edited } as Values,
    set: (name: string, value: unknown) =>
      setHeld((h) => ({ ...h, [name]: { value, over: h[name] ? h[name].over : stored[name] } })),
    saved: (sent: Values) => {
      const at = Date.now()
      setSaved((s) => ({
        ...s,
        ...Object.fromEntries(Object.entries(sent).map(([name, value]) => [name, { value, at }])),
      }))
      setHeld((h) => Object.fromEntries(Object.entries(h).filter(([name, e]) => e !== edits[name])))
    },
    discard: () => setHeld({}),
  }
}
