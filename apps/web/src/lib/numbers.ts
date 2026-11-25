export function n(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US")
}

export function word(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${word(count, one, many)}`
}

export function countOf(shown: number, total: number, one: string, many = `${one}s`): string {
  return shown < total ? `${n(shown)} of ${plural(total, one, many)}` : plural(shown, one, many)
}

export function counts(parts: [count: number, one: string, many?: string][], separator = ", "): string {
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many = one]) => plural(count, one, many))
    .join(separator)
}

export function healthCounts(down: number, warn: number): string {
  return counts([
    [down, "down"],
    [warn, "needs a look", "need a look"],
  ])
}

const sizeUnits = ["B", "KB", "MB", "GB", "TB"]

export function formatSize(bytes: number): string {
  let unit = 0
  let value = bytes
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024
    unit++
  }
  if (Math.round(value * 100) / 100 >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: unit ? 2 : 0 })} ${sizeUnits[unit]}`
}

export function errorRate(errors: number, runs: number): number | null {
  return runs > 0 ? Math.round((errors / runs) * 1000) / 10 : null
}
