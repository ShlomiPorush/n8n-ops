import {
  Bell,
  Bot,
  Globe,
  HardDrive,
  KeyRound,
  KeySquare,
  type LucideIcon,
  Mail,
  Send,
  SlidersHorizontal,
  UserRound,
} from "lucide-react"

/** The settings sections, grouped as they appear beside the form, in the sidebar flyout and in the picker. */
export const settingsGroups = [
  {
    label: "Installation",
    items: [
      ["general", "General"],
      ["defaults", "Instance defaults"],
    ],
  },
  {
    label: "Notifications",
    items: [
      ["alerts", "Alerts"],
      ["telegram", "Telegram"],
      ["email", "Email reports"],
    ],
  },
  {
    label: "Backups",
    items: [
      ["storage", "Backup storage"],
      ["keys", "Encryption keys"],
    ],
  },
  {
    label: "Access",
    items: [
      ["access", "Agent access"],
      ["tokens", "Connected agents"],
      ["account", "Account"],
    ],
  },
] as const

export type SettingsSection = (typeof settingsGroups)[number]["items"][number][0]

const sections: readonly (readonly [string, string])[] = settingsGroups.flatMap(
  (g): readonly (readonly [string, string])[] => g.items,
)

export const settingsSectionLabel = (section: string): string | undefined => sections.find(([k]) => k === section)?.[1]

/** Each section's icon, drawn by Regular beside its name (#29). */
export const settingsIcons: Record<SettingsSection, LucideIcon> = {
  general: Globe,
  defaults: SlidersHorizontal,
  alerts: Bell,
  telegram: Send,
  email: Mail,
  storage: HardDrive,
  keys: KeyRound,
  access: Bot,
  tokens: KeySquare,
  account: UserRound,
}
