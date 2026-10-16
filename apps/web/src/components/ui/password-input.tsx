import { Eye, EyeOff } from "lucide-react"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * A password field that helps the user (FS-23): a button shows what was typed, and a note says when Caps
 * Lock is on while typing.
 */
export function PasswordInput({ className, onKeyDown, onKeyUp, onBlur, ...props }: React.ComponentProps<"input">) {
  const [shown, setShown] = useState(false)
  const [caps, setCaps] = useState(false)
  const check = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false)
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Input
          {...props}
          type={shown ? "text" : "password"}
          className={cn("pe-10", className)}
          onKeyDown={(e) => {
            check(e)
            onKeyDown?.(e)
          }}
          onKeyUp={(e) => {
            check(e)
            onKeyUp?.(e)
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
          onClick={() => setShown((s) => !s)}
          className="absolute end-1 top-1/2 grid size-ctl-sm -translate-y-1/2 place-items-center rounded-sm text-muted-foreground [@media(hover:hover)]:hover:bg-accent [@media(hover:hover)]:hover:text-ink"
        >
          {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
        </button>
      </div>
      {caps && (
        <p role="status" className="text-small font-semibold text-warn">
          Caps Lock is on.
        </p>
      )}
    </div>
  )
}
