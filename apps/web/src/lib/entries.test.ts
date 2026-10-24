import { describe, expect, it } from "vitest"
import { addEntries, finishedEntries, pasteInto } from "./entries"

describe("values added to a list field (FS-15)", () => {
  it("adds several at once, trimmed, from a paste", () => {
    expect(addEntries([], " a@example.com, b@example.com;c@example.com\nd@example.com ")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ])
  })

  it("never adds a value twice, also when typed in another case", () => {
    expect(addEntries(["ops@example.com"], "OPS@example.com, new@example.com, new@example.com")).toEqual([
      "ops@example.com",
      "new@example.com",
    ])
  })

  it("keeps a value that is not valid, so the field can name it", () => {
    expect(addEntries([], "bob")).toEqual(["bob"])
  })

  it("puts a paste in place of the selection, or at the cursor, before it adds the values", () => {
    // "old" typed and selected whole, then a list pasted over it: the list alone is added.
    expect(addEntries([], pasteInto("old", "ops@example.com, dev@example.com", 0, 3))).toEqual([
      "ops@example.com",
      "dev@example.com",
    ])
    // Part of it selected: only that part is replaced.
    expect(pasteInto("ops@old.example", "new, x@example.com", 4, 7)).toBe("ops@new, x@example.com.example")
    // The cursor in the middle, nothing selected.
    expect(pasteInto("ab", "x, y", 1, 1)).toBe("ax, yb")
  })

  it("leaves what is still being typed after the last separator", () => {
    expect(finishedEntries("a@example.com, b@exa")).toEqual({ done: "a@example.com", rest: "b@exa" })
    expect(finishedEntries("a@example.com,")).toEqual({ done: "a@example.com", rest: "" })
    expect(finishedEntries("a@exa")).toEqual({ done: "", rest: "a@exa" })
  })
})
