import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  isDefaultOrder,
  orderWords,
  RANK_WORDS,
  SortButton,
  type SortControl,
  type Sorting,
  type SortOrder,
  type SortState,
  sortLabel,
  sortRows,
  useSort,
} from "./table.tsx"

describe("the words of a Sort menu (TB-28)", () => {
  it("names the two orders by what the column holds", () => {
    expect(orderWords("date")).toEqual({ descending: "Newest first", ascending: "Oldest first" })
    expect(orderWords("number")).toEqual({ descending: "Most first", ascending: "Fewest first" })
    expect(orderWords("text")).toEqual({ ascending: "A to Z", descending: "Z to A" })
    expect(orderWords()).toEqual({ ascending: "Ascending", descending: "Descending" })
  })

  it("names the button after the order in use", () => {
    const columns: SortControl["columns"] = [
      { key: "failures", label: "Failures", first: "descending", words: orderWords("number") },
      { key: "status", label: "Status", first: "descending", words: RANK_WORDS },
    ]
    expect(sortLabel({ state: null, columns })).toBe("Sort: Default order")
    expect(sortLabel({ state: { key: "failures", dir: "descending" }, columns })).toBe("Sort: Failures, Most first")
    expect(sortLabel({ state: { key: "status", dir: "ascending" }, columns })).toBe("Sort: Status, Needs a look last")
    // A column that is gone falls back to the default order rather than a name it cannot give.
    expect(sortLabel({ state: { key: "gone", dir: "ascending" }, columns })).toBe("Sort: Default order")
  })
})

describe("the default order (TB-3, TB-11)", () => {
  const rows = [
    { name: "a", rank: 0, n: 3 },
    { name: "b", rank: 2, n: 1 },
    { name: "c", rank: 0, n: 2 },
    { name: "d", rank: 1, n: 5 },
  ]
  const names = (list: typeof rows) => list.map((r) => r.name)

  it("is the order the rows came in when the list has no rank", () => {
    expect(names(sortRows(rows, null))).toEqual(["a", "b", "c", "d"])
  })

  it("puts what needs a look first, then keeps the order the rows came in", () => {
    expect(names(sortRows(rows, null, (r) => r.rank))).toEqual(["b", "d", "a", "c"])
  })

  it("comes back exactly after a column was picked", () => {
    const rank = (r: (typeof rows)[number]) => r.rank
    expect(names(sortRows(rows, { value: (r) => r.n, dir: "descending" }, rank))).toEqual(["d", "a", "c", "b"])
    expect(names(sortRows(rows, null, rank))).toEqual(["b", "d", "a", "c"])
  })

  it("counts the order the rows arrive in as the default, so it shows no dot", () => {
    const arrival = { key: "status", dir: "descending" as const }
    expect(isDefaultOrder(null)).toBe(true)
    expect(isDefaultOrder(null, arrival)).toBe(true)
    expect(isDefaultOrder({ key: "status", dir: "descending" }, arrival)).toBe(true)
    expect(isDefaultOrder({ key: "status", dir: "ascending" }, arrival)).toBe(false)
    expect(isDefaultOrder({ key: "failures", dir: "descending" }, arrival)).toBe(false)
    expect(isDefaultOrder({ key: "failures", dir: "descending" })).toBe(false)
  })
})

// Instances and Agent access rank by the column they show as Status.
describe("a list ranked by its Status column (TB-1, TB-11, TB-28)", () => {
  type Row = { name: string; rank: number }
  const rows: Row[] = [
    { name: "a", rank: 0 },
    { name: "b", rank: 2 },
    { name: "c", rank: 0 },
    { name: "d", rank: 1 },
  ]
  const columns = {
    status: { label: "Status", kind: "number" as const, words: RANK_WORDS, value: (r: Row) => r.rank },
    name: { label: "Name", kind: "text" as const, value: (r: Row) => r.name },
  }
  /** What `useSort` gives the page, with the order picked given as `order`, as the page's state would hold it. */
  const sorting = (order?: SortOrder) => {
    let got: Sorting<Row> | undefined
    function Probe() {
      got = useSort(rows, { id: "ranked", rank: "status", columns, order })
      return null
    }
    renderToStaticMarkup(<Probe />)
    return got as Sorting<Row>
  }

  it("puts the highest rank first by default, then the rows as they came", () => {
    const { rows: sorted, control } = sorting()
    expect(sorted.map((r) => r.name)).toEqual(["b", "d", "a", "c"])
    expect(control.isDefault).toBe(true)
  })

  it("counts Status, needs a look first, as the default order: no dot", () => {
    const set = () => {}
    expect(sorting([{ key: "status", dir: "descending" }, set]).control.isDefault).toBe(true)
    expect(sorting([{ key: "status", dir: "ascending" }, set]).control.isDefault).toBe(false)
    expect(sorting([{ key: "name", dir: "ascending" }, set]).control.isDefault).toBe(false)
  })

  it("turns the list around on a first click on the Status header", () => {
    const picked: (SortState | null)[] = []
    sorting([null, (s) => picked.push(s)])
      .head("status")
      .toggle()
    expect(picked).toEqual([{ key: "status", dir: "ascending" }])
  })
})

describe("the Sort button (TB-28)", () => {
  const control = (state: SortControl["state"], isDefault: boolean): SortControl => ({
    state,
    isDefault,
    set: () => {},
    columns: [{ key: "name", label: "Instance", first: "ascending", words: orderWords("text") }],
  })

  it("opens a dialog, says the order in use and has no dot at the default order", () => {
    const html = renderToStaticMarkup(<SortButton control={control(null, true)} name="instances" />)
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-label="Sort: Default order"')
    expect(html).not.toContain(`data-set=""`)
  })

  it("marks an order that is not the default with a dot", () => {
    const html = renderToStaticMarkup(
      <SortButton control={control({ key: "name", dir: "descending" }, false)} name="instances" />,
    )
    expect(html).toContain('aria-label="Sort: Instance, Z to A"')
    expect(html).toContain(`data-set=""`)
  })
})
