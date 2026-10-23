import { describe, expect, it } from "vitest"
import { type Loadable, loadView, refreshFailed } from "./load-state.ts"

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
})
