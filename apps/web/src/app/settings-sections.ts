import {
  Bell,
  Bot,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Mail,
  Plug,
  Send,
  SlidersHorizontal,
} from "lucide-react"

/** The settings sections, grouped as they appear beside the form, in the sidebar flyout and in the picker. */
export const settingsGroups = [
  {
    label: "Installation",
    items: [
      ["general", "General"],
      ["defaults", "Instance Defaults"],
      ["database", "Database"],
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
      ["destinations", "Backup Destinations"],
      ["keys", "Encryption Keys"],
    ],
  },
  {
    label: "Access",
    items: [
      ["security", "Sign-in Security"],
      ["agents", "Agent Connections"],
      ["access", "Agent Access"],
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
  database: Database,
  alerts: Bell,
  telegram: Send,
  email: Mail,
  destinations: HardDrive,
  keys: KeyRound,
  security: LockKeyhole,
  agents: Plug,
  access: Bot,
}
