import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FieldPicker } from "./field-picker.tsx"

const options = [
  { value: "none", label: "None" },
  { value: "w1", label: "E2E Host" },
]

describe("a choice in a form (MP-1)", () => {
  it("is a button that opens a list and is named by its field and its value", () => {
    const html = renderToStaticMarkup(
      <FieldPicker id="worker" label="Worker" value="w1" options={options} onChange={() => {}} />,
    )
    expect(html).toMatch(/^<button[^>]*id="worker"/)
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Worker: E2E Host"')
    expect(html).toContain(">E2E Host</span>")
  })

  it("shows its placeholder, muted, while nothing is chosen, and can be locked", () => {
    const html = renderToStaticMarkup(
      <FieldPicker
        label="Workflow"
        placeholder="Choose a workflow"
        value=""
        options={options}
        onChange={() => {}}
        disabled
      />,
    )
    expect(html).toContain('aria-label="Workflow: Choose a workflow"')
    expect(html).toMatch(/<span class="[^"]*text-muted-foreground[^"]*">Choose a workflow<\/span>/)
    expect(html).toContain('disabled=""')
  })

  it("does not build a list made on opening while it is closed, and says the value it is given", () => {
    let built = 0
    const make = () => {
      built += 1
      return options
    }
    const html = renderToStaticMarkup(
      <FieldPicker
        label="Time zone"
        value="w1"
        options={make}
        onChange={() => {}}
        display={{ text: "Asia/Jerusalem (UTC+03:00)", node: "Asia/Jerusalem" }}
      />,
    )
    expect(built).toBe(0)
    expect(html).toContain('aria-label="Time zone: Asia/Jerusalem (UTC+03:00)"')
  })
})
