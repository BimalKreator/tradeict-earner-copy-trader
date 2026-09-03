# Tradeict Earner — Progress log

**Last updated:** 2026-09-03  
**Repo:** `tradeict-earner-copy-trader` · branch `main`

---

## Standing context

**Production:** `tradeict-earner-copy-trader` deployed via PM2 (`tradeict-earner` backend). Customer E2E launch test started **2026-08-27**; steps **E1–E5** complete as of **2026-08-29**.

**Bot settings verified 2026-08-29:**

- `basket_qty_mode` = `pct_of_hedge`
- `hedge_qty_lots` = 5
- `basket_qty_dynamic` = False (B7/B8 ready, not yet enabled)
- `basket_qty_theta_mult` = 2.0
- `strike_selection_mode` = `theta_based`
- `trade_type` = `straddle`

(Other settings unchanged: `flat_trigger_pct=160`, `basket_exit_spread_pct=4.0`, etc.)

**USD/INR:** `SystemSettings.usdInrRate = 85` (set 2026-08-25).

**Razorpay:** LIVE mode keys on production — E6 payment step parked until test keys available.

---

## What is done (E2E session highlights)

| Area | Status | Notes / commits |
|------|--------|-----------------|
| E1–E5 E2E | ✅ | See `claude/E2E_LAUNCH_TEST_2026-08-27.md` |
| Pay-later + deploy | ✅ | E2-BUG-b (`c261f2e`) — overdue-only invoice gate; UI uses `isActive` |
| Dashboard empty P&L | ✅ | E2-BUG-c (`1613702`) — empty ≠ load failure |
| Admin revenue ops | ✅ | E4-FIX-a (`8dfd22d`), E4-FIX-b (`8621623`) |
| Performance HWM INR | ✅ | E4-BUG-a (`ecd3144`) |
| Partner withdrawable card | ✅ | E5-BUG-a (`6a73753`) — card shows matured amount, `netBalanceGate` only gates payout |
| Play Store v3 arb gate | ✅ | `069cc36` — `arbAccess` default false; Dex Arbitrage / Arbitrage Trades hidden unless granted |
| W2 wings P&L check | ✅ | Live: bot Structure net -$0.2457 correct vs Delta gross ~$1.36; wing LONG math verified |
| DeltaLedger 4-leg wings | ✅ | `structureWings.ts` — heal open wings, discover BUY wings within 60s, net_credit = shorts−wings |

---

## What is left

### E6 — PARKED (29 Aug)

Razorpay is in LIVE mode. Test keys needed before E6 can run.

Known issue to fix before E6: invoice shows ₹1,062.50 but Razorpay charges ₹1,087.58 — two different INR figures for the same bill. Fix `amountInr` rounding before enabling test payment.

### Post-launch (not blocking E6)

- Enable `basket_qty_dynamic` (B7/B8) when owner approves
- Stale `.next/types` inject_trade references (frontend `tsc` noise)
- Razorpay `amountInr` vs displayed invoice INR alignment (see E6 above)
- Play Store: build versionCode 4 (`1.0.3`), update screenshots (no Dex Arbitrage for regular users), resubmit

---

## 2026-09-03 — Play Store v3 Rejection Fix

Play Store versionCode 3 rejected with two issues:

1. Screenshots showed features not present (Dex Arbitrage / Arbitrage Trades in sidebar)  
   Fix: Screenshots update karne hain manually in Play Console
2. Dex Arbitrage / Arbitrage Trades visible to regular users (server running old code)

Fix deployed (commit `069cc36`, 13 files changed):

- User model: `arbAccess Boolean @default(false)` added
- Migration: `backend/prisma/migrations/20260903120000_add_arb_access/migration.sql`  
  NOTE: Migration had BOM encoding issue — fixed with sed before deploy
- `frontend/lib/dashboardNav.ts`: Arbitrage group with `arbAccessOnly: true` flag  
  Hidden unless `user.arbAccess === true`
- `frontend/context/AuthContext.tsx`: `arbAccess` exposed from user object
- `frontend/components/dashboard/DashboardSidebar.tsx` + `BottomTabBar.tsx`:  
  Pass `arbAccess` to `visibleDashboardNavGroups()`
- `frontend/app/dashboard/dex-arbitrage/page.tsx`: Shows `DexArbitrageTable` if  
  `arbAccess=true`, else redirects to `/dashboard`
- `frontend/app/dashboard/arbitrage-trades/page.tsx`: Same guard
- `frontend/app/admin/users/[id]/page.tsx`: Admin toggle to grant/revoke `arbAccess`
- Admin sidebar `/admin/dex-arbitrage` — UNCHANGED, admins still see it

### BOM Migration Trap (IMPORTANT for future migrations)

Cursor on Windows may save migration SQL files as UTF-8 with BOM.  
PostgreSQL rejects this with `syntax error at or near` error (code `42601`).

Server fix:

```bash
sed -i '1s/^\xEF\xBB\xBF//' prisma/migrations/<name>/migration.sql
npx prisma migrate resolve --rolled-back <name>
npx prisma migrate deploy
```

### Next

Build versionCode 4 (`1.0.3`), update screenshots, resubmit to Play Store.
