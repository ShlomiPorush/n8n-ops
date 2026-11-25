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

export type TotpAnswer = "done" | "refused" | "unreached"

export const totpAnswer = (error: { status?: number }): TotpAnswer => (error.status ? "refused" : "unreached")

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
