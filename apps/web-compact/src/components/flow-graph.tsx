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
    return (
      <p className="px-pad-x pb-pad-x text-muted-foreground">
        The workflow structure is not available for this failure.
      </p>
    )
  const columns = Math.max(...nodes.map((n) => n.column)) + 1
  return (
    <div ref={scroller} className="relative overflow-x-auto px-pad-x pt-1 pb-pad-x">
      <div className="flex min-w-max items-center">
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
                        "mx-auto mb-1.5 grid min-h-14 w-28 place-items-center rounded-sm border bg-bg px-1 text-meta font-semibold break-all text-muted-foreground",
                        n.state === "ok" && "border-line",
                        n.state === "failed" && "tint-fail border-2 border-fail",
                      )}
                    >
                      {n.type}
                    </div>
                    <div dir="auto" className="text-meta leading-tight break-words">
                      {n.name}
                    </div>
                    {n.state === "failed" && <div className="text-meta font-bold text-fail">failed here</div>}
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
