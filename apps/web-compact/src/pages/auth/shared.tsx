import { REGEXP_ONLY_DIGITS } from "input-otp"
import { useState } from "react"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { cn } from "@/lib/utils"

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="grid size-[30px] place-items-center rounded-sm bg-primary text-ctl font-heavy text-primary-foreground"
      >
        n
      </span>
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

/** Six-digit code input that submits on the sixth digit and clears itself after. */
export function TotpInput({ onComplete, disabled }: { onComplete: (code: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("")
  return (
    <InputOTP
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      value={value}
      onChange={setValue}
      disabled={disabled}
      autoFocus
      aria-label="Two-factor code"
      onComplete={(code: string) => {
        onComplete(code)
        setValue("")
      }}
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
  )
}
