import { ArrowLeft } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { Empty, SaveBarHost } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useIsMobile, useMediaQuery } from "@/hooks/use-mobile"
import { SPLIT_QUERY } from "@/lib/behavior"

const ITEMS_BELOW = 560
const TABLE_FROM = ITEMS_BELOW + 24

const PaneNavContext = createContext<HTMLElement | null>(null)

export function usePaneNav() {
  return useContext(PaneNavContext)
}

export function ListWithPanel({
  list,
  panel,
  panelTitle,
  onClose,
}: {
  list: React.ReactNode | ((items: boolean) => React.ReactNode)
  panel: React.ReactNode | null
  panelTitle: string
  onClose: () => void
}) {
  const wide = useMediaQuery(SPLIT_QUERY)
  const phone = useIsMobile()
  const [nav, setNav] = useState<HTMLDivElement | null>(null)
  const navigate = useNavigate()
  const { pathname, search, hash } = useLocation()
  const listRef = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)

  const measure = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el
    if (!el) return
    const check = () => {
      const style = getComputedStyle(el)
      const width = el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      setNarrow((was) => (was ? width < TABLE_FROM : width < ITEMS_BELOW))
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!wide || panel) return
    const { location } = window
    if (location.pathname !== pathname || location.search !== search || location.hash !== hash) return
    const first = listRef.current?.querySelector<HTMLElement>("[data-href]")?.dataset.href
    if (first) navigate(first, { replace: true })
  })

  const content = typeof list === "function" ? list(wide || narrow) : list

  if (!wide) {
    return (
      <>
        <div ref={measure} className="grid min-w-0 content-start gap-gap">
          {content}
        </div>
        {panel && (
          <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent
              className="md:h-[90dvh] md:max-w-[1100px]"
              data-pane-sheet=""
              aria-describedby={undefined}
              showCloseButton={false}
              pullToClose
              history={false}
              scrollPane="item"
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                ;(e.currentTarget as HTMLElement).focus()
              }}
            >
              <DialogHeader className="flex-row items-center gap-1 ps-2 pe-pad-x">
                <Button size="icon-sm" onClick={onClose} aria-label="Back">
                  <ArrowLeft />
                </Button>
                <DialogTitle>{panelTitle}</DialogTitle>
              </DialogHeader>
              <PaneNavContext.Provider value={phone ? nav : null}>
                <div className="min-w-0">{panel}</div>
              </PaneNavContext.Provider>
              <div data-slot="pane-footer" className="sticky bottom-0 z-10 -mx-pad-x mt-auto shrink-0">
                <SaveBarHost />
                {phone && (
                  <div
                    ref={setNav}
                    data-slot="pane-nav"
                    className="border-t border-line bg-popover pb-[env(safe-area-inset-bottom)] empty:hidden"
                  />
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </>
    )
  }
  return (
    <div className="absolute inset-0 short:bottom-auto">
      <ResizablePanelGroup orientation="horizontal" className="short:h-auto! short:overflow-visible!">
        <ResizablePanel defaultSize="40%" minSize="360px" className="short:overflow-visible!">
          <div
            data-scroll-pane="list"
            className="h-full min-w-0 overflow-y-auto overscroll-contain ps-[22px] pe-4 [scrollbar-gutter:stable] short:h-auto short:overflow-visible lg:ps-7"
          >
            <div ref={measure} className="grid min-w-0 auto-rows-max content-start gap-gap py-[22px]">
              {content}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="60%" minSize="30%" className="short:overflow-visible!">
          <section aria-label={panelTitle} className="flex h-full flex-col short:h-auto">
            <div
              key={pathname}
              data-scroll-pane="item"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain short:overflow-visible"
            >
              <div className="px-6 pt-[22px] pb-15">{panel ?? <Empty title="Nothing is open." />}</div>
            </div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
