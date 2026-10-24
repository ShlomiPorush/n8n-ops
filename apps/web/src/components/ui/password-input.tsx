import { Eye, EyeOff } from "lucide-react"
import { useId, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * A password field that helps the user (FS-23): a button inside it shows what was typed and leaves the focus
 * in the field, and a note linked to the field says when Caps Lock is on, read from keys and from clicks.
 */
export function PasswordInput({
  className,
  onKeyDown,
  onKeyUp,
  onMouseDown,
  onBlur,
  "aria-describedby": describedBy,
  ...props
}: React.ComponentProps<"input">) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const note = useId()
  const check = (e: React.KeyboardEvent | React.MouseEvent) => setCaps(e.getModifierState?.("CapsLock") ?? false)
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Input
          {...props}
          type={shown ? "text" : "password"}
          aria-describedby={[describedBy, caps && note].filter(Boolean).join(" ") || undefined}
          className={cn("pe-10", className)}
          onKeyDown={(e) => {
            check(e)
            onKeyDown?.(e)
          }}
          onKeyUp={(e) => {
            check(e)
            onKeyUp?.(e)
          }}
          onMouseDown={(e) => {
            check(e)
            onMouseDown?.(e)
          }}
          onBlur={(e) => {
            setCaps(false)
            onBlur?.(e)
          }}
        />
        <button
          type="button"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          title={shown ? "Hide password" : "Show password"}
          // The field keeps the focus, so typing goes on after a look.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((s) => !s)}
          className="absolute end-1 top-1/2 grid size-ctl-sm -translate-y-1/2 place-items-center rounded-sm text-muted-foreground [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:hover:text-ink"
        >
          {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
        </button>
      </div>
      {caps && (
        <p id={note} role="status" className="text-small font-semibold text-warn">
          Caps Lock is on.
        </p>
      )}
    </div>
  )
}
