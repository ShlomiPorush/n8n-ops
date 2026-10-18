import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { queryClient, readFresh } from "@/lib/api"
import { applyDesign } from "@/lib/design"

/*
 * Keeps the page in the design chosen in Settings → General. The server writes the choice on <html> before
 * the page draws (so the sign-in and setup pages, which never read General, have it too); while signed in,
 * this follows the setting: after a save here at once, in another tab when it is focused again, and after
 * the browser restores a page from its back/forward cache. Nothing reloads, so dialogs and edits stay.
 */
const GENERAL = "/settings/general"

export function DesignSync() {
  const general = useQuery({
    queryKey: [GENERAL],
    queryFn: () => readFresh<{ design?: string }>(GENERAL),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: "always",
  })
  const design = general.data?.design
  useEffect(() => applyDesign(design), [design])
  useEffect(() => {
    window.addEventListener("pageshow", onPageShow)
    return () => window.removeEventListener("pageshow", onPageShow)
  }, [])
  return null
}

/** A page restored from the back/forward cache asks for General again; its design may have changed meanwhile. */
export function onPageShow(e: Pick<PageTransitionEvent, "persisted">) {
  if (e.persisted) void queryClient.invalidateQueries({ queryKey: [GENERAL] })
}

/**
 * After General was saved: the cache takes the saved values (the server answers the save with no body), and
 * the design shows at once. The refetch that follows the save brings the server's own values.
 */
export function afterGeneralSave(sent: Record<string, unknown>) {
  queryClient.setQueryData<Record<string, unknown>>([GENERAL], (old) => ({ ...old, ...sent }))
  applyDesign(sent.design)
}
