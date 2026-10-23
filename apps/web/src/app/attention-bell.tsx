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

/**
 * Needs attention from every page (NL-19): a bell in the top bar and in the phone top bar. Its badge counts every
 * item that needs a look, red when one fails, amber for warnings only, ink for news only; hidden at zero and "99+"
 * above 99, with the full number in its name ("Needs attention, 120 items"). While nothing is known to need a look
 * but a check could not run, a grey dot shows instead; the name says so either way.
 *
 * It opens the list Overview shows, with the same actions: on a wide screen a window under the bell, on a phone
 * (`phone`, the phone top bar's bell) the shared sheet. Escape, Back or a click beside it closes it, and the focus
 * goes back to the bell. A row opens its item through the unsaved-changes guard: the window closes once the move
 * is made, and stays when the Leave question keeps the page. It closes when the width crosses 760px, since its bell
 * is gone. The list is read on every page by one query (`useAttention`).
 */
export function AttentionBell({ phone = false }: { phone?: boolean }) {
  const query = useAttention()
  const a = query.data
  const unchecked = checksFailed(a, refreshFailed(query) || loadView(query) === "failed")
  const badge = badgeText(a?.total ?? 0)
  const name = bellName(a, unchecked)
  const [open, setOpen] = useState(false)
  const openNow = useRef(open)
  openNow.current = open

  // A move from the window closes it once made; one the Leave question kept leaves it open. After a move the page
  // keeps the focus, instead of the bell.
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
  // The other bar's bell takes over across 760px.
  const narrow = useIsMobile()
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the width crosses 760px
  useEffect(() => setOpen(false), [narrow])

  const navigate = useNavigateFromOverlay()
  // A plain click opens the item in place; one with a modifier is left to the browser (a new tab).
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
      type="button"
      aria-label={name}
      title={name}
      data-slot="attention-bell"
      className={cn(
        "relative grid shrink-0 place-items-center rounded-sm text-ink",
        phone
          ? "size-9"
          : "size-10 border border-line bg-panel aria-expanded:border-ink aria-expanded:bg-bg aria-expanded:shadow-halo",
        // Regular: a quiet icon button like the bar's others (#29).
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{button}</DialogTrigger>
        <DialogContent aria-describedby={undefined} onCloseAutoFocus={keepFocusAfterMove}>
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

/**
 * The window under the bell: its right edge under the bell's, 460px wide and at most 560px high (less on a short
 * screen), a head with the count, the list scrolling inside, and a foot that opens Overview. It holds a Back step
 * while open (DS-10) and stays within the room between the bars (MP-5).
 */
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
        // The window itself takes the focus, so Tab goes on to its list and rows.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        // The toast (Undo, Retry) and a question over the window, such as Leave without saving when a move from it
        // waits, are not beside it: the window stays (NL-19, SV-1).
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
