import { useEffect } from "react"
import { queryClient } from "./api"

/** Refetches the queries of the areas the server reports as changed (server-sent events on /api/events). */
export function useLiveUpdates() {
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      source = new EventSource("/api/events")
      source.addEventListener("change", (event) => {
        const topics = JSON.parse((event as MessageEvent<string>).data) as string[]
        void queryClient.invalidateQueries({
          predicate: (q) => {
            const key = q.queryKey[0]
            return typeof key === "string" && topics.some((t) => key.startsWith(`/${t}`))
          },
        })
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
