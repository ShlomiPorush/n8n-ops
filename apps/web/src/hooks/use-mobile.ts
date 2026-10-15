import { useEffect, useState } from "react"

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])
  return matches
}

/** A phone: up to 760px, where the tab bar replaces the sidebar. */
export function useIsMobile() {
  return useMediaQuery("(max-width: 760px)")
}
