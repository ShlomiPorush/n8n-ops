import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

/**
 * Variant D list page: a full-width table; when an item is selected, a resizable detail panel opens
 * beside it (the table stays visible) and closes back to the full table.
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
  if (!panel) return <div className="flex-1 space-y-6 p-6">{list}</div>
  return (
    <div className="h-[calc(100svh-3.5rem)] min-h-0 md:h-[calc(100svh-4.5rem)]">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="42%" minSize="25%">
          <div className="h-full space-y-6 overflow-auto p-6">{list}</div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="58%" minSize="30%">
          <div className="flex h-full flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <span className="text-sm font-medium text-muted-foreground">{panelTitle}</span>
              <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onClose} aria-label="Close panel">
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-6">{panel}</div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
