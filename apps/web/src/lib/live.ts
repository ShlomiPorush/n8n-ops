import type { QueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { queryClient } from "./api"
import { ATTENTION_PATH } from "./attention"

const changed = (topics: string[]) => (key: unknown) =>
  typeof key === "string" && topics.some((t) => key.startsWith(`/${t}`))

/**
 * Marks the queries of the changed areas stale and reads the shown ones again. Needs attention, which every page
 * holds, is not read in a hidden browser tab (NL-19): it is only marked stale there, and React Query reads it again
 * when the tab is shown (`refetchOnWindowFocus`, which follows `visibilitychange`).
 */
export function invalidateTopics(client: QueryClient, topics: string[], hidden: boolean): Promise<unknown> {
  const hit = changed(topics)
  const attention = (key: unknown) => key === ATTENTION_PATH
  return Promise.all([
    client.invalidateQueries({ predicate: (q) => hit(q.queryKey[0]) && !(hidden && attention(q.queryKey[0])) }),
    hidden &&
      client.invalidateQueries({
        predicate: (q) => hit(q.queryKey[0]) && attention(q.queryKey[0]),
        refetchType: "none",
      }),
  ])
}

/** Refetches the queries of the areas the server reports as changed (server-sent events on /api/events). */
export function useLiveUpdates() {
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      source = new EventSource("/api/events")
      source.addEventListener("change", (event) => {
        const topics = JSON.parse((event as MessageEvent<string>).data) as string[]
        void invalidateTopics(queryClient, topics, document.visibilityState === "hidden")
      })
      source.onerror = () => {
        source?.close()
        retry = setTimeout(connect, 5_000)
      }
    }
    connect()
    return () => {
      source?.close()
      if (retry) clearTimeout(retry)
    }
  }, [])
}
