# Tradeict Earner (copy trader)

Monorepo: `backend/` (Express + Prisma) and `frontend/` (Next.js + TWA).

## Play Store reviewer account

Google Play reviewers need a working sign-in. Use the seed script — it creates an
**ordinary** user (password + `isOtpBypassed` after a correct password). It does
**not** restore the deleted hardcoded reviewer backdoor from task 14.2.

### Create / refresh the account

From `backend/` (requires `DATABASE_URL` in `.env`):

```bash
REVIEWER_EMAIL='tradeictdevelopers+review@gmail.com' \
REVIEWER_PASSWORD='<strong-password-you-choose>' \
npx tsx src/scripts/seedReviewerAccount.ts
```

Or with argv:

```bash
npx tsx src/scripts/seedReviewerAccount.ts \
  --email 'tradeictdevelopers+review@gmail.com' \
  --password '<strong-password-you-choose>'
```

The script refuses to run without both values (no defaults in source). It aborts
if the email is the protected executive address `tradeictdevelopers@gmail.com`
(user `695f8b44-0af1-4d87-908b-38d9c942745a`), if the domain is not on the
allowlist, or if the address fails the app’s email format check.

### Play Console

Paste the same email and password under **App content → App access** so
reviewers can sign in.

### After publication

Rotate the reviewer password or disable the account once the listing is live.
Do not leave a long-lived shared password in the console indefinitely.
