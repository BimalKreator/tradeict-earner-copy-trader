import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Bot,
  IndianRupee,
  Menu,
  Receipt,
  Users,
} from "lucide-react";

export type DashboardNavGroupId =
  | "money"
  | "bot"
  | "bill"
  | "refer"
  | "arbitrage"
  | "account";

export type DashboardNavLink = {
  href: string;
  label: string;
  arbAccessOnly?: boolean;
};

export type DashboardNavGroup = {
  id: DashboardNavGroupId;
  label: string;
  tabHref: string;
  tabIcon: LucideIcon;
  links: DashboardNavLink[];
  salesTeamOnly?: boolean;
  arbAccessOnly?: boolean;
};

export const DASHBOARD_NAV_GROUPS: DashboardNavGroup[] = [
  {
    id: "money",
    label: "My Money",
    tabHref: "/dashboard",
    tabIcon: IndianRupee,
    links: [
      { href: "/dashboard", label: "Home" },
      { href: "/dashboard/performance", label: "Performance" },
      { href: "/dashboard/trades", label: "Trades" },
    ],
  },
  {
    id: "bot",
    label: "Bot",
    tabHref: "/dashboard/live-trades",
    tabIcon: Bot,
    links: [
      { href: "/dashboard/live-trades", label: "Live trades" },
      { href: "/dashboard/strategies", label: "Strategies" },
    ],
  },
  {
    id: "bill",
    label: "My Bill",
    tabHref: "/dashboard/performance#invoices",
    tabIcon: Receipt,
    links: [
      { href: "/dashboard/performance#invoices", label: "Invoices & billing" },
      { href: "/dashboard/wallet", label: "Wallet" },
      { href: "/dashboard/payments", label: "Payments" },
    ],
  },
  {
    id: "refer",
    label: "Refer & Earn",
    tabHref: "/dashboard/partner",
    tabIcon: Users,
    salesTeamOnly: true,
    links: [{ href: "/dashboard/partner", label: "Partner dashboard" }],
  },
  {
    id: "arbitrage",
    label: "Arbitrage",
    tabHref: "/dashboard/dex-arbitrage",
    tabIcon: ArrowLeftRight,
    arbAccessOnly: true,
    links: [
      { href: "/dashboard/dex-arbitrage", label: "Dex Arbitrage" },
      { href: "/dashboard/arbitrage-trades", label: "Arbitrage Trades" },
    ],
  },
  {
    id: "account",
    label: "Account",
    tabHref: "/dashboard/settings",
    tabIcon: Menu,
    links: [
      { href: "/dashboard/settings", label: "Settings" },
      { href: "/dashboard/profile", label: "Profile" },
      { href: "/dashboard/support", label: "Support" },
    ],
  },
];

export function visibleDashboardNavGroups(
  isSalesTeamMember: boolean,
  arbAccess = false,
): DashboardNavGroup[] {
  return DASHBOARD_NAV_GROUPS.filter((g) => {
    if (g.salesTeamOnly && !isSalesTeamMember) return false;
    if (g.arbAccessOnly && !arbAccess) return false;
    return true;
  });
}

function pathnameMatchesLink(pathname: string, href: string): boolean {
  const base = href.split("#")[0]!;
  if (base === "/dashboard") return pathname === "/dashboard";
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function resolveActiveNavGroup(
  pathname: string,
  hash: string,
): DashboardNavGroupId {
  if (pathname.startsWith("/dashboard/partner")) return "refer";
  if (
    pathname.startsWith("/dashboard/dex-arbitrage") ||
    pathname.startsWith("/dashboard/arbitrage-trades")
  ) {
    return "arbitrage";
  }
  if (
    pathname.startsWith("/dashboard/live-trades") ||
    pathname.startsWith("/dashboard/strategies")
  ) {
    return "bot";
  }
  if (
    pathname.startsWith("/dashboard/wallet") ||
    pathname.startsWith("/dashboard/payments")
  ) {
    return "bill";
  }
  if (pathname.startsWith("/dashboard/performance") && hash === "#invoices") {
    return "bill";
  }
  if (
    pathname.startsWith("/dashboard/settings") ||
    pathname.startsWith("/dashboard/profile") ||
    pathname.startsWith("/dashboard/support")
  ) {
    return "account";
  }
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/trades")) {
    return "money";
  }
  if (pathname.startsWith("/dashboard/performance")) {
    return "money";
  }
  return "money";
}

export function isNavLinkActive(pathname: string, hash: string, href: string): boolean {
  const [base, linkHash = ""] = href.split("#");
  if (linkHash) {
    return pathname.startsWith(base) && hash === `#${linkHash}`;
  }
  return pathnameMatchesLink(pathname, href);
}
