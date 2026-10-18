import { ArrowLeft } from "lucide-react"
import { useEffect, useRef } from "react"
import { useLocation, useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useMediaQuery } from "@/hooks/use-mobile"

/**
 * A list with a reading pane (DS-13). From 1000px an item reads in a pane beside the list, like a mail
 * client: the list marks the open row, and with nothing open the first item opens by itself, so the pane is
 * never empty. Narrower, the list stands alone and an item opens as a dialog over it (a sheet on a phone).
 * Either way the open item is in the address, so Back and reload work.
 *
 * Rows mark their address with `data-href`; the first one is what opens by itself.
 */
export function ListWithPanel({
  list,
  panel,
  panelTitle,
  onClose,
}: {
  list: React.ReactNode
  panel: React.ReactNode | null
  panelTitle: string
  onClose: () => void
}) {
  const wide = useMediaQuery("(min-width: 1000px)")
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const listRef = useRef<HTMLDivElement>(null)

  // Open the first item on a wide screen. The address is corrected in place, so Back still leaves the page.
  useEffect(() => {
    if (!wide || panel) return
    const first = listRef.current?.querySelector<HTMLElement>("[data-href]")?.dataset.href
    if (first) navigate(first, { replace: true })
  })

  const listColumn = (
    <div ref={listRef} className="grid min-w-0 content-start gap-gap">
      {list}
    </div>
  )
  if (!panel) return listColumn
  if (!wide) {
    return (
      <>
        {listColumn}
        <Dialog open onOpenChange={(o) => !o && onClose()}>
          <DialogContent
            className="md:max-w-[1100px]"
            aria-describedby={undefined}
            showCloseButton={false}
            pullToClose
            // The open item is in the address: Back already closes it.
            history={false}
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
            <div className="min-w-0">{panel}</div>
          </DialogContent>
        </Dialog>
      </>
    )
  }
  return (
    // Fills the scrolling main area; the list and the pane scroll on their own.
    <div className="absolute inset-0">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="42%" minSize="25%">
          <div
            ref={listRef}
            data-scroll-pane
            className="grid h-full min-w-0 content-start gap-gap overflow-y-auto overscroll-contain py-[22px] ps-[22px] pe-4 lg:ps-7"
          >
            {list}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="58%" minSize="30%">
          <section aria-label={panelTitle} className="flex h-full flex-col">
            <div
              // A new item starts at its top (DS-6).
              key={pathname}
              data-scroll-pane
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-[22px] pb-15"
            >
              {panel}
            </div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
