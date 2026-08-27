# Admin Pages Inventory (16.4a)

Source of nav truth: `frontend/components/admin/AdminSidebar.tsx` (`navGroups`).
No other admin nav links found in `AdminHeader.tsx`.

| Route | File | Page ka kaam (1 line) | Kaun sa data dikhata hai | Nav mein link hai? | Kisi doosre page se overlap? |
| --- | --- | --- | --- | --- | --- |
| `/admin` | `frontend/app/admin/page.tsx` | Platform overview dashboard (cron health, alerts, headline stats). | Cron job status, system alerts, platform PnL / users / wallet summary cards. | Yes — Overview → Dashboard | - |
| `/admin/live-trades` | `frontend/app/admin/live-trades/page.tsx` | Live master/follower positions and bot open trades; force sync / close / adjust qty. | Grouped live Delta positions, bot OPEN trades, BTC ticker, risk auto-exit settings. | Yes — Trading → Live Trades | `/admin/trade-history` (same trade domain; history is closed/ledger) |
| `/admin/trade-history` | `frontend/app/admin/trade-history/page.tsx` | Browse and flush historical Trade rows across users. | CLOSED/OPEN/FAILED trades (symbol, PnL, fees, exit reason). | Yes — Trading → Trade History | `/admin/live-trades` |
| `/admin/dex-arbitrage` | `frontend/app/admin/dex-arbitrage/page.tsx` | Monitor cross-DEX arbitrage spreads. | Cached DEX spread table for top tokens. | Yes — Trading → Dex Arbitrage | - |
| `/admin/strategies` | `frontend/app/admin/strategies/page.tsx` | List strategies; create standard/bot strategies; force-sync. | Strategy list (fees, profit share, master keys presence, active flags). | Yes — Trading → Strategies | `/admin/strategies/[id]` (detail of same entities) |
| `/admin/strategies/[id]` | `frontend/app/admin/strategies/[id]/page.tsx` | Edit one strategy and manage its subscribers / multipliers. | Single strategy form fields + subscriber list / capital multipliers. | No (reached from Strategies list) | `/admin/strategies` |
| `/admin/users` | `frontend/app/admin/users/page.tsx` | List platform users; create user; OTP bypass; profile/email actions. | Users table (role, status, wallet, Delta balance, PnL-to-date). | Yes — User Management → Users | `/admin/members` (people roster; members = affiliate focus) |
| `/admin/users/[id]` | `frontend/app/admin/users/[id]/page.tsx` | Deep user admin: KYC, onboarding, copy trading, structure billing, simulation, delete. | Full user profile, trades, subscriptions, structure PnL / invoices, simulation tools. | No (reached from Users list) | `/admin/users`, `/admin/revenue-delta` (billing panels) |
| `/admin/members` | `frontend/app/admin/members/page.tsx` | Affiliate/sales members: upgrade requests, upline, tier upgrades. | Members list, upgrade-request queue, search-to-promote users. | Yes — User Management → Members | `/admin/users`, `/admin/referral-requests`, `/admin/tier-settings` |
| `/admin/referral-requests` | `frontend/app/admin/referral-requests/page.tsx` | Approve/reject sponsor referral requests. | ReferralRequest rows (sponsor, referred email/user, status). | Yes — User Management → Referral Requests | `/admin/members` |
| `/admin/tier-settings` | `frontend/app/admin/tier-settings/page.tsx` | Configure sales-team tier thresholds and benefits text. | TierConfig per EXECUTIVE/MANAGER/SENIOR_MANAGER. | Yes — User Management → Tier Settings | `/admin/members`, `/admin/settings` (commission rates also partner-related) |
| `/admin/network` | `frontend/app/admin/network/page.tsx` | Visual/tree view of affiliate acquisition network. | Network nodes (member/acquired), AUM, affiliate status. | Yes — User Management → Network Tree | `/admin/members` |
| `/admin/revenue` | `frontend/app/admin/revenue/page.tsx` | Legacy Trade-invoice revenue analytics and invoice list. | Revenue stats + Invoice rows (Trade-based profit share). | Yes — Financials → Revenue Analytics | `/admin/revenue-delta` (parallel revenue UX; Delta/HWM pipeline) |
| `/admin/revenue-delta` | `frontend/app/admin/revenue-delta/page.tsx` | Delta structure-P&L / MonthlyRevenueInvoice dashboard (HWM billing). | Period overview, health, per-user invoices, structure ledger, profit-share overrides. | Yes — Financials → Revenue (Delta) | `/admin/revenue`, `/admin/users/[id]` (structure billing panel) |
| `/admin/payouts` | `frontend/app/admin/payouts/page.tsx` | Approve/complete/reject affiliate partner payout requests. | PayoutRequest rows (amount, clawback, status, actor). | Yes — Financials → Payouts | `/admin/wallet` (money-out; wallet = user withdrawals) |
| `/admin/wallet` | `frontend/app/admin/wallet/page.tsx` | Manage user wallets and process withdrawal requests. | Wallet summary, withdrawal queue, per-user wallet balances / adjust. | Yes — Financials → Wallet Management | `/admin/funds` (deposits), `/admin/payouts` |
| `/admin/funds` | `frontend/app/admin/funds/page.tsx` | Approve/reject manual deposit screenshot submissions. | Deposit transactions (amount, screenshot, PENDING/APPROVED/REJECTED). | Yes — Financials → Funds | `/admin/wallet` |
| `/admin/coupons` | `frontend/app/admin/coupons/page.tsx` | Create/toggle subscription fee discount coupons. | Coupon codes, discount %, max/used counts, active flag. | Yes — Financials → Coupons | - |
| `/admin/managers` | `frontend/app/admin/managers/page.tsx` | Create and list platform admin accounts (SUPER_ADMIN only in nav). | Admin accounts (email, adminRole, status). | Yes — System → Managers (`superAdminOnly`) | - |
| `/admin/audit-logs` | `frontend/app/admin/audit-logs/page.tsx` | Search admin audit trail of sensitive actions. | AuditLog rows (action, resource, admin, IP, details). | Yes — System → Audit Logs (`managerOrAbove`) | - |
| `/admin/support` | `frontend/app/admin/support/page.tsx` | Support ticket inbox with status filter. | Ticket summaries (status, user, subject, dates). | Yes — System → Support | `/admin/support/[id]` |
| `/admin/support/[id]` | `frontend/app/admin/support/[id]/page.tsx` | Reply to / close a single support ticket thread. | Ticket messages + status for one ticket. | No (reached from Support list) | `/admin/support` |
| `/admin/notifications` | `frontend/app/admin/notifications/page.tsx` | Broadcast in-app notifications to all/active/specific users. | Audience picker + title/message compose (no historical table on page). | Yes — System → Notifications | - |
| `/admin/downloads` | `frontend/app/admin/downloads/page.tsx` | Manage downloadable files exposed to users. | DownloadFile rows (name, type, status, path). | Yes — System → Downloads | - |
| `/admin/settings` | `frontend/app/admin/settings/page.tsx` | Platform config: USD/INR rate, partner commission rates, previews. | FX rate settings + partner commission % matrix / preview chains. | Yes — System → Settings | `/admin/tier-settings` (partner economics; different tables) |
| `/admin/debug/inject-trade` | `frontend/app/admin/debug/inject-trade/page.tsx` | Super-admin tool to inject dummy trades / clear dummy PnL for testing. | User picker + inject/clear results (dummy Trade / PnL / commissions). | Yes — Debug Tools → Inject Trade (`superAdminOnly`) | - |

## ORPHAN ROUTES

Pages with **no** entry in `AdminSidebar` `navGroups` (reachable only via in-page links, bookmarks, or redirect):

| Route | How reached | Notes |
| --- | --- | --- |
| `/admin/users/[id]` | Link from `/admin/users` | Detail orphan relative to sidebar |
| `/admin/strategies/[id]` | Link from `/admin/strategies` | Detail orphan relative to sidebar |
| `/admin/support/[id]` | Link from `/admin/support` | Detail orphan relative to sidebar |

All other listed routes appear as direct `href` entries in `AdminSidebar.tsx`.
