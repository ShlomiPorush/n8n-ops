import { describe, expect, it } from "vitest"
import { filterFailed, keepShown, type Loadable, loadView, refreshFailed, type Shown } from "./load-state.ts"

const q = (state: Partial<Loadable>): Loadable => ({ data: undefined, error: null, isLoading: false, ...state })
const failure = new Error("HTTP 500")

describe("loadView (TB-5)", () => {
  it("loads until the first answer", () => {
    expect(loadView(q({ isLoading: true }))).toBe("loading")
  })

  it("shows the error panel only when nothing has loaded", () => {
    expect(loadView(q({ error: failure }))).toBe("failed")
  })

  it("keeps the rows when a refresh fails", () => {
    expect(loadView(q({ data: [{ id: 1 }], error: failure }))).toBe("ready")
  })

  it("keeps an empty answer as an answer", () => {
    expect(loadView(q({ data: [], error: failure }))).toBe("ready")
    expect(loadView(q({ data: null }))).toBe("ready")
  })

  it("draws a query that is not asked for as ready, not as loading", () => {
    expect(loadView(q({}))).toBe("ready")
  })
})

describe("refreshFailed (LD-12)", () => {
  it("is off while the data is fresh, and with no data at all", () => {
    expect(refreshFailed(q({ data: [] }))).toBe(false)
    expect(refreshFailed(q({ error: failure }))).toBe(false)
    expect(refreshFailed(q({ isLoading: true }))).toBe(false)
  })

  it("is on when a refresh failed and the data is kept", () => {
    expect(refreshFailed(q({ data: [{ id: 1 }], error: failure }))).toBe(true)
  })

  it("leaves a failed next or previous page to the end of the list (TB-6)", () => {
    expect(refreshFailed(q({ data: { pages: [[]] }, error: failure, isFetchNextPageError: true }))).toBe(false)
    expect(refreshFailed(q({ data: { pages: [[]] }, error: failure, isFetchPreviousPageError: true }))).toBe(false)
  })

  it("leaves new filters that failed to the filter line", () => {
    expect(refreshFailed(q({ data: [{ id: 1 }], error: failure, previous: "failed" }))).toBe(false)
    expect(filterFailed(q({ data: [{ id: 1 }], error: failure, previous: "failed" }))).toBe(true)
    expect(filterFailed(q({ data: [{ id: 1 }], error: failure }))).toBe(false)
  })
})

describe("keepShown (TB-5)", () => {
  // A list answer as React Query gives it: `data` is its own answer, or the previous one while `isPlaceholderData`.
  type Answer = Loadable & { dataUpdatedAt: number; isPlaceholderData?: boolean }
  const a = (state: Partial<Answer>): Answer => ({ ...q({}), dataUpdatedAt: 0, ...state })
  const open = [{ id: "open-1" }]
  const muted = [{ id: "muted-1" }]

  /** Runs answers through one list, as its renders would, and returns what each draws. */
  function run(...answers: [string, Answer][]) {
    let shown: Shown | null = null
    return answers.map(([key, answer]) => {
      const next = keepShown(shown, key, answer)
      shown = next.shown
      return next.view
    })
  }

  it("keeps the rows last shown, with their time, when new filters fail to load", () => {
    const [, loading, failed] = run(
      ["open", a({ data: open, dataUpdatedAt: 1000 })],
      ["muted", a({ data: open, isPlaceholderData: true, isLoading: true })],
      ["muted", a({ error: failure })],
    )
    expect(loading?.previous).toBe("loading")
    expect(failed?.data).toBe(open)
    expect(failed?.dataUpdatedAt).toBe(1000)
    expect(failed?.previous).toBe("failed")
    // Rows and a line, not the error panel.
    expect(failed && loadView(failed)).toBe("ready")
    expect(failed && filterFailed(failed)).toBe(true)
  })

  it("keeps saying so while the failed filters are asked for again", () => {
    // A poll or Try again: the failed query is pending again, its error cleared, the previous rows held meanwhile.
    const [, , retrying, failedAgain] = run(
      ["open", a({ data: open, dataUpdatedAt: 1000 })],
      ["muted", a({ error: failure })],
      ["muted", a({ data: open, isPlaceholderData: true, isLoading: true })],
      ["muted", a({ error: failure })],
    )
    expect(retrying?.previous).toBe("failed")
    expect(retrying?.dataUpdatedAt).toBe(1000)
    expect(failedAgain?.previous).toBe("failed")
  })

  it("draws an answer of the new filters once it comes, and forgets the failure", () => {
    const [, , answered, back] = run(
      ["open", a({ data: open, dataUpdatedAt: 1000 })],
      ["muted", a({ error: failure })],
      ["muted", a({ data: muted, dataUpdatedAt: 2000 })],
      ["open", a({ data: muted, isPlaceholderData: true, isLoading: true })],
    )
    expect(answered?.data).toBe(muted)
    expect(answered?.previous).toBeUndefined()
    expect(back?.previous).toBe("loading")
  })

  it("leaves the error panel to a list that has never shown an answer", () => {
    const [failed] = run(["muted", a({ error: failure })])
    expect(failed?.data).toBeUndefined()
    expect(failed && loadView(failed)).toBe("failed")
  })

  it("leaves a failed refresh of the same filters to React Query, which keeps their data", () => {
    const [, refreshed] = run(
      ["open", a({ data: open, dataUpdatedAt: 1000 })],
      ["open", a({ data: open, dataUpdatedAt: 1000, error: failure })],
    )
    expect(refreshed?.previous).toBeUndefined()
    expect(refreshed && refreshFailed(refreshed)).toBe(true)
  })
})
