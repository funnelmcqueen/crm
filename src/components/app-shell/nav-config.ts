import {
  CalendarClock,
  ChartColumn,
  Contact,
  LayoutDashboard,
  type LucideIcon,
  Phone,
  Settings,
  SquareKanban,
  UsersRound,
} from "lucide-react";

export type ShellRole = "ADMIN" | "AGENT";

export interface ShellUser {
  name: string;
  email: string;
  role: ShellRole;
}

export type NavKey =
  | "dashboard"
  | "leads"
  | "pipeline"
  | "follow-ups"
  | "agents"
  | "phone-numbers"
  | "reports"
  | "settings";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Path prefixes that mark this item active (the href itself plus related pages). */
  activePrefixes: readonly string[];
}

function item(key: NavKey, label: string, href: string, icon: LucideIcon, extraPrefixes: string[] = []): NavItem {
  return { key, label, href, icon, activePrefixes: [href, ...extraPrefixes] };
}

const AGENT_NAV: readonly NavItem[] = [
  item("dashboard", "Dashboard", "/dashboard", LayoutDashboard),
  item("leads", "My Leads", "/leads", Contact),
  item("pipeline", "Pipeline", "/pipeline", SquareKanban),
  item("follow-ups", "Follow-ups", "/follow-ups", CalendarClock),
  item("settings", "Settings", "/settings", Settings),
];

const ADMIN_NAV: readonly NavItem[] = [
  item("dashboard", "Dashboard", "/dashboard", LayoutDashboard),
  item("leads", "All Leads", "/leads", Contact, ["/admin/import"]),
  item("pipeline", "Pipeline", "/pipeline", SquareKanban),
  item("follow-ups", "Follow-ups", "/follow-ups", CalendarClock),
  item("agents", "Agents", "/admin/agents", UsersRound),
  item("phone-numbers", "Phone Numbers", "/admin/phone-numbers", Phone),
  item("reports", "Reports", "/admin/reports", ChartColumn),
  item("settings", "Settings", "/settings", Settings),
];

/** Mobile tab bar slots before the rest moves into the "More" sheet. */
export const MOBILE_TAB_LIMIT = 5;

export function getNavItems(role: ShellRole): readonly NavItem[] {
  return role === "ADMIN" ? ADMIN_NAV : AGENT_NAV;
}

export function isNavItemActive(pathname: string, navItem: NavItem): boolean {
  return navItem.activePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function roleLabel(role: ShellRole): string {
  return role === "ADMIN" ? "Admin" : "Agent";
}
