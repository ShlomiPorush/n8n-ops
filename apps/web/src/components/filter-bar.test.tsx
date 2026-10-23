import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FilterBar } from "./filter-bar.tsx"

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
