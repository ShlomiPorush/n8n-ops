import { ArrowLeft } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { Empty, SaveBarHost } from "@/components/kit"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useIsMobile, useMediaQuery } from "@/hooks/use-mobile"
import { SPLIT_QUERY } from "@/lib/behavior"

/** Below this content width a list draws its rows as items; a little more is needed to go back (no flicker). */
const ITEMS_BELOW = 560
const TABLE_FROM = ITEMS_BELOW + 24

const PaneNavContext = createContext<HTMLElement | null>(null)

/**
 * Where an item opened as a phone sheet puts its own tabs: a bar at the bottom of the sheet, in reach of the
 * thumb, like the app's tab bar. Null anywhere else, where the tabs stay at the top of the item.
 */
export function usePaneNav() {
  return useContext(PaneNavContext)
}

/**
 * A list with a reading pane (DS-13). From 1000px an item reads in a pane beside the list, like a mail
 * client: the list marks the open row, and with nothing open the first item opens by itself, so the pane is
 * never empty. Narrower, or on a screen 600px high or less (NL-1), the list stands alone, the page scrolls as one
 * and an item opens as a dialog over it (a sheet on a phone).
 * Either way the open item is in the address, so Back and reload work.
 *
 * Beside the pane, and wherever the list is narrow, its rows are items of a few lines instead of table
 * columns, so nothing is cut off: pass `list` as a function to get that choice. On a wide screen the list
 * stays mounted while items open and close, so a focused row or field keeps its focus.
 *
 * Rows mark their address with `data-href`; the first one is what opens by itself.
 */
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
  const { pathname } = useLocation()
  const listRef = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)

  // Measure the width the rows get (the content box), and again whenever the list column is swapped.
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

  // Open the first item on a wide screen. The address is corrected in place, so Back still leaves the page.
  useEffect(() => {
    if (!wide || panel) return
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
              // A fixed height, so it does not grow and shrink with each tab (DS-16). On a phone the sheet keeps
              // four fifths of the screen whatever is open in it (index.css).
              className="md:h-[90dvh] md:max-w-[1100px]"
              data-pane-sheet=""
              aria-describedby={undefined}
              showCloseButton={false}
              pullToClose
              // The open item is in the address: Back already closes it.
              history={false}
              // The same area as the pane beside the list, so Back puts each tab where it was scrolled (NL-3).
              scrollPane="item"
              // Focus the dialog, not its Back button, so no focus ring shows before the keyboard is used.
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
              {/*
               * Sticks to the bottom of the sheet: the save bar (the sheet covers the page, so its unsaved
               * changes are saved from inside it), then the item's tabs on a phone. While either shows, the body
               * drops its own bottom padding (dialog.tsx).
               */}
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
    // Fills the scrolling main area; the list and the pane scroll on their own.
    <div className="absolute inset-0">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="40%" minSize="360px">
          <div
            ref={measure}
            data-scroll-pane="list"
            // Rows keep their full height (auto-rows-max): in a grid of fixed height a scrolling table would
            // otherwise shrink to nothing once the column is taller than the screen.
            className="grid h-full min-w-0 auto-rows-max content-start gap-gap overflow-y-auto overscroll-contain py-[22px] ps-[22px] pe-4 [scrollbar-gutter:stable] lg:ps-7"
          >
            {content}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="60%" minSize="30%">
          <section aria-label={panelTitle} className="flex h-full flex-col">
            <div
              // A new item starts at its top (DS-6).
              key={pathname}
              data-scroll-pane="item"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              {/* The padding is on the content, not on the scroller, so the item's tabs stick at its very top (DS-14). */}
              <div className="px-6 pt-[22px] pb-15">
                {/* Only an empty, failed or filtered-out list leaves nothing to open. */}
                {panel ?? <Empty title="Nothing is open." />}
              </div>
            </div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
