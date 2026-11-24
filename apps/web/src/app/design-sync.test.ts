import { QueryObserver } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api, queryClient } from "@/lib/api"
import { afterGeneralSave, onPageShow, readAgain } from "./design-sync"

vi.mock("@/lib/design", () => ({ applyDesign: vi.fn() }))

const GENERAL = "/settings/general"

// readAgain runs at most once a second; each test starts a little later than the last.
let clock = Date.now()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  clock += 10_000
  vi.setSystemTime(clock)
})

afterEach(() => {
  vi.useRealTimers()
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
  const read = () => queryClient.fetchQuery({ queryKey: [GENERAL], queryFn: () => api(GENERAL) })
  const onScreen = () => new QueryObserver(queryClient, { queryKey: [GENERAL], queryFn: () => api(GENERAL) })

  it("keeps a saved design when a read from before the save answers late, and when the next read fails", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    )
    queryClient.setQueryData([GENERAL], { design: "regular", timezone: "UTC" })
    const late = read()
    // The save: what the form sent goes into the cache at once, and the read on its way is called off.
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

  it("with nothing cached yet, a read that a save overtook reads again instead of answering old", async () => {
    const answers = [{ design: "regular" }, { design: "compact" }]
    let first: (r: Response) => void = () => {}
    const fetch = vi.fn((): Promise<Response> => {
      const body = answers.shift()
      if (fetch.mock.calls.length === 1)
        return new Promise((done) => (first = () => done(new Response(JSON.stringify(body)))))
      return Promise.resolve(new Response(JSON.stringify(body)))
    })
    vi.stubGlobal("fetch", fetch)
    const observer = onScreen()
    const stop = observer.subscribe(() => {})
    readAgain()
    first(new Response(""))
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ design: "compact" }))
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it("reads once when focus and visibility arrive together", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    readAgain()
    readAgain()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("coming back to a tab does not trust a read that started before", async () => {
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((done) => (answer = done))),
    )
    queryClient.setQueryData([GENERAL], { design: "compact" })
    const before = read().catch(() => {})
    readAgain()
    answer(new Response(JSON.stringify({ design: "regular" })))
    await before
    expect(queryClient.getQueryData([GENERAL])).toEqual({ design: "compact" })
  })
})
