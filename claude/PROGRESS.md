# Tradeict Earner — Progress log

**Last updated:** 2026-08-29  
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

---

## What is left

### E6 — PARKED (29 Aug)

Razorpay is in LIVE mode. Test keys needed before E6 can run.

Known issue to fix before E6: invoice shows ₹1,062.50 but Razorpay charges ₹1,087.58 — two different INR figures for the same bill. Fix `amountInr` rounding before enabling test payment.

### Post-launch (not blocking E6)

- Enable `basket_qty_dynamic` (B7/B8) when owner approves
- Stale `.next/types` inject_trade references (frontend `tsc` noise)
- Razorpay `amountInr` vs displayed invoice INR alignment (see E6 above)
