import * as React from "react"
import { createPortal } from "react-dom"
import { useMediaQuery } from "@/hooks/use-mobile"

type Chrome = {
  actionsSlot: HTMLElement | null
  setCrumb: (id: number, label: string | null) => void
}

export const ChromeContext = React.createContext<Chrome>({ actionsSlot: null, setCrumb: () => {} })

let crumbSeq = 0

export function useCrumb(label: string | null | undefined) {
  const { setCrumb } = React.useContext(ChromeContext)
  const id = React.useMemo(() => ++crumbSeq, [])
  React.useEffect(() => {
    setCrumb(id, label ?? null)
  }, [setCrumb, id, label])
  React.useEffect(() => () => setCrumb(id, null), [setCrumb, id])
}

export const useTopBar = () => useMediaQuery("(min-width: 761px)")

export function PageActions({ children }: { children: React.ReactNode }) {
  const { actionsSlot } = React.useContext(ChromeContext)
  const wide = useTopBar()
  if (wide && actionsSlot) return createPortal(children, actionsSlot)
  return wide ? null : <>{children}</>
}
