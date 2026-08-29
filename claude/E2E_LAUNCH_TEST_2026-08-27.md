# Earner E2E launch test — 2026-08-27

**Environment:** Production (`tradeict-earner-copy-trader`)  
**Test customer:** `+e2e1` / tikhatfoods flow (pay-later subscribe → deploy → copy)  
**Started:** 2026-08-27 · **Last session:** 2026-08-29

---

## RESULT LOG

| Step | Result | Notes | Fix |
|------|--------|-------|-----|
| E1 signup + Delta connect | ✅ | Account created, API keys verified | — |
| E2 subscribe + deploy + copy | ✅ | Pay-later deploy blocked by invoice gate; UI showed DEPLOYED while `isActive=false` | E2-BUG-a/b/c (`542e20d`, `c261f2e`, `1613702`) |
| E3 bot trade lifecycle | ✅ | Copy engine respects `isActive`; bot settings verified 29 Aug | — |
| E4 revenue / billing / admin | ✅ | Empty P&L cards; HWM INR message; admin snapshot/invoice ops | E4-FIX-a/b, E4-BUG-a |
| E5 commission chain | ✅ | Withdrawable card showed gate not amount | E5-BUG-a (`6a73753`) |
| E6 payment | ⛔ PARKED | Razorpay live — needs test keys | — |

---

## Open before E6

1. Switch Razorpay to **test** keys (or dedicated test merchant).
2. Fix `amountInr` rounding — invoice UI ₹1,062.50 vs Razorpay ₹1,087.58 for same bill.
3. Re-run E6: customer pays INVOICED profit-share invoice via Razorpay or wallet.

---

## Session notes

- **2026-08-27:** E2E started; E2 subscription/deploy blockers found and fixed through 29 Aug.
- **2026-08-29:** E5 partner commission chain verified; E5-BUG-a shipped; E6 stopped — live Razorpay, no test keys.
