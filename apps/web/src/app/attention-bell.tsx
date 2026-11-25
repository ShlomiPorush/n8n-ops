import { Bell } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { useEffect, useId, useRef, useState } from "react"
import { Link, useLocation } from "react-router"
import { AttentionList, attentionCount, type OpenItem } from "@/components/attention"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { badgeText, bellName, checksFailed, type Tone, useAttention } from "@/lib/attention"
import { loadView, refreshFailed } from "@/lib/load-state"
import { useNavigateFromOverlay, useOverlayHistory } from "@/lib/overlay-history"
import { usePopoverRoom } from "@/lib/popover-room"
import { cn } from "@/lib/utils"

const badgeTone: Record<Tone, string> = { fail: "bg-fail", warn: "bg-warn", info: "bg-ink" }

export function AttentionBell({ phone = false }: { phone?: boolean }) {
  const query = useAttention()
  const a = query.data
  const unchecked = checksFailed(a, refreshFailed(query) || loadView(query) === "failed")
  const badge = badgeText(a?.total ?? 0)
  const name = bellName(a, unchecked)
  const [open, setOpen] = useState(false)
  const bellRef = useRef<HTMLButtonElement>(null)
  const openNow = useRef(open)
  openNow.current = open

  const { key } = useLocation()
  const moved = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every move
  useEffect(() => {
    if (!openNow.current) return
    moved.current = true
    setOpen(false)
  }, [key])
  const keepFocusAfterMove = (e: Event) => {
    if (moved.current) e.preventDefault()
    moved.current = false
  }
  const narrow = useIsMobile()
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the width crosses 760px
  useEffect(() => setOpen(false), [narrow])

  const navigate = useNavigateFromOverlay()
  const onOpen: OpenItem = (to, e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }

  const titleId = useId()
  const title = (
    <>
      Needs Attention
      {attentionCount(a) !== undefined && (
        <span className="ms-2 font-medium text-muted-foreground tabular-nums">{attentionCount(a)}</span>
      )}
    </>
  )
  const list = <AttentionList query={query} place={phone ? "sheet" : "window"} onOpen={onOpen} icon={Bell} />
  const foot = (
    <Link
      to="/"
      className="text-ctl font-semibold [@media(hover:hover)]:hover:underline"
      onClick={(e) => onOpen("/", e)}
    >
      Open the Overview
    </Link>
  )
  const button = (
    <button
      ref={bellRef}
      type="button"
      aria-label={name}
      title={name}
      data-slot="attention-bell"
      className={cn(
        "relative grid shrink-0 place-items-center rounded-sm text-ink",
        phone
          ? "size-9"
          : "size-10 border border-line bg-panel aria-expanded:border-ink aria-expanded:bg-bg aria-expanded:shadow-halo",
        !phone &&
          "regular:size-ctl regular:border-transparent regular:bg-transparent regular:aria-expanded:border-transparent regular:aria-expanded:bg-accent regular:aria-expanded:shadow-none regular:[@media(hover:hover)]:hover:bg-accent",
      )}
    >
      <Bell aria-hidden className="size-[19px]" />
      {badge ? (
        <span
          aria-hidden
          data-slot="attention-badge"
          data-tone={a?.tone ?? undefined}
          className={cn(
            "pointer-events-none absolute -end-1.5 -top-1.5 h-[19px] min-w-[19px] rounded-full px-[5px] text-center text-meta leading-[19px] font-bold text-bg tabular-nums ring-2 ring-bg",
            badgeTone[a?.tone ?? "info"],
          )}
        >
          {badge}
        </span>
      ) : (
        unchecked && (
          <span
            aria-hidden
            data-slot="attention-unchecked"
            className="pointer-events-none absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-muted-foreground ring-2 ring-bg"
          />
        )
      )}
    </button>
  )

  if (phone)
    return (
      <Dialog open={open} onOpenChange={setOpen} modal={false}>
        <DialogTrigger asChild>{button}</DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          inertPage={open}
          onCloseAutoFocus={(e) => {
            keepFocusAfterMove(e)
            if (e.defaultPrevented) return
            e.preventDefault()
            bellRef.current?.focus({ preventScroll: true })
          }}
          onInteractOutside={(e) => {
            if (e.target instanceof Element && e.target.closest('[role="alertdialog"]')) e.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="-mx-pad-x flex min-h-0 flex-col">{list}</div>
          <DialogFooter className="justify-start">{foot}</DialogFooter>
        </DialogContent>
      </Dialog>
    )
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{button}</PopoverPrimitive.Trigger>
      <BellWindow
        open={open}
        close={() => setOpen(false)}
        onCloseAutoFocus={keepFocusAfterMove}
        titleId={titleId}
        title={title}
        foot={foot}
      >
        {list}
      </BellWindow>
    </PopoverPrimitive.Root>
  )
}

function BellWindow({
  open,
  close,
  onCloseAutoFocus,
  titleId,
  title,
  foot,
  children,
}: {
  open: boolean
  close: () => void
  onCloseAutoFocus: (e: Event) => void
  titleId: string
  title: React.ReactNode
  foot: React.ReactNode
  children: React.ReactNode
}) {
  useOverlayHistory(open, close)
  const room = usePopoverRoom(open)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        role="dialog"
        aria-labelledby={titleId}
        align="end"
        sideOffset={8}
        collisionPadding={room}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={(e) => {
          if (e.target instanceof Element && e.target.closest('[data-toast], [role="alertdialog"]')) e.preventDefault()
        }}
        tabIndex={-1}
        data-slot="attention-window"
        className="z-50 flex max-h-[min(560px,calc(100dvh-90px))] w-[min(460px,calc(100vw-32px))] flex-col overflow-hidden rounded-pop border border-line bg-popover text-popover-foreground shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
      >
        <h2 id={titleId} className="shrink-0 px-pad-x pt-3 pb-2.5 text-head">
          {title}
        </h2>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <div className="shrink-0 border-t border-line px-pad-x py-2.5">{foot}</div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}
