import { focusManager, InfiniteQueryObserver, onlineManager, QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type EndedCursor, type EndedPage, endedPath, HISTORY_KEY, historyOptions } from "./use-access-history.ts"

afterEach(() => {
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
})

type Row = { id: string }
/** Three pages of ended requests, as the server gives them, and every read of them with its signal. */
function server() {
  const pages: Record<string, EndedPage<Row>> = {
    first: { requests: [{ id: "a" }], next: { at: "2026-11-16T08:00:00.000002Z", id: "a" } },
    a: { requests: [{ id: "b" }], next: { at: "2026-11-16T08:00:00.000001Z", id: "b" } },
    b: { requests: [{ id: "c" }], next: null },
  }
  const reads: { cursor: EndedCursor | null; signal: AbortSignal }[] = []
  let hold: Promise<void> | null = null
  const queryFn = async ({ pageParam, signal }: { pageParam: EndedCursor | null; signal: AbortSignal }) => {
    reads.push({ cursor: pageParam, signal })
    if (hold) await hold
    signal.throwIfAborted()
    const page = pages[pageParam?.id ?? "first"]
    if (!page) throw new Error("no such page")
    return page
  }
  return { pages, reads, queryFn, holdUntil: (p: Promise<void>) => (hold = p) }
}

function watch(queryFn: ReturnType<typeof server>["queryFn"]) {
  const client = new QueryClient()
  client.mount()
  const observer = new InfiniteQueryObserver(client, { ...historyOptions<Row>(), queryFn })
  const stop = observer.subscribe(() => {})
  return { client, observer, stop }
}

describe("the history of ended access requests", () => {
  it("asks for each page after the exact cursor the previous page gave", () => {
    expect(endedPath(null)).toBe("/access/ended")
    expect(endedPath({ at: "2026-11-16T08:00:00.123456Z", id: "x" })).toBe(
      "/access/ended?before=2026-11-16T08%3A00%3A00.123456Z&beforeId=x",
    )
  })

  it("is never read by itself: not when shown, on focus, or back online", async () => {
    const s = server()
    const { client, stop } = watch(s.queryFn)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await client.invalidateQueries()
    await new Promise((r) => setTimeout(r, 10))
    expect(s.reads).toEqual([])
    stop()
    client.unmount()
  })

  it("reads its pages only when asked, and every loaded page again from the newest", async () => {
    const s = server()
    const { client, observer, stop } = watch(s.queryFn)
    await observer.refetch()
    await observer.fetchNextPage()
    await observer.fetchNextPage()
    expect(observer.getCurrentResult().data?.pages.flatMap((p) => p.requests.map((r) => r.id))).toEqual(["a", "b", "c"])
    expect(observer.getCurrentResult().hasNextPage).toBe(false)
    // A new request ended before "a": read again, the pages follow the new cursors.
    s.pages.first = { requests: [{ id: "n" }], next: { at: "2026-11-16T08:00:00.000003Z", id: "n" } }
    s.pages.n = { requests: [{ id: "a" }], next: { at: "2026-11-16T08:00:00.000002Z", id: "a" } }
    s.reads.length = 0
    await observer.refetch()
    expect(s.reads.map((r) => r.cursor?.id ?? null)).toEqual([null, "n", "a"])
    expect(observer.getCurrentResult().data?.pages.flatMap((p) => p.requests.map((r) => r.id))).toEqual(["n", "a", "b"])
    expect(observer.getCurrentResult().hasNextPage).toBe(true)
    stop()
    client.unmount()
  })

  it("keeps a failed page as a failure and does not ask for it again by itself", async () => {
    const s = server()
    const { client, observer, stop } = watch(s.queryFn)
    await observer.refetch()
    delete s.pages.a
    const failed = await observer.fetchNextPage()
    expect(failed.isError && failed.isFetchNextPageError).toBe(true)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(s.reads).toHaveLength(2)
    stop()
    client.unmount()
  })

  it("calls off a read still running and is dropped when the page is left", async () => {
    const s = server()
    const { client, observer, stop } = watch(s.queryFn)
    let release = () => {}
    s.holdUntil(new Promise<void>((r) => (release = r)))
    void observer.refetch()
    await vi.waitFor(() => expect(s.reads).toHaveLength(1))
    stop()
    expect(s.reads[0]?.signal.aborted).toBe(true)
    release()
    await vi.waitFor(() => expect(client.getQueryCache().find({ queryKey: HISTORY_KEY })).toBeUndefined())
    client.unmount()
  })
})
