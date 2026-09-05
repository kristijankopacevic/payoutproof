# REUSE_NOTES — code reused from other repositories

PayoutProof has **no runtime dependency on any other repository**. Everything it
reuses is a small, audited local copy recorded here.

## Source

| | |
|---|---|
| Source repository | `github.com/kristijankopacevic/marginproof` (MarginProof + Discount Margin Guard) |
| Source commit | `ba812c8` — "Add PayoutProof: per-payout reconciliation breakdown from Shopify payout CSVs" (2026-09-05); the typed CSV cells originate in `d5fb2de` — "Security: defuse CSV formula injection in every export" |
| Checkpoint | tag `pre-payoutproof-extraction` on the source repository marks the state before the extraction; a git bundle of the same state is kept outside the repository |
| Extraction date | 2026-09-05 |

## Files moved (PayoutProof-owned; verbatim unless noted)

| Source path | Here | Change |
|---|---|---|
| `payouts.html` | `index.html` | canonical / `og:url` → `https://kristijankopacevic.github.io/payoutproof/`; the "Also on this site" paragraph linking the two margin tools replaced by one "From the same independent maker" line; `<link rel="icon" href="data:,">` added so browsers stop requesting a favicon that does not exist. No functional change |
| `src/payouts.js` | `src/payouts.js` | line endings CRLF → LF; the group-key separator was stored as a raw NUL byte inside the string literal and is now written as the `\u0000` escape (same value); import `./audit.js` → `./parse.js`; one comment updated |
| `src/payouts-sample.js` | same | none |
| `tests/payouts.test.mjs` | same | import `../src/audit.js` → `../src/parse.js` |
| `tests/csv.test.mjs` | same | import `../src/audit.js` → `../src/parse.js` |
| `tests/fixtures/payouts/*.csv` (11 files) | same | none |
| `docs/sample/shopify-payout-transactions-DEMO.csv`, `docs/sample/shopify-payouts-DEMO.csv` | same | none (a test asserts they stay byte-identical to the embedded demo) |

## Generic code copied (shared code, not shared identity)

| Source | Here | Functions | Change |
|---|---|---|---|
| `src/audit.js` (MarginProof engine) | `src/parse.js` | `MONEY_UNKNOWN`, `toMinor`, `fromMinor`, `parseCsv`, `parseNumber` | bodies verbatim except one character class in `parseNumber` written `[^\d.,-]` instead of `[^\d.,\-]` (same meaning; satisfies `no-useless-escape`); new header comment; MarginProof-only exports (column detection, margin, audits) not copied |
| `src/csv.js` | `src/csv.js` | `csvText`, `csvNumber`, `csvRow`, `buildCsv` | bodies verbatim; header comment names the source |
| `tests/audit.test.mjs` | `tests/parse.test.mjs` | the parser, number and minor-unit cases | ported to the local module; added: CRLF + blank lines, `null` input, negative minor units |

## Not reused

`src/audit.js` catalogue audit, `src/discount.js`, `index.html`, `discount.html`
and their tests stay in MarginProof. The formula-injection security fix stays in
MarginProof as well, because it protects those two tools' exports; PayoutProof
carries its own copy of the same typed-cell code.

## How to re-audit the copies

```
git -C ../marginproof show ba812c8:src/csv.js | diff - src/csv.js
git -C ../marginproof show ba812c8:src/audit.js   # compare the five exported helpers with src/parse.js
git -C ../marginproof show ba812c8:src/payouts.js | diff - src/payouts.js
```
