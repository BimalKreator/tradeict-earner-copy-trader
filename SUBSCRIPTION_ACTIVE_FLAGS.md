# E2-BUG-a — Subscription `status` vs `isActive` (diagnosis only)

**Date:** 2026-08-27  
**Symptom:** New “Subscribe & Pay Later” rows land as `status = ACTIVE`, `isActive = false`, `isStrategyFeePaid = false`. UI shows ACTIVE; copy engines refuse to trade.  
**Evidence (prod):** older unpaid ACTIVE rows have `isActive = true`; new `+e2e1` pay-later row has `isActive = false`.

No code or DB was changed for this task.

---

## 1. Ways a subscription is created

| # | Path | Entry | File / lines | `status` | `isActive` | Fee flags |
|---|------|--------|--------------|----------|------------|-----------|
| A | **Pay Later** (customer) | `POST /subscriptions/subscribe` with `paymentMode: "PAY_LATER"` | Frontend: `StrategySubscriptionCheckout.tsx` ~151–166 → backend `subscribeUserToStrategy` → `createStrategySubscriptionWithPaymentMode` | `ACTIVE` | **`false`** (hard-coded) | `isStrategyFeePaid = false` if fee &gt; 0; creates pending `STRATEGY_FEE` invoice |
| B | **Pay Later create helper** | Called by A (and admin when PAY_LATER + fee &gt; 0) | `strategySubscriptionService.ts` **353–401** — comment: *“Active subscription status; deploy still binds exchange account + isActive.”* Create at **394–395**: `isActive: false`, `status: ACTIVE` | `ACTIVE` | **`false`** | fee unpaid unless `finalFeeInr ≤ 0` |
| C | **Zero-fee / skip gateway** | `subscribeUserToStrategy` when fee is 0 (or not PAY_LATER with fee) | `strategySubscriptionService.ts` **688–703** — activity log: *“Added strategy to My Strategies (inactive)”* | `ACTIVE` | **`false`** | `isStrategyFeePaid: true` |
| D | **Pay Now (Razorpay)** | Checkout → `payments/create-order` + `payments/verify` | `paymentController.ts` **492–503**: create with `isActive: false`, **`status: PAUSED_DUE_TO_FUNDS`**, `isStrategyFeePaid: true` | `PAUSED_DUE_TO_FUNDS` | **`false`** | fee marked paid |
| E | **Admin subscribe** | Admin onboarding / `adminSubscribeUser` | `adminController.ts` **3654–3698** → same `subscribeUserToStrategy` as A/C (default paymentMode **PAY_LATER**) | Same as A or C | Same as A or C | Same |
| F | **Reviewer seed script** | `seedReviewerAccount.ts` | **~236–250**: `status: ACTIVE`, **`isActive: true`**, `isStrategyFeePaid: true` | `ACTIVE` | **`true`** | fee treated paid |
| G | **Deploy** (not create, but flips flags) | `POST …/subscriptions/:strategyId/deploy` | `subscriptionController.ts` **561–568**: sets `isActive: true`, `status: ACTIVE` after exchange account + capital; blocks if unpaid invoices | `ACTIVE` | **`true`** | unchanged |
| H | **Pay strategy-fee invoice** | Wallet / gateway invoice pay | `billingService.ts` **534–547** and **703–716**: on `STRATEGY_FEE` paid → `isStrategyFeePaid: true`, `status: ACTIVE`, **`isActive: true`** | `ACTIVE` | **`true`** | paid |
| I | **Resume after voluntary pause** | Lifecycle resume | `subscriptionLifecycleService.ts` **267–274**: `isActive: true`, `status: ACTIVE` | `ACTIVE` | **`true`** | — |
| J | **Admin toggle deploy** | Admin patch subscription `isActive` | `adminController.ts` **3840–3848**: `isActive: true` also forces `status: ACTIVE` | often `ACTIVE` | as set | — |

### Pay Later call chain (the bug path)

1. UI button **“Subscribe & Pay Later”** → `paymentMode: "PAY_LATER"`  
   (`frontend/components/strategies/StrategySubscriptionCheckout.tsx` ~151–166)
2. `subscribeUserToStrategy` (`strategySubscriptionService.ts` ~675–687)  
3. `createStrategySubscriptionWithPaymentMode` (**394–395**):  
   `isActive: false` + `status: SubscriptionStatus.ACTIVE`

**Root cause of the reported row:** not a random race — **pay-later create intentionally writes `isActive: false` while setting lifecycle `status` to `ACTIVE`.**

Older prod rows with `ACTIVE` + `isActive = true` + unpaid fee likely came from **deploy (G)**, **invoice pay (H)**, **admin toggle (J)**, or an older code path — not from the current pay-later create alone.

---

## 2. Who reads `UserStrategySubscription.isActive` (and what if false)

| Location | Behavior when `isActive === false` |
|----------|-------------------------------------|
| `strategySubscriptionService.ts` `activeStrategySubscriptionWhere` (~27–36) | Excluded from copy roster (`isActive: true` AND `status: ACTIVE`) |
| `findActiveCopySubscribersForStrategy` / `findActiveCopySubscriptionForUser` | Not returned → no automatic copy |
| `tradeEngine.ts` ~2146 | Sync/copy throws: *“User copy subscription is inactive (isActive is false).”* |
| `followerTradeExecution.ts` ~2464 | Open/add-lots fails with same inactive error |
| `followerTradeExecution.ts` ~2708 (admin force sync) | Still refuses if `!sub.isActive` |
| `adminController.ts` ~3646 | Bot “copy trading live” UI signal requires `isActive === true` (and not `copyTradingPaused`) |
| `subscriptionLifecycleService.ts` pause (~200) | Sets `isActive: false` (+ paused status) |
| `billingCronService` / cancel (~54) | Sets `isActive: false` on cancel |
| `liveTradesService` / `livePriceTracker` / `autoExitService` / etc. | Query filters usually require `isActive: true` for live/copy contexts |

**Note:** `Strategy.isActive` is a **different** field (strategy paused globally). Do not confuse with subscription `isActive`.

---

## 3. Who reads `status` (`SubscriptionStatus`)

| Location | Role of `status` |
|----------|------------------|
| `activeStrategySubscriptionWhere` | Must be `ACTIVE` **and** `isActive: true` for copy |
| Dashboard strategies UI (`strategies/page.tsx` ~99–123) | Badge/label from **`status` only** — `ACTIVE` → “Deployed”, non-ACTIVE → “Inactive” (**ignores `isActive`**) |
| Subscribe uniqueness / managed list | `MANAGED_SUBSCRIPTION_STATUSES` includes ACTIVE / paused variants |
| `billingService` unpaid pause | Moves to `PAUSED_DUE_TO_FUNDS`; pay restores `ACTIVE` |
| Cancel / final invoice | Sets `CANCELLED` (+ `isActive: false`) |
| Pause/resume lifecycle | `PAUSED_BY_USER` (voluntary) vs `ACTIVE` |
| Pay-now verify create | Starts as `PAUSED_DUE_TO_FUNDS` until deploy/funds path |
| Analytics / affiliate / dashboards | Often filter `status === ACTIVE` for “has subscription” |

---

## 4. Intended meaning of the two flags

They are **not** duplicates. Code comments and create paths treat them as:

| Flag | Intended meaning |
|------|------------------|
| **`status`** | **Lifecycle / commercial state** of the subscription membership: subscribed (`ACTIVE`), user-paused, funds-paused, cancelled. Pay Later sets this to `ACTIVE` so the user “has” the strategy (billing cycle / My Strategies / fee invoice). |
| **`isActive`** | **Deploy / copy switch**: whether this user should receive copied trades right now. Bound to having deployed (exchange account + capital) or being explicitly resumed/toggled. Create paths that only “add to My Strategies” leave it **`false`** until deploy or fee-pay side-effects. |

Supporting quotes:

- `createStrategySubscriptionWithPaymentMode` (service ~353–355): *“Active subscription status; deploy still binds exchange account + isActive.”*
- Zero-fee create activity (~718): *“Added strategy to My Strategies (inactive)”*
- Deploy (~561–568): first place that typically turns **`isActive` true** after customer subscribe without paying via invoice helper

So: **`isActive` ≈ “customer is deployed / bot may copy”**; **`status` ≈ lifecycle membership.** The danger is the **UI** collapsing both into one “ACTIVE / Deployed” signal.

---

## 5. Recommendation

### Should pay-later set `isActive = true`?

**No — not on subscribe alone.** Turning `isActive` true without a bound exchange account (and without clearing unpaid-fee gates) would invite copy attempts against incomplete deployments. The engine’s `isActive` checks are correct safety rails.

**Do not** “fix” by only changing create line 394 to `isActive: true` without also requiring deploy credentials and clarifying unpaid-fee policy.

### What to change instead (for a follow-up fix task)

1. **UI (highest leverage):** My Strategies / admin member views must not label a row “Deployed” / “ACTIVE” from `status` alone. Show e.g. **“Subscribed — not deployed”** when `status === ACTIVE && !isActive`, and **“Copying”** only when both are true. That matches production confusion.
2. **Optional product rule:** After pay-later, force a clear **Deploy** CTA; block confusing ACTIVE badges until deploy succeeds.
3. **Optional consistency:** When strategy-fee invoice is paid (`billingService` ~544 / ~713), setting `isActive: true` without exchange account may also be too eager — consider setting `isActive: true` only if `exchangeAccountId` is already set; otherwise leave false and prompt deploy. (Separate from this diagnosis.)
4. **Trade engine:** Keep requiring `isActive === true`. Do not weaken `tradeEngine` / `followerTradeExecution` to treat `status === ACTIVE` as enough.

### If you still want one-line backend tweak for pay-later

Only if product insists “pay later = start copying immediately”:  
`strategySubscriptionService.ts` ~394 `isActive: false` → `true` **and** simultaneously enforce that deploy/credentials already exist (today they do not on create). **Without that, do not flip the line.**

---

## Summary answer to the bug title

**Why does “Subscribe & Pay Later” leave `isActive = false`?**  
Because `createStrategySubscriptionWithPaymentMode` **deliberately** creates `status: ACTIVE` + `isActive: false` so membership/billing start while copy stays off until **deploy** (or certain pay/admin paths). The bug users feel is mainly **UX / dual-flag mismatch**, not a missing assignment in pay-later.
