import type { QueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { api, queryClient } from "./api"
import { ATTENTION_PATH } from "./attention"

const changed = (topics: string[]) => (key: unknown) =>
  typeof key === "string" && topics.some((t) => key.startsWith(`/${t}`))

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

const EVERY_TOPIC = ["problems", "instances", "backups", "workflows", "workers", "overview", "access"]

export function useLiveUpdates() {
  useEffect(() => {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let missed = false
    const refresh = (topics: string[]) =>
      void invalidateTopics(queryClient, topics, document.visibilityState === "hidden")
    const connect = () => {
      source = new EventSource("/api/events")
      source.addEventListener("change", (event) => {
        refresh(JSON.parse((event as MessageEvent<string>).data) as string[])
      })
      source.addEventListener("ready", () => {
        if (missed) refresh(EVERY_TOPIC)
        missed = false
      })
      source.onerror = () => {
        missed = true
        source?.close()
        void api("/session").catch(() => {})
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
