import * as React from "react"
import { createPortal } from "react-dom"
import { useMediaQuery } from "@/hooks/use-mobile"

/*
 * What a page hands to the shell around it (NL-5, NL-6): on wide screens its actions move up into the top bar,
 * beside the page title, and an opened item adds its name to the trail ("Problems › Sync orders"), which
 * also names the browser tab (NL-3).
 */

type Chrome = {
  actionsSlot: HTMLElement | null
  setCrumb: (id: number, label: string | null) => void
}

export const ChromeContext = React.createContext<Chrome>({ actionsSlot: null, setCrumb: () => {} })

let crumbSeq = 0

/** Adds the opened item's name to the trail while the calling component shows it. */
export function useCrumb(label: string | null | undefined) {
  const { setCrumb } = React.useContext(ChromeContext)
  const id = React.useMemo(() => ++crumbSeq, [])
  React.useEffect(() => {
    setCrumb(id, label ?? null)
  }, [setCrumb, id, label])
  React.useEffect(() => () => setCrumb(id, null), [setCrumb, id])
}

/** The top bar exists from 761px; below that the page keeps its own title row. */
export const useTopBar = () => useMediaQuery("(min-width: 761px)")

/** Page actions: in the top bar on wide screens, on the title row on a phone. */
export function PageActions({ children }: { children: React.ReactNode }) {
  const { actionsSlot } = React.useContext(ChromeContext)
  const wide = useTopBar()
  if (wide && actionsSlot) return createPortal(children, actionsSlot)
  return wide ? null : <>{children}</>
}
