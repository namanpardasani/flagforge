import { Flag, FlaskConical, KeyRound, LayoutGrid, Layers, ScrollText, Users, type LucideIcon } from "lucide-react";

export interface NavItem {
  page: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The sidebar and the command palette both read this list, so they can never disagree. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Project",
    items: [
      { page: "overview", label: "Overview", icon: LayoutGrid },
      { page: "flags", label: "Flags", icon: Flag },
      { page: "experiments", label: "Experiments", icon: FlaskConical },
      { page: "environments", label: "Environments", icon: Layers },
      { page: "api-keys", label: "API keys", icon: KeyRound },
    ],
  },
  {
    label: "Workspace",
    items: [
      { page: "members", label: "Members", icon: Users },
      { page: "audit-log", label: "Audit log", icon: ScrollText },
    ],
  },
];

export const ALL_NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export const pageLabel = (page: string | undefined) => ALL_NAV_ITEMS.find((i) => i.page === page)?.label ?? "Overview";
