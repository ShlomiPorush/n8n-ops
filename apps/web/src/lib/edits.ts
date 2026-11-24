import { useState } from "react"

/*
 * A form over stored values holds only its edits (SV-6): a field without one shows what is stored now, so a refresh
 * never overwrites what is typed, and no field keeps a value that was changed elsewhere meanwhile.
 */

type Values = Record<string, unknown>
/** Whether two values of a field differ, compared as its save counts them. */
type Differs = (a: unknown, b: unknown, name: string) => boolean
/** A value not saved yet, and the stored one it was made over. */
export type Edit = { value: unknown; over: unknown }
/** A value a save stored, and when. */
export type Saved = { value: unknown; at: number }

/** What is stored: as last read, and what a save stored since then, also when the read after the save failed. */
export function storedNow(read: Values, saved: Record<string, Saved>, readAt: number): Values {
  const since = Object.entries(saved).filter(([, s]) => s.at > readAt)
  return { ...read, ...Object.fromEntries(since.map(([name, s]) => [name, s.value])) }
}

/**
 * The edits that are left over what is stored. Once the stored value moved, one that was put back by hand, or that
 * is what is stored now, is none: the field follows what is stored.
 */
export function editsLeft(edits: Record<string, Edit>, stored: Values, differs: Differs): Record<string, Edit> {
  return Object.fromEntries(
    Object.entries(edits).filter(
      ([name, e]) =>
        !differs(stored[name], e.over, name) ||
        (differs(e.value, e.over, name) && differs(e.value, stored[name], name)),
    ),
  )
}

/** The values of a form over the stored `read` (undefined until the first read), read at `readAt`. */
export function useEdits(read: Values | undefined, readAt: number, differs: Differs) {
  const [held, setHeld] = useState<Record<string, Edit>>({})
  const [saved, setSaved] = useState<Record<string, Saved>>({})
  const stored = storedNow(read ?? {}, saved, readAt)
  const edits = read ? editsLeft(held, stored, differs) : held
  // For good: an edit that went does not come back when the stored value moves again.
  if (Object.keys(edits).length < Object.keys(held).length) setHeld(edits)
  const edited: Values = Object.fromEntries(Object.entries(edits).map(([name, e]) => [name, e.value]))
  return {
    stored,
    edited,
    values: { ...stored, ...edited } as Values,
    /** An edit stays over the stored value that its first step was made over: put back by hand means back to that. */
    set: (name: string, value: unknown) =>
      setHeld((h) => ({ ...h, [name]: { value, over: h[name] ? h[name].over : stored[name] } })),
    /** After a save of these values: they stand as stored until the next read. An edit made meanwhile stays. */
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
