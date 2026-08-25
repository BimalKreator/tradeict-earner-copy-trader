# Tradeict Earner

## Play Store reviewer account

Google Play reviewers need a working sign-in. Seed an ordinary demo user (not an auth backdoor) with:

```bash
cd backend
REVIEWER_EMAIL='tradeictdevelopers+review@gmail.com' REVIEWER_PASSWORD='<strong-secret>' npx tsx src/scripts/seedReviewerAccount.ts
```

Or with argv:

```bash
cd backend
npx tsx src/scripts/seedReviewerAccount.ts --email='tradeictdevelopers+review@gmail.com' --password='<strong-secret>'
```

Put the same email and password into Play Console under **App content → App access**.

Notes:

- The account is `isOtpBypassed=true` so login skips OTP **only after a correct password**.
- It has an ACTIVE strategy subscription and **no** ExchangeAccount / API keys — empty genuine wallet and trade states.
- Do **not** use `tradeictdevelopers@gmail.com` (user `695f8b44-…`); the script aborts if that address is supplied.
- Rotate the password or disable the account once the app is published / review is finished.
