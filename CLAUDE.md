# Tradeict Earner — Claude / Agent Notes

**Repo:** `tradeict-earner-copy-trader`  
**Production:** PM2 process `tradeict-earner` (backend)

Full progress log: `claude/PROGRESS.md`  
E2E launch test: `claude/E2E_LAUNCH_TEST_2026-08-27.md`

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

---

## 2026-09-03 — W2 Wings / Structure P&L live check

W2 effectively passed live. Delta gross UPL (~$1.36) vs bot Structure P&L net (**-$0.2457**) is expected:

- Delta = open-leg gross only (hedge ~+$0.93 + open basket ~+$0.41)
- Bot net includes crystallized adj-1 loss **-$0.9740** (not in Delta UPL), hedge NET, entry spread, fees, est exit
- Wings LONG math verified: CALL +$0.6596, PUT -$0.1953; correctly in GROSS MTM

---

## 2026-09-03 — DeltaLedger 4-leg wings (iron condor)

Earner structure attribution now supports optional `BASKET_WING_CALL` / `BASKET_WING_PUT`:

- `backend/src/services/structureWings.ts` — heal open wings on closed baskets; discover missing BUY wings from ledger within 60s of shorts (same expiry token)
- `structurePnlService` runs `normalizeStructureForWings` before attribution
- Net credit = short premiums − wing premiums (logged when wings present)
- 2-leg strangles unchanged; Phase 15 suspect/HWM rules unchanged
- Test: `npx tsx src/scripts/testStructureWings.ts`
