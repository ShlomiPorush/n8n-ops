import { useCallback } from "react"
import { FieldPicker } from "@/components/field-picker"
import type { PickerOption } from "@/components/filter-bar"

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
 * The time zone of the installation, chosen from a list with a search (by city, region or offset) (MP-4). An
 * empty value is UTC. The field shows the zone's offset now, muted, after its name.
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
  const zone = value || "UTC"
  // Built once the list opens: offsets change with daylight saving, and some 400 zones take a moment.
  const options = useCallback(() => zoneOptions(zone), [zone])
  // UTC needs no offset beside its name.
  const offset = zone === "UTC" ? null : zoneOffset(zone, new Date())
  const name = zone.replaceAll("_", " ")
  return (
    <FieldPicker
      id={id}
      label="Time zone"
      listLabel="Time zones"
      value={zone}
      options={options}
      onChange={onChange}
      disabled={disabled}
      display={{
        text: `${name}${offset ? ` (${offset})` : ""}`,
        node: (
          <>
            {name}
            {offset && <span className="text-muted-foreground tabular-nums"> {offset}</span>}
          </>
        ),
      }}
    />
  )
}
