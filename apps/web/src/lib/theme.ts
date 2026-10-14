import { useEffect } from "react"

/** Follows the operating system's light or dark preference. */
export function useSystemTheme() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => document.documentElement.classList.toggle("dark", media.matches)
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [])
}
