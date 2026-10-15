import { REGEXP_ONLY_DIGITS } from "input-otp"
import { useState } from "react"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { cn } from "@/lib/utils"

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 text-base font-semibold">
      <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">n</div>
      n8n-ops
    </div>
  )
}

/**
 * Signed-out pages: everything hangs on one line about a quarter in from the left, on a mostly empty page.
 * Cards inside the frame drop their surface so the column reads as one piece.
 */
export function AuthFrame({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div data-slot="auth-frame" className="min-h-svh bg-background px-6 pt-8 pb-16 md:pt-14 md:pr-10 md:pl-[27vw]">
      <Logo />
      <main className={cn("mt-[12vh] flex w-full flex-col gap-8 md:mt-[16vh]", wide ? "max-w-lg" : "max-w-[380px]")}>
        {children}
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
