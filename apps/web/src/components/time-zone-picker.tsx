import { ChevronDown } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { useMemo } from "react"
import { PickerContent, type PickerOption, usePicker } from "@/components/filter-bar"
import { useOverlayHistory } from "@/lib/overlay-history"
import { cn } from "@/lib/utils"

/** A zone's offset from UTC right now, such as UTC+03:00; null when the browser does not know the zone. */
export function zoneOffset(zone: string, at: Date): string | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value
    return !name || name === "GMT" ? "UTC+00:00" : name.replace("GMT", "UTC")
  } catch {
    return null
  }
}

/** Every zone the browser knows, UTC first; a stored zone the list lacks is kept at the top. */
function zoneOptions(current: string): PickerOption[] {
  const now = new Date()
  const names = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")]
  if (current && !names.includes(current)) names.unshift(current)
  return names.map((zone) => {
    const offset = zoneOffset(zone, now) ?? "unknown"
    return { value: zone, label: zone.replaceAll("_", " "), hint: offset, search: `${zone} ${offset}` }
  })
}

/**
 * The time zone of the installation, chosen from a list with a search (by city, region or offset). An empty
 * value is UTC. Back, Escape or a click beside the list closes it before anything leaves the page.
 */
export function TimeZonePicker({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: string
  onChange: (zone: string) => void
  disabled?: boolean
}) {
  const picker = usePicker()
  useOverlayHistory(picker.open, () => picker.setOpen(false))
  const zone = value || "UTC"
  // Built once the list opens: offsets change with daylight saving, and some 400 zones take a moment.
  const options = useMemo(() => (picker.open ? zoneOptions(zone) : []), [picker.open, zone])
  // UTC needs no offset beside its name.
  const offset = zone === "UTC" ? null : zoneOffset(zone, new Date())
  const shown = `${zone.replaceAll("_", " ")}${offset ? ` (${offset})` : ""}`
  return (
    // Modal, like a dialog: a click beside the list only closes it. Going through to a link behind it would
    // leave the page while the list still holds its Back entry, and cost a second Back later.
    <PopoverPrimitive.Root modal open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-controls={picker.open ? picker.id : undefined}
          aria-label={`Time zone: ${shown}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              picker.setOpen(true)
            }
          }}
          className="flex h-ctl w-full min-w-0 items-center gap-2 rounded-sm border border-input bg-bg ps-3 pe-2.5 text-start text-body outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:border-primary"
        >
          <span className="min-w-0 flex-1 truncate">
            {zone.replaceAll("_", " ")}
            {offset && <span className="text-muted-foreground tabular-nums"> {offset}</span>}
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
        label="Time zones"
        value={zone}
        options={options}
        onChange={onChange}
        className="w-[min(360px,calc(100vw-16px))]"
      />
    </PopoverPrimitive.Root>
  )
}
