# Admin Debug / Danger Tools — 400 Diagnosis (Task 16.7a)

**Date:** 2026-08-27  
**Scope:** Why admin debug/danger actions return `400 Bad Request`, with focus on typed-confirmation guards added in Phase 14.8.  
**Method:** Read `backend/src/utils/requireTypedConfirmation.ts`, route handlers, and every frontend caller. No code was changed.

---

## How typed confirmation works (backend)

All guards use `requireTypedConfirmation(req, res, expected)` in `backend/src/utils/requireTypedConfirmation.ts`:

- **Field name:** `confirmation` (in JSON request body)
- **Comparison:** `body.confirmation.trim()` must **exactly equal** `expected` (case-sensitive)
- **On failure:** HTTP **400** with `{ error: "Typed confirmation required", expectedHint: "Type exactly: …" }`

**Exception:** Platform flush-all uses a different field — see §8 below.

---

## 1. Inject test trade

| | |
|---|---|
| **Route** | `POST /api/admin/debug/inject-trade` (alias: `POST /api/admin/debug/inject-dummy-trade`) |
| **Auth** | `superAdminOnly` (403 if not SUPER_ADMIN) |
| **Backend expects** | `body.confirmation === "INJECT TEST TRADE"` (constant `CONFIRM_INJECT_TEST_TRADE`) |
| **Also required after confirmation** | `userId` (string), `grossPnl` (finite number); optional `symbol`, `strategyId` |
| **Frontend file** | `frontend/app/admin/debug/inject-trade/page.tsx` |
| **Frontend sends** | After `ConfirmDestructiveModal` confirms: |

```json
{
  "userId": "<uuid>",
  "grossPnl": 3.42,
  "confirmation": "INJECT TEST TRADE",
  "symbol": "<optional>",
  "strategyId": "<optional>"
}
```

| **MISMATCH** | **None for `confirmation`.** Current UI opens a modal, requires typing `INJECT TEST TRADE`, and passes that string in the POST body. Field name and value match the backend. |
| **FIX NEEDED** | **No frontend change needed for confirmation.** If 400 persists after typing the phrase correctly, it is a **post-confirmation validation error**, not a missing guard. Common 400 messages: `userId is required`, `grossPnl must be a finite number`, `User not found`, `Strategy not found`, `User has no strategy subscription — subscribe them or pass strategyId`. Fix data inputs or subscribe the user. |

**Secondary note:** `runInjectTrade` uses raw `fetch` with `authHeaders()` only — it does **not** spread `adminRequestInit()` (`credentials: "include"`). Cross-origin deployments may get **401/403** instead of reaching confirmation logic; that is separate from 400.

---

## 2. Clear all dummy trades

| | |
|---|---|
| **Route** | `DELETE /api/admin/debug/clear-dummy-trades` |
| **Auth** | `superAdminOnly` |
| **Backend expects** | `body.confirmation === "CLEAR DUMMY TRADES"` (constant `CONFIRM_CLEAR_DUMMY_TRADES`) |
| **Frontend file** | `frontend/app/admin/debug/inject-trade/page.tsx` → `runClearDummyTrades` |
| **Frontend sends** | After modal confirms: |

```json
{ "confirmation": "CLEAR DUMMY TRADES" }
```

HTTP method: **DELETE** with `Content-Type: application/json` body.

| **MISMATCH** | **Transport / method, not field name.** The UI *does* send the correct `confirmation` value, but uses **DELETE with a JSON body**. Many proxies, load balancers, and HTTP clients treat DELETE bodies as optional and may **drop the body** before it reaches Express. Backend then sees `body.confirmation` as missing → **400** `Typed confirmation required` even when the admin typed the phrase correctly. |
| **FIX NEEDED** | **Backend (preferred):** add `POST /api/admin/debug/clear-dummy-trades` (or accept confirmation in a supported channel) and keep DELETE as deprecated alias. **Or frontend:** call POST if backend adds it. **Do not** rely on DELETE + JSON body in production. Also add `...adminRequestInit()` to the fetch for cross-origin cookie auth. |

---

## 3. Delta revenue simulation — run scenario

| | |
|---|---|
| **Route** | `POST /api/admin/simulate/structure` |
| **Auth** | `superAdminOnly` |
| **Backend expects** | **No typed confirmation.** Requires `userId`, `scenario` ∈ `{PROFIT, LOSS, PROFIT_THEN_LOSS_THEN_PROFIT}`; optional `realizedPnl`, `closedAtIst`. User must have `allowSimulation=true` or backend returns **403**. |
| **Frontend file** | `frontend/components/admin/AdminUserSimulationPanel.tsx` |
| **Frontend sends** | `{ userId, scenario, realizedPnl?, closedAtIst? }` — no `confirmation` field |

| **MISMATCH** | **None** (confirmation not required). 400 here means bad `userId`/`scenario`/`realizedPnl`, not missing confirmation. |
| **FIX NEEDED** | None for confirmation. Enable `allowSimulation` on the user if you see 403. |

---

## 4. Delta revenue simulation — purge

| | |
|---|---|
| **Route** | `POST /api/admin/simulate/purge` |
| **Auth** | `superAdminOnly` |
| **Backend expects** | **No typed confirmation.** Body: `{ userId }`. |
| **Frontend file** | `frontend/components/admin/AdminUserSimulationPanel.tsx` |
| **Frontend sends** | `{ userId }` |

| **MISMATCH** | **None.** 409 if purge blocked (`SimulationPurgeBlockedError`); not a confirmation issue. |
| **FIX NEEDED** | None for confirmation. |

---

## Related admin danger actions (not on Inject Trade page)

These also use typed confirmation or a variant. Included because admins often confuse them with “debug tools” when they 400.

### 5. Close all live positions (per strategy)

| | |
|---|---|
| **Route** | `POST /api/admin/live-trades/close-all` |
| **Backend expects** | `confirmation === "CLOSE ALL POSITIONS"` + `strategyId` |
| **Frontend** | `frontend/app/admin/live-trades/page.tsx` → `{ strategyId, confirmation }` |
| **MISMATCH** | **None for confirmation.** Missing `adminRequestInit()` on fetch (auth cookie risk). |
| **FIX NEEDED** | Add `adminRequestInit()` if cross-origin; otherwise aligned. |

### 6. Sync all followers to master

| | |
|---|---|
| **Route** | `POST /api/admin/live-trades/sync-all-followers` |
| **Backend expects** | `confirmation === "SYNC ALL FOLLOWERS"` + `strategyId` |
| **Frontend** | `live-trades/page.tsx` → `{ strategyId, confirmation }` |
| **MISMATCH** | **None for confirmation.** Same missing `adminRequestInit()` note. |
| **FIX NEEDED** | Add `adminRequestInit()` if cross-origin. |

### 7. Flush one user’s trades

| | |
|---|---|
| **Route** | `POST /api/admin/users/flush-trades` |
| **Backend expects** | `confirmation === <that user's email>` + `userId`; optional `tradeIds[]` |
| **Frontend** | `frontend/app/admin/users/[id]/page.tsx` → `{ userId, confirmation, tradeIds? }` |
| **MISMATCH** | **None.** |
| **FIX NEEDED** | None. |

### 8. Flush all platform trades

| | |
|---|---|
| **Route** | `POST /api/admin/trades/flush-all` |
| **Backend expects** | **`confirmPhrase`** (not `confirmation`) `=== "FLUSH ALL TRADES"`; optional `includeOpen`, `purgeFinancialsOnly` |
| **Frontend** | `frontend/app/admin/trade-history/page.tsx` → `{ confirmPhrase, includeOpen }` |
| **MISMATCH** | **None** — frontend correctly uses `confirmPhrase`. |
| **FIX NEEDED** | None. |

### 9. Delete user

| | |
|---|---|
| **Route** | `DELETE /api/admin/users/:id` |
| **Backend expects** | `confirmation === target user's email` |
| **Frontend** | `users/[id]/page.tsx` → DELETE body `{ confirmation }` via `adminRequestInit()` |
| **MISMATCH** | **Possible DELETE-body drop** (same class of issue as §2), though less reported because modal + email typing is explicit. |
| **FIX NEEDED** | Consider POST alias if DELETE body loss is confirmed in prod. |

### 10. Wallet adjust (ADD / REMOVE)

| | |
|---|---|
| **Route** | `POST /api/admin/wallet/users/:userId/adjust` |
| **Backend expects** | `confirmation === walletAdjustConfirmationPhrase(type, amount, email)` e.g. `ADD 10.00 to user@example.com` |
| **Frontend** | `AdjustWalletFundsModal.tsx` → `{ type, amount, reason, confirmation }` |
| **MISMATCH** | **None** — phrase builder matches backend (`toFixed(2)`, trimmed email). |
| **FIX NEEDED** | None. |

### 11. Void revenue invoice

| | |
|---|---|
| **Route** | `POST /api/admin/revenue/invoice/:id/status` with `{ status: "VOID", reason, confirmation }` |
| **Backend expects** | `confirmation === invoice owner's email` (only when voiding) |
| **Frontend** | `AdminDeltaRevenueDashboard.tsx` → sends `confirmation` + `reason` |
| **MISMATCH** | **None.** |
| **FIX NEEDED** | None. |

### 12. Invoice credit note

| | |
|---|---|
| **Route** | `POST /api/admin/revenue/invoice/:id/credit-note` |
| **Backend expects** | `confirmation === invoice owner's email` + `amount`, `reason` |
| **Frontend** | `AdminDeltaRevenueDashboard.tsx` |
| **MISMATCH** | **None.** |
| **FIX NEEDED** | None. |

### 13. Close structure & finalise billing

| | |
|---|---|
| **Route** | `POST /api/admin/users/:id/close-structure-and-finalise-billing` |
| **Backend expects** | `confirmation === user's email` |
| **Frontend** | `AdminUserStructureBillingPanel.tsx` → `{ confirmation }` |
| **MISMATCH** | **None.** |
| **FIX NEEDED** | None. |

### 14. Partner payout reject / complete

| | |
|---|---|
| **Routes** | `POST /api/admin/payouts/:id/reject`, `POST /api/admin/payouts/:id/complete` |
| **Backend expects** | `confirmation === payout.user.email`; reject also needs `reason`; complete needs `paymentReference` |
| **Frontend** | `frontend/app/admin/payouts/page.tsx` inline email field → `{ confirmation, reason? / paymentReference? }` |
| **MISMATCH** | **None.** Approve action does **not** require confirmation. |
| **FIX NEEDED** | None. |

---

## Summary: original hypothesis vs code today

| Hypothesis | Verdict |
|---|---|
| “Backend requires typed confirmation but Inject Trade UI never sends it” | **Outdated for current repo.** `inject-trade/page.tsx` uses `ConfirmDestructiveModal` with `expectedConfirmation="INJECT TEST TRADE"` / `"CLEAR DUMMY TRADES"` and passes `confirmation` in the request body. |
| “All debug tools 400 because of confirmation” | **Partially true for Clear Dummy Trades** — likely **DELETE body not arriving**, so backend sees empty `confirmation`. Inject trade confirmation is aligned; other 400s are validation/business rules. |

---

## Admin danger actions requiring confirmation — status

| # | Action | Route | Confirmation expected | UI sends it? | Works? |
|---|--------|-------|----------------------|--------------|--------|
| 1 | Inject test trade | `POST …/debug/inject-trade` | `INJECT TEST TRADE` | Yes (modal) | **Yes** (confirmation OK; other 400s = bad input) |
| 2 | Clear dummy trades | `DELETE …/debug/clear-dummy-trades` | `CLEAR DUMMY TRADES` | Yes (modal) | **Likely NO in prod** (DELETE body dropped) |
| 3 | Close all positions | `POST …/live-trades/close-all` | `CLOSE ALL POSITIONS` | Yes | **Yes** |
| 4 | Sync all followers | `POST …/live-trades/sync-all-followers` | `SYNC ALL FOLLOWERS` | Yes | **Yes** |
| 5 | Flush user trades | `POST …/users/flush-trades` | User email | Yes | **Yes** |
| 6 | Flush all trades | `POST …/trades/flush-all` | `confirmPhrase`: `FLUSH ALL TRADES` | Yes | **Yes** |
| 7 | Delete user | `DELETE …/users/:id` | User email | Yes | **Mostly yes** (DELETE body risk) |
| 8 | Wallet adjust | `POST …/wallet/users/:id/adjust` | `ADD/REMOVE {amt} to/from {email}` | Yes | **Yes** |
| 9 | Void invoice | `POST …/revenue/invoice/:id/status` | Customer email | Yes | **Yes** |
| 10 | Credit note | `POST …/revenue/invoice/:id/credit-note` | Customer email | Yes | **Yes** |
| 11 | Finalise billing | `POST …/close-structure-and-finalise-billing` | Customer email | Yes | **Yes** |
| 12 | Payout reject/complete | `POST …/payouts/:id/reject\|complete` | Partner email | Yes | **Yes** |

**Totals:** **12** admin danger actions use typed confirmation (or `confirmPhrase` for flush-all).  
**Likely broken from UI today:** **1** — Clear dummy trades (`DELETE` + JSON body).  
**At risk:** **1** — Delete user (same DELETE-body pattern).  
**Simulate run/purge:** no confirmation guard (not counted above).

---

## Recommended fix order (for 16.7b+)

1. **Clear dummy trades** — add `POST` handler (or query-safe confirmation) so body reliably reaches backend.  
2. **Inject Trade page fetches** — wrap with `adminRequestInit()` for consistent cookie auth.  
3. **Live Trades bulk ops** — same `adminRequestInit()` pass.  
4. Keep confirmation phrases as-is; no backend loosening needed for inject-trade POST.
