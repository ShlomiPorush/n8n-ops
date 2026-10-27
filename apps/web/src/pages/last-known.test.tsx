import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LastKnown } from "./instances.tsx"

describe("the last known health beside Unknown", () => {
  it("says what the last reading found", () => {
    const html = renderToStaticMarkup(
      <LastKnown
        instance={{ lastKnownHealth: "warn", lastKnownAt: null, healthDetail: { backlogActive: true, workers: [] } }}
      />,
    )
    expect(html).toContain(">Last known: Queue backlog</span>")
  })

  it("keeps to general words when a check that was not collected replaced the reading's detail", () => {
    const html = renderToStaticMarkup(
      <LastKnown
        instance={{ lastKnownHealth: "warn", lastKnownAt: null, healthDetail: { notCollected: "timeout" } }}
      />,
    )
    expect(html).toContain(">Last known: Needs a look</span>")
  })

  it("shows nothing when no check read the instance", () => {
    expect(
      renderToStaticMarkup(<LastKnown instance={{ lastKnownHealth: null, lastKnownAt: null, healthDetail: null }} />),
    ).toBe("")
  })
})
