import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import * as React from "react"
import { chipClass } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

/*
 * A row of chips for one filter. With `segmented` it is a setting's few short choices instead (FS-14): Compact
 * draws a segmented control, a tinted track with the chosen segment raised as a pill on the page colour, so a
 * setting never looks like a filter; Regular keeps its look.
 */
const segmentedGroup = "compact:gap-0.5 compact:rounded-sm compact:bg-ink/8 compact:p-0.5"
const segmentedItem =
  "compact:h-7 compact:rounded-tag compact:border-transparent compact:bg-transparent compact:px-2.5 compact:text-small compact:font-semibold compact:text-muted-foreground compact:hover:border-transparent compact:hover:text-ink compact:data-[state=on]:border-transparent compact:data-[state=on]:bg-bg compact:data-[state=on]:text-ink compact:data-[state=on]:shadow-segment"

const Segmented = React.createContext(false)

function ToggleGroup({
  className,
  segmented = false,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & { segmented?: boolean }) {
  return (
    <Segmented.Provider value={segmented}>
      <ToggleGroupPrimitive.Root
        data-slot="toggle-group"
        className={cn("flex w-fit flex-row flex-wrap items-center gap-1.5", segmented && segmentedGroup, className)}
        {...props}
      />
    </Segmented.Provider>
  )
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  const segmented = React.useContext(Segmented)
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(chipClass, segmented && segmentedItem, className)}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
