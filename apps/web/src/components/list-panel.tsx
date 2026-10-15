import { ArrowLeft, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useMediaQuery } from "@/hooks/use-mobile"

/**
 * A list with a reading pane. From 1280px an opened item reads in a resizable pane beside the list (the
 * list stays and marks the open row). Narrower, the list stands alone and an item opens as a full screen
 * dialog over it. Either way the open item is in the URL.
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
  const wide = useMediaQuery("(min-width: 1280px)")
  if (!panel) return <div className="grid min-w-0 content-start gap-gap">{list}</div>
  if (!wide) {
    return (
      <>
        <div className="grid min-w-0 content-start gap-gap">{list}</div>
        <Dialog open onOpenChange={(o) => !o && onClose()}>
          <DialogContent className="md:max-w-[1100px]" aria-describedby={undefined} showCloseButton={false}>
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
          <div className="grid h-full min-w-0 content-start gap-gap overflow-y-auto py-[22px] ps-7 pe-4">{list}</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="58%" minSize="30%">
          <div className="flex h-full flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line ps-pad-x pe-2">
              <span className="text-small font-semibold text-muted-foreground">{panelTitle}</span>
              <Button size="icon-sm" className="ms-auto" onClick={onClose} aria-label="Close panel">
                <X />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-15">{panel}</div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
