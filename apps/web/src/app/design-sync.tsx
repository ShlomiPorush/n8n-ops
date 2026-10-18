import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { markSaved, queryClient, readFresh } from "@/lib/api"
import { applyDesign } from "@/lib/design"

/*
 * Keeps the page in the design chosen in Settings → General. The server writes the choice on <html> before
 * the page draws (so the sign-in and setup pages, which never read General, have it too); while signed in,
 * this follows the setting: after a save here at once, in another tab when it comes back to the front, and
 * after the browser restores a page from its back/forward cache. Nothing reloads, so dialogs and edits stay.
 */
const GENERAL = "/settings/general"

export function DesignSync() {
  const general = useQuery({
    queryKey: [GENERAL],
    queryFn: () => readFresh<{ design?: string }>(GENERAL),
    staleTime: 5 * 60_000,
    // Coming back to the tab is handled below, so it never joins a read that started before.
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

/**
 * Reads General again from scratch: a read still on its way may have started before another tab saved, so
 * its answer is not trusted and a new read replaces it.
 */
let lastRead = 0
export function readAgain(now = Date.now()) {
  // Coming back to a tab fires focus and visibilitychange together; one read is enough.
  if (now - lastRead < 1000) return
  lastRead = now
  markSaved(GENERAL)
  void queryClient.invalidateQueries({ queryKey: [GENERAL] })
}

/** A page restored from the back/forward cache reads General again; its design may have changed meanwhile. */
export function onPageShow(e: Pick<PageTransitionEvent, "persisted">) {
  if (e.persisted) readAgain()
}

/**
 * After General was saved: the cache takes the saved values (the server answers the save with no body), and
 * the design shows at once. The refetch that follows the save brings the server's own values.
 */
export function afterGeneralSave(sent: Record<string, unknown>) {
  queryClient.setQueryData<Record<string, unknown>>([GENERAL], (old) => ({ ...old, ...sent }))
  applyDesign(sent.design)
}
