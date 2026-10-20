import { Bell, Bot, Globe, HardDrive, KeyRound, type LucideIcon, Mail, Send, SlidersHorizontal } from "lucide-react"

/** The settings sections, grouped as they appear beside the form, in the sidebar flyout and in the picker. */
export const settingsGroups = [
  {
    label: "Installation",
    items: [
      ["general", "General"],
      ["defaults", "Instance Defaults"],
    ],
  },
  {
    label: "Notifications",
    items: [
      ["alerts", "Alerts"],
      ["telegram", "Telegram"],
      ["email", "Email Reports"],
    ],
  },
  {
    label: "Backups",
    items: [
      ["storage", "Backup Storage"],
      ["keys", "Encryption Keys"],
    ],
  },
  {
    label: "Access",
    items: [["access", "Agent Access"]],
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
}
