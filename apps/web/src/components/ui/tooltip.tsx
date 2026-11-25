import { Tooltip as TooltipPrimitive } from "radix-ui"
import * as React from "react"
import { tapTip } from "@/lib/tap-tip"
import { cn } from "@/lib/utils"

function TooltipProvider({ delayDuration = 200, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 w-fit max-w-xs rounded-sm bg-ink px-2.5 py-1.5 text-meta font-medium break-words text-bg shadow-float duration-[120ms] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

const InControl = React.createContext(false)

function TipInControl({ children }: { children: React.ReactNode }) {
  return <InControl.Provider value>{children}</InControl.Provider>
}

function Tip({
  content,
  children,
  side,
}: {
  content: React.ReactNode
  children: React.ReactElement
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
}) {
  const inControl = React.useContext(InControl)
  const [open, setOpen] = React.useState(false)
  const [tap] = React.useState(() => tapTip(setOpen))
  React.useEffect(() => tap.stop, [tap])
  const [trigger, setTrigger] = React.useState<HTMLElement | null>(null)

  React.useEffect(() => {
    const control = inControl ? trigger?.closest<HTMLElement>("a, button") : null
    if (!control) return
    const focus = () => control.matches(":focus-visible") && setOpen(true)
    const blur = () => setOpen(false)
    control.addEventListener("focus", focus)
    control.addEventListener("blur", blur)
    return () => {
      control.removeEventListener("focus", focus)
      control.removeEventListener("blur", blur)
    }
  }, [inControl, trigger])

  return (
    <Tooltip open={open} onOpenChange={(next) => (next || !tap.held()) && setOpen(next)}>
      {inControl ? (
        <>
          <TooltipTrigger asChild ref={setTrigger}>
            {children}
          </TooltipTrigger>
          <span className="sr-only">, {content}</span>
        </>
      ) : (
        <TooltipTrigger
          asChild
          tabIndex={0}
          onPointerUp={(e) => tap.press(e.pointerType)}
          onClick={(e) => {
            if (!tap.click()) return
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {children}
        </TooltipTrigger>
      )}
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  )
}

export { Tip, TipInControl, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
