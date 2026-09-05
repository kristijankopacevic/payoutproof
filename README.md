# PayoutProof

**Shopify payout reconciliation, in your browser. Turn a Shopify payout CSV into a clean reconciliation breakdown.**

Drop in the **Shopify Payments balance-transactions export** (Finance › Payouts ›
View transactions › Export) and, optionally, the **payouts export** (one row per
payout). PayoutProof groups every transaction under its payout, adds up gross
charges, refunds, adjustments, disputes and fees in integer cents, shows both
Σ(Amount − Fee) and Σ(Net), and — when the payouts export is present — reports
each payout as **MATCHED** or as an exact signed **DIFFERENCE** against the total
Shopify reported.

Open `index.html`. That is the whole thing. No account, no Shopify app to
install, no server, no upload of your file contents.

Live: **https://kristijankopacevic.github.io/payoutproof/**

---

## Who it is for

Merchants and the bookkeepers or accountants who close their books. The bank
shows one deposit per payout; the sales report shows orders. Between them sit
refunds that settled in a later payout, adjustments, disputes and fees. People
rebuild that per-payout split by hand every month, or pay a monthly sync app they
do not fully trust. PayoutProof produces the split from the files Shopify already
gives you, and a CSV your accountant can open.

## What it does

| Output | Content |
|---|---|
| Payout summary | Per payout: transaction count, gross charges, refunds, adjustments, disputes, reserves, transfers, other, total fees, Σ(Amount − Fee), Σ(Net), reported total, signed difference, match status |
| Totals | Per currency only. A cross-currency total is `NOT_AVAILABLE_FROM_SOURCE`, never a sum |
| Findings | Unknown transaction types, Amount − Fee ≠ Net rows, possible duplicates, unexpected signs, negative fees, zero amounts, ragged rows, ambiguous negatives, ambiguous payout matches |
| Unknown / missing | Every value the source did not carry, listed rather than zeroed |
| Exports | `payoutproof-payout-summary.csv` and `payoutproof-transaction-detail.csv` (raw value, normalised value, source file, row, column, transformation on every amount) |

Match statuses: `MATCHED`, `DIFFERENCE`, `NO_PAYOUT_ROW`, `PENDING_NOT_PAID`,
`AMBIGUOUS_MATCH`, `INCOMPLETE_SOURCE`, `UNMATCHED_PAYOUT_ROW`.

## What it refuses to do

- **UNKNOWN is not ZERO.** A missing column or unreadable cell is
  `NOT_AVAILABLE_FROM_SOURCE`, never 0, and a payout with an unknown operand is
  `INCOMPLETE_SOURCE`, never "reconciled".
- **Matching fails safe.** Payout ID when both files carry it; otherwise date +
  currency only when exactly one candidate exists. Two payouts on the same day
  in the same currency are `AMBIGUOUS_MATCH`, never pick-first. Bank Reference is
  displayed, never used as identity.
- **Reported Net is kept next to calculated Net.** Every row's Amount − Fee is
  checked against the Net Shopify exported; the aggregate states which figure is
  compared with the payout total and why. Neither replaces the other.
- **Types are mapped by an explicit table.** An unlisted `Type` value is counted
  under "other" and raised as a finding rather than guessed.
- **No VAT, tax or accounting treatment.** The `VAT` column, if present, is shown
  only as "VAT value as provided in Shopify export" and enters no arithmetic.
  PayoutProof organises and reconciles source data; it does not post to
  QuickBooks or Xero, match bank statements, or give accounting or tax advice.
- **Deterministic arithmetic.** Integer minor units throughout; no model, no
  estimate, no floating-point sums.

## Privacy, stated precisely

Your uploaded Shopify CSV files are processed locally in your browser.
PayoutProof does not upload the contents of those files to a server.

Loading the page fetches its own HTML and JavaScript like any website; after
that, selecting, reconciling and exporting files makes no network request at
all. There are no analytics, no telemetry and no storage: nothing is written to
localStorage, and reloading the page erases everything. CLEAR DATA resets the
page without a reload. TRY SAMPLE uses synthetic data embedded in the page and is
labelled DEMO DATA. This behaviour is verified in a real browser against the
published page before each release (see `RELEASES.md`).

## Supported files

- Shopify Payments **balance-transactions export**: `Transaction Date, Type,
  Order, Card Brand, Card Source, Payout Status, Payout Date, Available On,
  Amount, Fee, Net, Checkout, Payment Method Name, Presentment Amount,
  Presentment Currency, Currency, VAT` (+ `Payout ID` in newer exports). Columns
  are detected by name in any order; optional columns may be absent.
- Shopify **payouts export**: `Payout Date, Status, Charges, Refunds,
  Adjustments, Reserved Funds, Fees, Retried Amount, Total, Currency`
  (+ `Bank Reference`, `Payout ID` in newer exports).
- UTF-8 with or without BOM, LF or CRLF, European or anglo number formats.
  UTF-16 files are refused with a "re-save as UTF-8" message. Files above 25 MB
  or 200 000 rows are refused before parsing.

## Running it

```
open index.html          # that's it
npm test                 # 61 tests, no dependencies, no build step
```

`src/payouts.js` is the engine (pure, no DOM), `src/parse.js` the CSV and money
helpers, `src/csv.js` the typed CSV cells that keep merchant-controlled text from
ever becoming a spreadsheet formula in an export, `src/payouts-sample.js` the
embedded demo data (byte-identical to `docs/sample/`). Tests live in `tests/`
with synthetic fixtures under `tests/fixtures/payouts/`.

## Provenance

PayoutProof V1 was first published on 2026-09-05 as a page of the MarginProof
site and moved to this repository the same day under its own identity. The
generic helpers it reuses are small audited local copies; see `REUSE_NOTES.md`.
The old address redirects here.

## Not affiliated

Independent, and not affiliated with Shopify or any accounting platform.
PayoutProof is not accounting or tax advice.

© 2026 kristijankopacevic. All rights reserved. The source is published so that
anyone can verify what the page does with their files.
