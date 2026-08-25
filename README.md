# Tradeict Earner Copy Trader

## Play Store reviewer account

Google Play reviewers need a working sign-in. Create an **ordinary** demo user
(no auth backdoors) with:

```bash
cd backend
REVIEWER_EMAIL='tradeictdevelopers+review@gmail.com' \
REVIEWER_PASSWORD='<strong-unique-password>' \
npx tsx src/scripts/seedReviewerAccount.ts
```

Or with argv:

```bash
cd backend
npx tsx src/scripts/seedReviewerAccount.ts \
  --email='tradeictdevelopers+review@gmail.com' \
  --password='<strong-unique-password>'
```

Put those same credentials in Play Console under **App content → App access**.

Notes:

- The script refuses to run without `REVIEWER_EMAIL` / `REVIEWER_PASSWORD` (no
  hardcoded defaults).
- It aborts if the address normalises to `tradeictdevelopers@gmail.com`
  (executive user `695f8b44-0af1-4d87-908b-38d9c942745a`) — never reuse that
  account.
- The domain must be on the live email allowlist (`gmail.com` is allowed by
  default).
- `isOtpBypassed=true` only skips OTP **after** a correct password.
- No ExchangeAccount / API keys and no fabricated trades, wallet balance, or
  revenue.
- After the app is published, **rotate the password or disable the account**.
