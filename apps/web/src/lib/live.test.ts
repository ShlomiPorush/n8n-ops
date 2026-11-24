import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ATTENTION_PATH } from "./attention.ts"
import { invalidateTopics } from "./live.ts"

afterEach(() => {
  focusManager.setFocused(undefined)
})

async function shown() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.mount()
  const reads = { attention: 0, instances: 0 }
  const watch = (key: string, count: () => void) =>
    new QueryObserver(client, {
      queryKey: [key],
      queryFn: async () => {
        count()
        return {}
      },
    }).subscribe(() => {})
  const stops = [watch(ATTENTION_PATH, () => reads.attention++), watch("/instances", () => reads.instances++)]
  await vi.waitFor(() => expect(reads).toEqual({ attention: 1, instances: 1 }))
  return {
    client,
    reads,
    done: () => {
      for (const stop of stops) stop()
      client.unmount()
    },
  }
}

describe("live updates (NL-19)", () => {
  it("read Needs attention again at once in a shown browser tab", async () => {
    const { client, reads, done } = await shown()
    await invalidateTopics(client, ["overview", "instances"], false)
    expect(reads).toEqual({ attention: 2, instances: 2 })
    done()
  })

  it("only mark Needs attention stale in a hidden tab, and read it when the tab is shown again", async () => {
    const { client, reads, done } = await shown()
    focusManager.setFocused(false)
    await invalidateTopics(client, ["overview", "instances"], true)
    expect(reads).toEqual({ attention: 1, instances: 2 })
    expect(client.getQueryState([ATTENTION_PATH])?.isInvalidated).toBe(true)

    focusManager.setFocused(true)
    await vi.waitFor(() => expect(reads.attention).toBe(2))
    done()
  })

  it("leave Needs attention alone when its area did not change", async () => {
    const { client, reads, done } = await shown()
    await invalidateTopics(client, ["instances"], true)
    expect(client.getQueryState([ATTENTION_PATH])?.isInvalidated).toBe(false)
    expect(reads).toEqual({ attention: 1, instances: 2 })
    done()
  })
})
