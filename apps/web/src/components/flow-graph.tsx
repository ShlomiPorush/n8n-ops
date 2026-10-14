import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

export type GraphNode = { name: string; type: string; state: "ok" | "failed" | "skipped"; column: number }

/** The workflow drawn left to right by depth, with the failed node highlighted (requirement Q35: drawn by us). */
export function FlowGraph({ nodes }: { nodes: GraphNode[] }) {
  const scroller = useRef<HTMLDivElement>(null)
  const failed = useRef<HTMLDivElement>(null)
  // On a narrow screen the failed node can be past the right edge; bring it into view.
  useEffect(() => {
    const box = scroller.current
    const node = failed.current
    if (!box || !node || !nodes.length) return
    box.scrollLeft = node.offsetLeft - box.clientWidth / 2 + node.offsetWidth / 2
  }, [nodes])
  if (!nodes.length)
    return <p className="text-sm text-muted-foreground">The workflow structure is not available for this failure.</p>
  const columns = Math.max(...nodes.map((n) => n.column)) + 1
  return (
    <div
      ref={scroller}
      className="relative overflow-x-auto rounded-lg border bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[length:16px_16px] p-5"
    >
      <div className="flex min-w-max items-center gap-0">
        {Array.from({ length: columns }, (_, col) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the column number itself
          <div key={col} className="flex items-center">
            <div className="flex flex-col gap-3">
              {nodes
                .filter((n) => n.column === col)
                .map((n) => (
                  <div
                    key={n.name}
                    ref={n.state === "failed" ? failed : undefined}
                    className={cn("w-32 text-center", n.state === "skipped" && "opacity-40")}
                  >
                    <div
                      className={cn(
                        "mx-auto mb-1.5 grid min-h-14 w-28 place-items-center rounded-lg border-2 bg-card px-1 text-[11px] font-semibold break-all",
                        n.state === "ok" && "border-emerald-500/60",
                        n.state === "failed" &&
                          "border-destructive bg-destructive/10 text-destructive ring-4 ring-destructive/15",
                      )}
                    >
                      {n.type}
                    </div>
                    <div className="text-xs leading-tight break-words">{n.name}</div>
                    {n.state === "failed" && (
                      <div className="text-[11px] font-medium text-destructive">failed here</div>
                    )}
                  </div>
                ))}
            </div>
            {col < columns - 1 && <div className="mx-1 h-px w-6 bg-muted-foreground/50" />}
          </div>
        ))}
      </div>
    </div>
  )
}
