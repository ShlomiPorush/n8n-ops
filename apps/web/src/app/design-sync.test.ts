import { afterEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/api"
import { onPageShow } from "./design-sync"

afterEach(() => vi.restoreAllMocks())

describe("onPageShow", () => {
  it("reads General again when the browser restores the page from its back/forward cache", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    onPageShow({ persisted: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/settings/general"] })
  })

  it("does nothing on a normal load", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    onPageShow({ persisted: false })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
