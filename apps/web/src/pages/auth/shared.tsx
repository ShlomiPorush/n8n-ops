import { REGEXP_ONLY_DIGITS } from "input-otp"
import { useEffect, useRef, useState } from "react"
import { BrandMark } from "@/components/brand-mark"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { cn } from "@/lib/utils"

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <span className="text-head font-bold tracking-tight">n8n-ops</span>
    </div>
  )
}

/**
 * Sign-in and first-run frame: the form sits on the page itself, without a card around it. As tall as the
 * visible screen, and it scrolls when the form is taller.
 */
export function AuthFrame({
  children,
  title,
  description,
  wide,
}: {
  children: React.ReactNode
  title?: string
  description?: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className="h-dvh overflow-y-auto bg-bg">
      <main className="flex min-h-full flex-col justify-center px-4 py-10">
        <div className={cn("mx-auto grid w-full gap-gap", wide ? "max-w-lg" : "max-w-sm")}>
          <Logo />
          {title && (
            <div className="mt-4 mb-1">
              <h1 className="text-h1">{title}</h1>
              {description && <p className="mt-1.5 text-muted-foreground">{description}</p>}
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}

/** What became of a sent code: accepted, refused by the server, or sent without an answer. */
export type TotpAnswer = "done" | "refused" | "unreached"

/** The answer to a code from Better Auth's error: one without a status never reached the server (FS-23). */
export const totpAnswer = (error: { status?: number }): TotpAnswer => (error.status ? "refused" : "unreached")

/**
 * Six-digit code input that sends the code on the sixth digit. A code the server refused is cleared for the
 * next try; one that got no answer is kept and can be sent again with Try again or Enter (FS-23). Its parts
 * sit in the parent's layout.
 */
export function TotpInput({
  onSubmit,
  disabled,
  error,
}: {
  onSubmit: (code: string) => Promise<TotpAnswer>
  disabled?: boolean
  error?: string
}) {
  const [value, setValue] = useState("")
  const [kept, setKept] = useState(false)
  const [refocus, setRefocus] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // The field is disabled while the code is sent, which takes the focus away; it comes back once enabled.
  useEffect(() => {
    if (!refocus || disabled) return
    setRefocus(false)
    input.current?.focus()
  }, [refocus, disabled])

  async function send(code: string) {
    setKept(false)
    const answer = await onSubmit(code)
    if (answer === "done") return
    if (answer === "refused") setValue("")
    else setKept(true)
    setRefocus(true)
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.length === 6 && !disabled) void send(value)
      }}
    >
      <InputOTP
        ref={input}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        value={value}
        onChange={setValue}
        disabled={disabled}
        autoFocus
        aria-label="Two-factor code"
        onComplete={(code: string) => void send(code)}
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      {error && <FieldError>{error}</FieldError>}
      {kept && value.length === 6 && !disabled && (
        <Button type="submit" variant="primary">
          Try again
        </Button>
      )}
    </form>
  )
}
