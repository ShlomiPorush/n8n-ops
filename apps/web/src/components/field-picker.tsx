import { ChevronDown } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { type ReactNode, useMemo } from "react"
import { PickerContent, type PickerOption, usePicker } from "@/components/filter-bar"
import { useOverlayHistory } from "@/lib/overlay-history"
import { cn } from "@/lib/utils"

export function FieldPicker({
  id,
  label,
  listLabel = label,
  value,
  options,
  onChange,
  placeholder = "Choose…",
  display,
  disabled,
  invalid,
  describedBy,
  className,
}: {
  id?: string
  label: string
  listLabel?: string
  value: string
  options: PickerOption[] | (() => PickerOption[])
  onChange: (value: string) => void
  placeholder?: string
  display?: { node: ReactNode; text: string }
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
  className?: string
}) {
  const picker = usePicker()
  useOverlayHistory(picker.open, () => picker.setOpen(false))
  const list = useMemo(
    () => (typeof options === "function" ? (picker.open ? options() : []) : options),
    [options, picker.open],
  )
  const selected = list.find((o) => o.value === value)
  const text = display?.text ?? selected?.label
  return (
    <PopoverPrimitive.Root modal open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-controls={picker.open ? picker.id : undefined}
          aria-label={`${label}: ${text ?? placeholder}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              picker.setOpen(true)
            }
          }}
          className={cn(
            "flex h-ctl w-full min-w-0 items-center gap-1.5 rounded-sm border border-input bg-bg ps-3 pe-2 text-start text-body text-ink transition-colors duration-150 outline-none hover:border-muted-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 aria-expanded:border-primary aria-invalid:border-fail",
            className,
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", text === undefined && "text-muted-foreground")}>
            {display?.node ?? text ?? placeholder}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
              picker.open && "rotate-180",
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PickerContent
        picker={picker}
        label={listLabel}
        value={value}
        options={list}
        onChange={onChange}
        className="w-(--radix-popover-trigger-width) min-w-[min(280px,calc(100vw-16px))] max-w-[calc(100vw-16px)]"
      />
    </PopoverPrimitive.Root>
  )
}
