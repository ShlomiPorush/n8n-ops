import { REGEXP_ONLY_DIGITS } from "input-otp"
import { useState } from "react"
import { BrandMark } from "@/components/brand"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"

export function Logo() {
  return (
    <div className="flex flex-col items-center gap-2 self-center">
      <BrandMark className="size-10 text-base" />
      <div className="text-center">
        <div className="font-semibold tracking-tight">n8n-ops</div>
        <div className="text-xs text-muted-foreground">Operations console for n8n</div>
      </div>
    </div>
  )
}

export function AuthFrame({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[22px_22px] p-6 md:p-10">
      <div className={wide ? "flex w-full max-w-lg flex-col gap-6" : "flex w-full max-w-sm flex-col gap-6"}>
        <Logo />
        {children}
      </div>
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
