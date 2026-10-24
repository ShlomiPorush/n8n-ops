/** Thousands separators on every count, pinned to en-US so they never follow the browser's language (FW-3). */
export function n(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US")
}

/** The word for a count, singular or plural, where the number is drawn apart from it (FW-3). */
export function word(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many
}

/**
 * A count with its word, singular or plural, with thousands separators (FW-3): "1 problem", "1,920 events".
 * Every count on screen goes through here so a caption, its confirm and its toast never disagree.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${word(count, one, many)}`
}

/**
 * The count line of a list the server sends only part of (TB-17, TB-18): "200 of 1,240 problems" while rows are
 * left out, else "12 problems". The total is every row the filters match, so it agrees with the nav counter.
 */
export function countOf(shown: number, total: number, one: string, many = `${one}s`): string {
  return shown < total ? `${n(shown)} of ${plural(total, one, many)}` : plural(shown, one, many)
}

/**
 * Counts of several kinds in one line, leaving out a kind with zero (FW-3): "2 down, 1 needs a look". A word that
 * does not change with its count ("down", "inactive") is given once.
 */
export function counts(parts: [count: number, one: string, many?: string][], separator = ", "): string {
  return parts
    .filter(([count]) => count > 0)
    .map(([count, one, many = one]) => plural(count, one, many))
    .join(separator)
}

/** Instances that are down or need a look, as the Overview and Instances say it: "1 down, 2 need a look". */
export function healthCounts(down: number, warn: number): string {
  return counts([
    [down, "down"],
    [warn, "needs a look", "need a look"],
  ])
}

const sizeUnits = ["B", "KB", "MB", "GB", "TB"]

/** "1 MB", "1.5 MB", "1.25 GB", "0 B": at most two decimals, trailing zeros dropped (FW-4). */
export function formatSize(bytes: number): string {
  let unit = 0
  let value = bytes
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024
    unit++
  }
  // 1,048,575 bytes round to 1024 KB; that is 1 MB.
  if (Math.round(value * 100) / 100 >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: unit ? 2 : 0 })} ${sizeUnits[unit]}`
}

/**
 * The share of runs that failed, in percent with one decimal, or null when there were no runs: nothing to measure
 * is not 0% (FB-8).
 */
export function errorRate(errors: number, runs: number): number | null {
  return runs > 0 ? Math.round((errors / runs) * 1000) / 10 : null
}
