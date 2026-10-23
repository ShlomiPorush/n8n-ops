import { X } from "lucide-react"
import { useRef, useState } from "react"
import { addEntries, finishedEntries } from "@/lib/entries"
import { cn } from "@/lib/utils"

/**
 * A field that holds several values as chips (FS-15): email recipients, Telegram approvers. Enter, a comma or a
 * semicolon adds what is typed; a paste may add several at once; leaving the field adds what is left in it, so a
 * value typed before Save is never lost. × removes one (`Remove <value>`), and Backspace in the empty field
 * removes the last. No value is added twice. Each value is checked on its own: one that `problem` refuses is
 * drawn as failed and says why, and stays until it is fixed or removed (SV-12).
 * Compact draws the chips as v3 does (mono, 6px corners); Regular as its own rounded tags.
 */
export function ChipsInput({
  id,
  value,
  onChange,
  problem,
  placeholder,
  invalid,
  describedBy,
}: {
  id: string
  value: string[]
  onChange: (value: string[]) => void
  /** What is wrong with one value, or null when it is fine. */
  problem?: (entry: string) => string | null
  placeholder?: string
  /** The field failed its check before a save (SV-1). */
  invalid?: boolean
  describedBy?: string
}) {
  const [text, setText] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const add = (typed: string) => {
    const next = addEntries(value, typed)
    if (next.length !== value.length) onChange(next)
  }
  return (
    // A click anywhere in the box puts the cursor in its Add field (FS-1).
    // biome-ignore lint/a11y/noStaticElementInteractions: the field inside is what the keyboard uses
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field inside is what the keyboard uses
    <div
      data-slot="chips-input"
      onClick={(e) => e.target === e.currentTarget && input.current?.focus()}
      className={cn(
        "flex min-h-ctl w-full min-w-0 cursor-text flex-wrap items-center gap-1.5 rounded-sm border border-input bg-bg px-1.5 py-1 transition-colors duration-150 focus-within:border-primary",
        invalid && "border-fail",
      )}
    >
      {value.map((entry) => {
        const wrong = problem?.(entry) ?? null
        return (
          <span
            key={entry}
            title={wrong ?? undefined}
            className={cn(
              "inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-tag py-0.5 ps-2 pe-0.5 font-mono text-meta regular:rounded-full regular:font-sans regular:font-medium regular:ring-1 regular:ring-inset",
              wrong ? "tint-fail regular:ring-current/30" : "bg-fill text-ink regular:bg-raise regular:ring-line",
            )}
          >
            <span className="truncate">{entry}</span>
            {wrong && <span className="sr-only">: {wrong}</span>}
            <button
              type="button"
              title="Remove"
              aria-label={`Remove ${entry}`}
              onClick={() => {
                onChange(value.filter((v) => v !== entry))
                input.current?.focus()
              }}
              className="grid size-5 shrink-0 place-items-center rounded-tag text-muted-foreground hover:bg-ink/10 hover:text-ink regular:rounded-full"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )
      })}
      <input
        ref={input}
        id={id}
        value={text}
        placeholder={value.length ? undefined : placeholder}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const { done, rest } = finishedEntries(e.target.value)
          if (done) add(done)
          setText(rest)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter adds the value; it never submits the form around it.
            e.preventDefault()
            add(text)
            setText("")
          } else if (e.key === "Backspace" && text === "" && value.length) {
            e.preventDefault()
            onChange(value.slice(0, -1))
          }
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text")
          if (!/[,;\s]/.test(pasted.trim())) return
          e.preventDefault()
          add(text + pasted)
          setText("")
        }}
        onBlur={() => {
          add(text)
          setText("")
        }}
        className="h-7 min-w-[12ch] flex-1 bg-transparent px-1.5 text-body text-ink outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
