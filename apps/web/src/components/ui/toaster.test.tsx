import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { currentToast } from "@/lib/toast"
import { Toaster } from "./toaster.tsx"

describe("the toast's wrapper (DS-8)", () => {
  it("is there while no toast shows, so a layer opened meanwhile leaves it usable for the next toast", () => {
    expect(currentToast()).toBeNull()
    const html = renderToStaticMarkup(<Toaster />)
    expect(html).toMatch(/^<div data-slot="toaster"[^>]*><\/div>$/)
  })
})
