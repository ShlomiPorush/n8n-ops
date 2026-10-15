import { Loader2Icon } from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// One toast at a time in the bottom corner (above the tab bar on a phone), a 4px status edge, gone after 4 seconds.
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme = "light" } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps["theme"]}
      position="bottom-right"
      visibleToasts={1}
      duration={4000}
      offset={{ bottom: 20, right: 20 }}
      mobileOffset={{ bottom: "calc(var(--spacing-tabbar) + 12px + env(safe-area-inset-bottom))", left: 12, right: 12 }}
      icons={{
        success: null,
        info: null,
        warning: null,
        error: null,
        loading: <Loader2Icon className="animate-spin" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-full items-start gap-3 rounded-lg border-s-4 border-info bg-popover py-3 ps-3 pe-pad-x text-body text-popover-foreground shadow-float md:w-[356px]",
          success: "border-ok",
          error: "border-fail",
          warning: "border-warn",
          info: "border-info",
          title: "font-semibold",
          description: "text-small text-muted-foreground",
          icon: "mt-0.5 size-4 shrink-0 [&_svg]:size-4",
          actionButton: "ms-auto text-ctl font-semibold underline",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
