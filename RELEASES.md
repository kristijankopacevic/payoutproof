# PayoutProof — release history

## 1.0.0 — 2026-09-05 — own repository, same V1

- Extracted from the MarginProof site (`github.com/kristijankopacevic/marginproof`,
  commit `ba812c8`) into this repository without functional change; see
  `REUSE_NOTES.md`.
- Canonical URL: https://kristijankopacevic.github.io/payoutproof/ . The previous
  address `https://kristijankopacevic.github.io/marginproof/payouts.html` now
  redirects here and no longer processes files.
- Gates recorded at release: `npm test` (61 tests), typecheck (`tsc --checkJs`,
  0 errors), ESLint (0 problems), secret scan (0 hits), browser smoke (TRY
  SAMPLE, synthetic upload, both exports, CLEAR DATA), 375 px mobile smoke,
  production privacy audit (no request of any kind after file selection).

## V1 (first publication) — 2026-09-05 — as `marginproof/payouts.html`

- Per-payout grouping of the Shopify Payments balance-transactions export;
  optional payouts-export matching (MATCHED / DIFFERENCE / NO_PAYOUT_ROW /
  PENDING_NOT_PAID / AMBIGUOUS_MATCH / INCOMPLETE_SOURCE / UNMATCHED_PAYOUT_ROW);
  findings; unknown/missing report; two CSV exports with provenance; TRY SAMPLE
  with embedded synthetic data; CLEAR DATA.
- Engineering freeze after publication until real-user evidence exists: no
  QuickBooks/Xero/DATEV output, journal lines, VAT or tax logic, Shopify API or
  OAuth, multi-store, AI features or billing.
