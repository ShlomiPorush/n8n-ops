import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LIST_WAIT_MS, SEARCH_PAUSE_MS } from "@/lib/behavior"
import { FilterBar, firstRowReset, searchDraft } from "./filter-bar.tsx"

// No list has a rarely used filter yet, so the Filters button is checked here, not on a page (MP-6).
describe("the Filters button of a filter bar (MP-6)", () => {
  const rare = (
    <select aria-label="Trigger">
      <option>All</option>
    </select>
  )

  it("is there only when the bar has rare filters, and the common pickers always show", () => {
    const html = renderToStaticMarkup(<FilterBar pickers={<button type="button">Instance: All</button>} />)
    expect(html).not.toContain("Filters")
    expect(html).toContain("Instance: All")
    // Nothing folds the common pickers away on a phone any more.
    expect(html).not.toContain("max-md:hidden")
  })

  it("is named Filters and keeps the rare filters hidden until opened", () => {
    const html = renderToStaticMarkup(<FilterBar more={rare} />)
    expect(html).toContain('aria-label="Filters"')
    expect(html).toContain('title="Filters"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*><select aria-label="Trigger"/)
  })

  it("counts the rare filters in use in its name and on a badge", () => {
    const html = renderToStaticMarkup(<FilterBar more={rare} active={2} />)
    expect(html).toContain('aria-label="Filters, 2 in use"')
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>2<\/span>/)
  })
})

describe("a search that waits for a pause (SR-9)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const box = (initial = "") => {
    const shown: string[] = []
    const sent: string[] = []
    const draft = searchDraft(
      initial,
      (t) => shown.push(t),
      (t) => sent.push(t),
    )
    return { draft, shown, sent }
  }

  it("shows each key at once and asks once typing pauses", () => {
    const { draft, shown, sent } = box()
    draft.type("Sy")
    draft.type("Sync")
    expect(shown).toEqual(["Sy", "Sync"])
    vi.advanceTimersByTime(SEARCH_PAUSE_MS - 1)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual(["Sync"])
    // Its own value coming back is not a change from outside: what is typed since stays and is asked for.
    draft.type("Sync o")
    draft.sync("Sync")
    vi.advanceTimersByTime(SEARCH_PAUSE_MS)
    expect(sent).toEqual(["Sync", "Sync o"])
  })

  it("drops what is typed when Clear filters leaves the value as it was, as nothing was sent yet", () => {
    const { draft, shown, sent } = box()
    draft.type("Sync")
    // The value is still "" in the address, so only Clear filters itself says what happened.
    draft.sync("")
    draft.reset("")
    vi.advanceTimersByTime(SEARCH_PAUSE_MS * 2)
    expect(sent).toEqual([])
    expect(shown.at(-1)).toBe("")
  })

  it("lets a value set from outside replace what is typed and drop the search on its way", () => {
    const { draft, shown, sent } = box("Sync")
    draft.type("Sync orders")
    draft.sync("Backup")
    vi.advanceTimersByTime(SEARCH_PAUSE_MS * 2)
    expect(sent).toEqual([])
    expect(shown.at(-1)).toBe("Backup")
  })
})

describe("a new filter starts the list at its first row (TB-7)", () => {
  const clock = () => {
    let t = 0
    return { now: () => t, wait: (ms: number) => (t += ms) }
  }

  it("goes there once more when the request of the new filters ends, and only once", () => {
    const c = clock()
    const reset = firstRowReset(c.now)
    reset.changed(true)
    expect(reset.loaded(true)).toBe(false)
    expect(reset.loaded(false)).toBe(true)
    // A later refresh, with the same rows or new ones, leaves the list where it is.
    expect(reset.loaded(true)).toBe(false)
    expect(reset.loaded(false)).toBe(false)
  })

  it("does not wait for rows already drawn, as when the new filters were cached", () => {
    const reset = firstRowReset(clock().now)
    reset.changed(false)
    // The next refresh of the same filters is not their first answer.
    expect(reset.loaded(true)).toBe(false)
    expect(reset.loaded(false)).toBe(false)
  })

  it("leaves the list where the user scrolled it since the change", () => {
    const reset = firstRowReset(clock().now)
    reset.changed(true)
    reset.scrolled()
    expect(reset.loaded(false)).toBe(false)
  })

  it("gives up on an answer that came too late", () => {
    const c = clock()
    const reset = firstRowReset(c.now)
    reset.changed(true)
    c.wait(LIST_WAIT_MS + 1)
    expect(reset.loaded(false)).toBe(false)
    // A newer change starts over.
    reset.changed(true)
    expect(reset.loaded(false)).toBe(true)
  })
})
