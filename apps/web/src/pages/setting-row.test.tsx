import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SettingRow } from "./settings.tsx"

const times = (html: string, text: string) => html.split(text).length - 1

describe("a setting row's Reset (FS-6)", () => {
  const reset = (
    <button type="button" data-reset>
      Reset to default (On)
    </button>
  )

  it("shows once on a switch row, outside its label, so it is one button and one Tab stop", () => {
    const html = renderToStaticMarkup(
      <SettingRow htmlFor="health" label="Instance or queue worker down" inline changed action={reset}>
        <input id="health" type="checkbox" />
      </SettingRow>,
    )
    expect(times(html, "data-reset")).toBe(1)
    // The label holds the text and the switch, not the action: pressing Reset never flips the switch.
    const label = html.slice(html.indexOf("<label"), html.indexOf("</label>"))
    expect(label).not.toContain("data-reset")
  })

  it("shows once under the explanation on any other row", () => {
    const html = renderToStaticMarkup(
      <SettingRow htmlFor="retryMin" label="Retry failed sends every (minutes)" changed action={reset}>
        <input id="retryMin" />
      </SettingRow>,
    )
    expect(times(html, "data-reset")).toBe(1)
  })
})
