import { useCallback } from "react"
import { FieldPicker } from "@/components/field-picker"
import type { PickerOption } from "@/components/filter-bar"
import { zoneOffset } from "@/lib/time"

function zoneOptions(current: string): PickerOption[] {
  const now = new Date()
  const names = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")]
  if (current && !names.includes(current)) names.unshift(current)
  return names.map((zone) => {
    const offset = zoneOffset(zone, now) ?? "unknown"
    return { value: zone, label: zone.replaceAll("_", " "), hint: offset, search: `${zone} ${offset}` }
  })
}

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
  const options = useCallback(() => zoneOptions(zone), [zone])
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
            {offset && <span className="text-muted-foreground"> {offset}</span>}
          </>
        ),
      }}
    />
  )
}
