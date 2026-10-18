import { useEffect, useRef, useState } from "react"
import { useDesign } from "@/lib/design"
import { n } from "@/lib/time"

const ROLL_MS = 900

/**
 * A key figure. Regular counts it up when it first shows and when it changes, as #29 did; Compact shows it
 * still. Both end on the same text, and nothing moves under reduced motion.
 */
export function Figure({ value }: { value: number }) {
  const design = useDesign()
  const [shown, setShown] = useState(design === "regular" ? 0 : value)
  const from = useRef(design === "regular" ? 0 : value)

  useEffect(() => {
    const still = design !== "regular" || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (still || from.current === value) {
      from.current = value
      setShown(value)
      return
    }
    const start = performance.now()
    const begin = from.current
    let frame = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ROLL_MS)
      const eased = 1 - (1 - t) ** 3
      setShown(Math.round(begin + (value - begin) * eased))
      if (t < 1) frame = requestAnimationFrame(step)
      else from.current = value
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      from.current = value
    }
  }, [design, value])

  if (shown === value) return <>{n(value)}</>
  // While it counts, assistive technology reads the real figure and skips the moving one.
  return (
    <>
      <span className="sr-only">{n(value)}</span>
      <span aria-hidden>{n(shown)}</span>
    </>
  )
}
