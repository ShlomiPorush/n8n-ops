import { describe, expect, it } from "vitest"
import { type Edit, editsLeft, storedNow } from "./edits.ts"

/** Compared as the settings form does: text by its trimmed value, a secret as it is. */
const differs = (a: unknown, b: unknown, name: string) =>
  name === "secret" ? a !== b : String(a ?? "").trim() !== String(b ?? "").trim()

/** The values on screen over what is stored, with the edits that are left. */
const shown = (edits: Record<string, Edit>, stored: Record<string, unknown>) => ({
  ...stored,
  ...Object.fromEntries(Object.entries(editsLeft(edits, stored, differs)).map(([k, e]) => [k, e.value])),
})

describe("a form that holds only its edits (SV-6)", () => {
  it("shows a field without an edit as it is stored now, and keeps an edited one through a refresh", () => {
    const edits = { host: { value: "typed", over: "a" } }
    expect(shown(edits, { host: "a", port: 25 })).toEqual({ host: "typed", port: 25 })
    // Another tab saved both fields.
    expect(shown(edits, { host: "b", port: 587 })).toEqual({ host: "typed", port: 587 })
  })

  it("takes a field put back by hand as not edited once the stored value moves", () => {
    const edits = { port: { value: "25", over: 25 }, host: { value: "a ", over: "a" } }
    // Until then it stays as typed, so a space typed at the end is not taken away.
    expect(shown(edits, { port: 25, host: "a" })).toEqual({ port: "25", host: "a " })
    expect(editsLeft(edits, { port: 587, host: "b" }, differs)).toEqual({})
  })

  it("drops an edit that is what is stored now, as after a save whose answer was lost", () => {
    expect(editsLeft({ host: { value: "b", over: "a" } }, { host: "b" }, differs)).toEqual({})
  })

  it("keeps apart a secret that is left alone, opened empty and removed", () => {
    const opened = { secret: { value: "", over: undefined } }
    const removed = { secret: { value: null, over: undefined } }
    expect(shown({}, { secret: undefined }).secret).toBeUndefined()
    expect(shown(opened, { secret: undefined }).secret).toBe("")
    expect(shown(removed, { secret: undefined }).secret).toBeNull()
  })

  it("keeps what a save stored until a later read brings it, also when the read after the save failed", () => {
    const saved = { host: { value: "saved", at: 2000 } }
    expect(storedNow({ host: "old", port: 25 }, saved, 1000)).toEqual({ host: "saved", port: 25 })
    expect(storedNow({ host: "newer", port: 25 }, saved, 3000)).toEqual({ host: "newer", port: 25 })
    // An edit made after the save is over the saved value, and stays once the read brings that.
    const edits = { host: { value: "again", over: "saved" } }
    expect(shown(edits, storedNow({ host: "old" }, saved, 1000)).host).toBe("again")
    expect(shown(edits, storedNow({ host: "saved" }, saved, 3000)).host).toBe("again")
  })
})
