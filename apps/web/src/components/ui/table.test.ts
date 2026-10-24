import { describe, expect, it } from "vitest"
import { type SortAnswer, type SortState, sortTracker } from "./table.tsx"

const failures: SortState = { key: "failures", dir: "descending" }
const fewest: SortState = { key: "failures", dir: "ascending" }
const byName: SortState = { key: "workflow", dir: "ascending" }

// What `useApi(path, { keepRows: true })` gives for the address asked for.
const arrived: SortAnswer = { data: { items: [] } }
const loading: SortAnswer = { data: { items: [] }, isPlaceholderData: true, previous: "loading" }
const failed: SortAnswer = { data: { items: [] }, previous: "failed" }
const retrying: SortAnswer = { data: { items: [] }, isPlaceholderData: true, previous: "failed" }

// A list sorted on the server shows the order its rows are in (TB-4), and remembers only that one (TB-3).
describe("sortTracker", () => {
  it("shows a new order at once, while its rows are on their way", () => {
    const sort = sortTracker("t-at-once")
    expect(sort.initial).toBeNull()
    expect(sort.shown(null, arrived)).toBeNull()
    expect(sort.shown(failures, loading)).toEqual(failures)
    expect(sort.shown(failures, arrived)).toEqual(failures)
  })

  it("goes back to the order the rows are in when the new order fails to load, and keeps it while asked again", () => {
    const sort = sortTracker("t-failed")
    sort.shown(null, arrived)
    sort.shown(failures, loading)
    expect(sort.shown(failures, failed)).toBeNull()
    expect(sort.shown(failures, retrying)).toBeNull()
    // Its rows come after all: now it is the order shown.
    expect(sort.shown(failures, arrived)).toEqual(failures)
  })

  it("after several choices in a row, a failure shows the last order whose rows came", () => {
    const sort = sortTracker("t-several")
    sort.shown(byName, arrived)
    sort.shown(failures, loading)
    sort.shown(fewest, loading)
    expect(sort.shown(fewest, failed)).toEqual(byName)
  })

  it("remembers only an order whose rows came, for the next visit", () => {
    const first = sortTracker("t-remember")
    first.shown(byName, arrived)
    first.shown(failures, loading)
    first.shown(failures, failed)
    expect(sortTracker("t-remember").initial).toEqual(byName)
    first.shown(fewest, arrived)
    expect(sortTracker("t-remember").initial).toEqual(fewest)
  })

  it("keeps the order of rows whose refresh failed: they are still the rows of that order", () => {
    const sort = sortTracker("t-refresh")
    sort.shown(failures, arrived)
    expect(sort.shown(failures, { data: { items: [] }, previous: undefined })).toEqual(failures)
  })

  it("starts from the order the list gives when none is remembered", () => {
    expect(sortTracker("t-initial", byName).initial).toEqual(byName)
  })
})
