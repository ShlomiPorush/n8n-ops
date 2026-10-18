import { afterEach, describe, expect, it, vi } from "vitest"
import { queryClient, readFresh } from "@/lib/api"
import { afterGeneralSave, onPageShow, readAgain } from "./design-sync"

vi.mock("@/lib/design", () => ({ applyDesign: vi.fn() }))

const GENERAL = "/settings/general"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  queryClient.clear()
})

describe("onPageShow", () => {
  it("reads General again when the browser restores the page from its back/forward cache", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    onPageShow({ persisted: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [GENERAL] })
  })

  it("does nothing on a normal load", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    onPageShow({ persisted: false })
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe("the design in the cache", () => {
  const read = () => queryClient.fetchQuery({ queryKey: [GENERAL], queryFn: () => readFresh(GENERAL) })

  it("keeps a saved design when a read from before the save answers late, and when the next read fails", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    )
    queryClient.setQueryData([GENERAL], { design: "regular", timezone: "UTC" })
    const late = read()
    // The save: what the form sent goes into the cache at once, and the path is marked as saved.
    readAgain()
    afterGeneralSave({ design: "compact" })
    answer(new Response(JSON.stringify({ design: "regular", timezone: "UTC" })))
    await late.catch(() => {})
    expect(queryClient.getQueryData([GENERAL])).toEqual({ design: "compact", timezone: "UTC" })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    )
    await read().catch(() => {})
    expect(queryClient.getQueryData([GENERAL])).toEqual({ design: "compact", timezone: "UTC" })
  })

  it("coming back to a tab does not trust a read that started before", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    )
    queryClient.setQueryData([GENERAL], { design: "compact" })
    const before = readFresh(GENERAL)
    readAgain()
    answer(new Response(JSON.stringify({ design: "regular" })))
    expect(await before).toEqual({ design: "compact" })
  })
})
