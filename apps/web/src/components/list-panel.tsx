import { ArrowLeft, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useIsMobile } from "@/hooks/use-mobile"

/**
 * Variant D list page: a full-width table; when an item is selected, a resizable detail panel opens
 * beside it (the table stays visible) and closes back to the full table. On a phone or a narrow tablet the
 * panel takes the whole page with a back button instead.
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
  // Below 1024 px two panes are too narrow to read; the panel takes the page instead.
  const mobile = useIsMobile(1024)
  if (!panel) return <div className="flex-1 space-y-8 px-4 pt-2 pb-10 md:px-6">{list}</div>
  if (mobile) {
    return (
      <div className="flex-1 space-y-4 px-4 pt-2 pb-10 md:px-6">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
          <ArrowLeft /> Back
        </Button>
        {panel}
      </div>
    )
  }
  return (
    <div className="h-[calc(100svh-3.5rem)] min-h-0 md:h-[calc(100svh-4.5rem)]">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="42%" minSize="25%">
          <div className="h-full space-y-8 overflow-auto px-6 pt-2 pb-10">{list}</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="58%" minSize="30%">
          <div data-slot="detail-panel" className="flex h-full flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center gap-2 px-6">
              <span className="text-sm font-medium text-muted-foreground">{panelTitle}</span>
              <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onClose} aria-label="Close panel">
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-auto px-6 pt-2 pb-10">{panel}</div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
