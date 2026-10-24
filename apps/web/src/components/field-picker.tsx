import { ChevronDown } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { type ReactNode, useMemo } from "react"
import { PickerContent, type PickerOption, usePicker } from "@/components/filter-bar"
import { useOverlayHistory } from "@/lib/overlay-history"
import { cn } from "@/lib/utils"

/**
 * A choice in a form, made with the shared picker (MP-1): the field looks like a select and shows only the
 * value, its list is as wide as the field (at least 280px), and more than ten choices get a search (MP-4). The
 * button is named by the field and its value ("Worker: None"). Back, Escape or a click beside the list closes
 * it before anything else; it is modal, like a dialog, so a click beside it never goes through to a link behind
 * it while the list still holds its Back entry (DS-10).
 */
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
  className,
}: {
  id?: string
  /** The field's name, said before the value. */
  label: string
  /** What the list is called, and its search ("Search time zones"); the field's name by default. */
  listLabel?: string
  value: string
  /** The choices, or what makes them once the list opens (a long list that takes a moment, given `display`). */
  options: PickerOption[] | (() => PickerOption[])
  onChange: (value: string) => void
  /** Shown, muted, while nothing is chosen. */
  placeholder?: string
  /** The chosen value as drawn in the field, when it is more than the option's label, and what is said for it. */
  display?: { node: ReactNode; text: string }
  disabled?: boolean
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
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              picker.setOpen(true)
            }
          }}
          className={cn(
            // The look of the select it replaced, so a form looks the same.
            "flex h-ctl w-full min-w-0 items-center gap-1.5 rounded-sm border border-input bg-bg ps-3 pe-2 text-start text-body text-ink transition-colors duration-150 outline-none hover:border-muted-foreground focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 aria-expanded:border-primary",
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
