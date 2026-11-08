import { type AccessChannel, accessChannelLabels, accessChannels } from "@n8n-ops/shared"
import { Plus, X } from "lucide-react"
import { useRef } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/**
 * A field that holds some of a fixed set of channels as chips, such as where agent access requests go: × removes
 * one (`Remove <channel>`), and Add lists the channels not chosen yet. The chips keep the set's order, so the same
 * choice always reads, and saves, the same. Drawn like `ChipsInput`: v3 chips in Compact, rounded tags in Regular.
 */
export function ChannelsInput({
  id,
  label,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  id: string
  /** The field's name, for the group and the Add button. */
  label: string
  value: string[]
  onChange: (value: AccessChannel[]) => void
  disabled?: boolean
  /** The field failed its check before a save (SV-1). */
  invalid?: boolean
  describedBy?: string
}) {
  const box = useRef<HTMLFieldSetElement>(null)
  const chosen = accessChannels.filter((c) => value.includes(c))
  const addable = accessChannels.filter((c) => !value.includes(c))
  return (
    <fieldset
      ref={box}
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      // The save bar puts the focus here to show a problem (SV-1).
      tabIndex={-1}
      data-slot="channels-input"
      className={cn(
        "flex min-h-ctl w-full min-w-0 flex-wrap items-center gap-1.5 rounded-sm border border-input bg-bg px-1.5 py-1 outline-none transition-colors duration-150 focus-within:border-primary",
        invalid && "border-fail",
      )}
    >
      {chosen.map((c) => (
        <span
          key={c}
          className="inline-flex items-center gap-0.5 rounded-tag bg-fill py-0.5 ps-2 pe-0.5 font-mono text-meta text-ink regular:rounded-full regular:bg-raise regular:font-sans regular:font-medium regular:ring-1 regular:ring-line regular:ring-inset"
        >
          {accessChannelLabels[c]}
          <button
            type="button"
            title="Remove"
            aria-label={`Remove ${accessChannelLabels[c]}`}
            disabled={disabled}
            onClick={() => {
              onChange(chosen.filter((v) => v !== c))
              box.current?.focus()
            }}
            className="grid size-5 shrink-0 place-items-center rounded-tag text-muted-foreground hover:bg-ink/10 hover:text-ink regular:rounded-full"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {!chosen.length && <span className="px-1.5 text-body text-muted-foreground">None</span>}
      {addable.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Add to ${label}`}>
              <Plus /> Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {addable.map((c) => (
              <DropdownMenuItem
                key={c}
                onSelect={() => onChange(accessChannels.filter((v) => v === c || chosen.includes(v)))}
              >
                {accessChannelLabels[c]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </fieldset>
  )
}
