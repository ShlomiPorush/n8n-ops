import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { api, queryClient, readAfterSave } from "@/lib/api"
import { applyDesign } from "@/lib/design"

const GENERAL = "/settings/general"

export function DesignSync() {
  const general = useQuery({
    queryKey: [GENERAL],
    queryFn: () => api<{ design?: string }>(GENERAL),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const design = general.data?.design
  useEffect(() => applyDesign(design), [design])
  useEffect(() => {
    const onFocus = () => readAgain()
    const onVisible = () => document.visibilityState === "visible" && readAgain()
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])
  return null
}

let lastRead = 0
export function readAgain(now = Date.now()) {
  if (now - lastRead < 1000) return
  lastRead = now
  void readAfterSave({ queryKey: [GENERAL] })
}

export function onPageShow(e: Pick<PageTransitionEvent, "persisted">) {
  if (e.persisted) readAgain()
}

export function afterGeneralSave(sent: Record<string, unknown>) {
  queryClient.setQueryData<Record<string, unknown>>([GENERAL], (old) => ({ ...old, ...sent }))
  applyDesign(sent.design)
}
