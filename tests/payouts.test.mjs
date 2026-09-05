/* PayoutProof engine tests — run with: node --test tests/
 *
 * The tests that matter most: UNKNOWN is never ZERO, Amount − Fee is checked
 * against Net and never silently replaced, matching fails safe (AMBIGUOUS
 * rather than pick-first), currencies are never summed together, and nothing
 * merchant-controlled can become a spreadsheet formula in an export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  analyse, detectPayoutColumns, classifyType, toTransactions, toPayoutSummaries,
  payoutSummaryCsv, transactionDetailCsv, looksUtf16, safeFilename, dateOnly,
  NOT_AVAILABLE, STATUS, BUCKET, NET_CHECK, LIMITS,
} from '../src/payouts.js';
import { parseCsv, MONEY_UNKNOWN } from '../src/parse.js';
import { DEMO_TRANSACTIONS, DEMO_PAYOUTS, DEMO_TRANSACTIONS_NAME, DEMO_PAYOUTS_NAME } from '../src/payouts-sample.js';

const fx = name => readFileSync(new URL(`./fixtures/payouts/${name}`, import.meta.url), 'utf8');
const H = 'Transaction Date,Type,Order,Payout Status,Payout Date,Amount,Fee,Net,Currency';
const tx = (...rows) => [H, ...rows].join('\n') + '\n';
const PH = 'Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency';
const po = (...rows) => [PH, ...rows].join('\n') + '\n';

/* ---------- detection --------------------------------------------------- */

test('transaction header is detected regardless of column order', () => {
  const d = detectPayoutColumns(parseCsv(fx('reordered-transactions.csv'))[0]);
  assert.equal(d.kind, 'transactions');
  assert.equal(d.index.amount, 3);
  assert.equal(d.index.payoutDate, 4);
  assert.ok(d.absent.includes('transactionDate'));
});

test('payouts export header is detected as a payouts file, not transactions', () => {
  assert.equal(detectPayoutColumns(parseCsv(fx('payouts-matched.csv'))[0]).kind, 'payouts');
  assert.equal(detectPayoutColumns(parseCsv(DEMO_PAYOUTS)[0]).kind, 'payouts');
});

test('a header matching neither shape is reported unknown and the columns seen are listed', () => {
  const m = analyse('Handle,Title,Variant SKU,Variant Price\nx,Candle,S1,10\n');
  assert.equal(m.results.length, 0);
  assert.match(m.errors[0], /Not a Shopify Payments transactions export/);
  assert.match(m.errors[0], /Variant SKU/);
});

test('a payouts export dropped as the first file is explained, not crashed on', () => {
  const m = analyse(DEMO_PAYOUTS);
  assert.match(m.errors[0], /looks like the payouts export/);
});

test('malformed text does not crash and yields no fabricated result', () => {
  const m = analyse(fx('malformed.csv'));
  assert.equal(m.results.length, 0);
  assert.ok(m.errors.length >= 1);
});

/* ---------- classification ---------------------------------------------- */

test('a normal export reconciles to MATCHED against its payouts export', () => {
  const m = analyse(fx('normal-transactions.csv'), 'n.csv', fx('payouts-matched.csv'), 'p.csv');
  assert.equal(m.results.length, 1);
  assert.equal(m.results[0].status, STATUS.MATCHED);
  assert.equal(m.results[0].difference, 0);
  assert.equal(m.results[0].agg.grossCharges, 15000);
  assert.equal(m.results[0].agg.refunds, -2000);
  assert.equal(m.results[0].agg.adjustments, -500);
  assert.equal(m.results[0].agg.totalFees, 495);
  assert.equal(m.results[0].agg.computedNet, 12005);
});

test('a refund row keeps its negative amount and lands in the refunds bucket', () => {
  const { txns } = toTransactions(parseCsv(fx('normal-transactions.csv')));
  const refund = txns.find(t => t.typeRaw === 'refund');
  assert.equal(refund.bucket, BUCKET.REFUNDS);
  assert.equal(refund.amount, -2000);
});

test('an adjustment is bucketed as adjustment and never merged into charges', () => {
  const m = analyse(fx('normal-transactions.csv'));
  assert.equal(m.results[0].agg.counts.ADJUSTMENTS, 1);
  assert.equal(m.results[0].agg.counts.CHARGES, 2);
});

test('an unknown Type value raises a finding and is never silently bucketed', () => {
  const m = analyse(tx('2026-08-01 10:00:00 -0400,shop cash credit,#1,paid,2026-08-03,10.00,0.00,10.00,USD'));
  assert.equal(m.txns[0].bucket, BUCKET.UNKNOWN_TYPE);
  assert.ok(m.txns[0].flags.includes('unknown_transaction_type'));
  assert.equal(m.results[0].agg.other, 1000);
  assert.ok(m.findings.some(f => f.code === 'unknown_transaction_type' && f.severity === 'check'));
});

test('a Type value of "constructor" does not inherit from Object.prototype', () => {
  assert.equal(classifyType('constructor').known, false);
  assert.equal(classifyType('__proto__').known, false);
  assert.equal(classifyType(' Charge ').bucket, BUCKET.CHARGES);
  assert.equal(classifyType('CHARGE_BACK').bucket, BUCKET.DISPUTES);
});

/* ---------- arithmetic -------------------------------------------------- */

test('Amount minus Fee equals Net is checked with exact integers', () => {
  const { txns } = toTransactions(parseCsv(tx('2026-08-01,charge,#1,paid,2026-08-03,0.30,0.10,0.20,USD')));
  assert.equal(txns[0].netCheck, NET_CHECK.OK);
  assert.equal(txns[0].calculatedNet, 20);
});

test('a row where Amount minus Fee does not equal Net raises net_mismatch and both figures are kept', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,100.00,3.00,96.00,USD'));
  assert.equal(m.txns[0].netCheck, NET_CHECK.MISMATCH);
  assert.equal(m.txns[0].calculatedNet, 9700);
  assert.equal(m.txns[0].net, 9600);
  assert.ok(m.findings.some(f => f.code === 'net_mismatch'));
  assert.equal(m.results[0].agg.netAggregateCheck, NET_CHECK.MISMATCH);
  assert.ok(m.findings.some(f => f.code === 'net_aggregate_mismatch'));
});

test('a row with an unknown Fee reports CANNOT_CHECK and the payout falls back to the Net column, stating why', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,100.00,,96.80,USD',
                       '2026-08-01,charge,#2,paid,2026-08-03,50.00,1.75,48.25,USD'));
  assert.equal(m.txns[0].netCheck, NET_CHECK.CANNOT_CHECK);
  assert.equal(m.results[0].agg.calculatedNet, NOT_AVAILABLE);
  assert.equal(m.results[0].agg.totalFees, NOT_AVAILABLE);
  assert.equal(m.results[0].agg.computedNet, 14505);
  assert.match(m.results[0].agg.computedNetBasis, /Net column/);
});

test('UNKNOWN IS NOT ZERO: an empty Amount makes gross charges unavailable rather than smaller', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,,3.20,96.80,USD',
                       '2026-08-01,charge,#2,paid,2026-08-03,50.00,1.75,48.25,USD'));
  assert.equal(m.results[0].agg.grossCharges, NOT_AVAILABLE);
  assert.equal(m.results[0].agg.calculatedNet, NOT_AVAILABLE);
  assert.equal(m.unknown.unknownValues.amount, 1);
});

test('when Amount, Fee and Net are all missing the payout is INCOMPLETE_SOURCE, never reconciled', () => {
  const m = analyse('Type,Order,Payout Status,Payout Date,Amount,Currency\ncharge,#1,paid,2026-08-03,,USD\n', 't.csv', po('2026-08-03,paid,0,0,0,0,0,0,0,USD'), 'p.csv');
  assert.equal(m.results[0].status, STATUS.INCOMPLETE_SOURCE);
  assert.equal(m.results[0].reportedTotal, NOT_AVAILABLE);
});

test('a missing optional column yields NOT_AVAILABLE_FROM_SOURCE, never 0', () => {
  const m = analyse('Type,Order,Payout Status,Payout Date,Amount,Currency\ncharge,#1,paid,2026-08-03,100.00,USD\n');
  assert.ok(m.unknown.absentColumns.includes('fee'));
  assert.ok(m.unknown.absentColumns.includes('net'));
  assert.equal(m.results[0].agg.totalFees, NOT_AVAILABLE);
  assert.equal(m.txns[0].fee, MONEY_UNKNOWN);
  assert.equal(m.results[0].status, STATUS.INCOMPLETE_SOURCE);
});

test('a parenthesised negative is refused rather than read as positive', () => {
  const m = analyse(fx('paren-negative-transactions.csv'));
  const refund = m.txns[1];
  assert.equal(refund.amount, MONEY_UNKNOWN);
  assert.ok(refund.flags.includes('ambiguous_negative_format'));
  assert.equal(m.results[0].agg.refunds, NOT_AVAILABLE);
});

/* ---------- currencies -------------------------------------------------- */

test('currencies are never summed together and the cross-currency total is unavailable', () => {
  const m = analyse(DEMO_TRANSACTIONS, 'd.csv', DEMO_PAYOUTS, 'p.csv');
  assert.equal(m.totals.byCurrency.length, 2);
  assert.equal(m.totals.crossCurrencyTotal, NOT_AVAILABLE);
  const usd = m.totals.byCurrency.find(t => t.currency === 'USD');
  const eur = m.totals.byCurrency.find(t => t.currency === 'EUR');
  assert.equal(usd.computedNet, 62825);
  assert.equal(eur.computedNet, 25824);
});

test('the same date in two currencies is two payouts, not one', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,100.00,3.00,97.00,USD',
                       '2026-08-01,charge,#2,paid,2026-08-03,100.00,3.00,97.00,EUR'));
  assert.equal(m.results.length, 2);
});

test('presentment amounts and the VAT column never enter any total', () => {
  const base = analyse(DEMO_TRANSACTIONS);
  const tampered = analyse(DEMO_TRANSACTIONS.replace(/,(\d+\.\d\d),(USD|EUR),(USD|EUR),0\.\d\d$/gm, ',999999.99,$2,$3,777.77'));
  assert.equal(tampered.results[0].agg.computedNet, base.results[0].agg.computedNet);
  assert.equal(tampered.results[1].agg.totalFees, base.results[1].agg.totalFees);
  assert.equal(tampered.txns[0].vatRaw, '777.77');
});

/* ---------- parsing robustness ------------------------------------------ */

test('identical duplicate rows raise a finding and remain in the totals', () => {
  const row = '2026-08-01,charge,#1,paid,2026-08-03,10.00,0.50,9.50,USD';
  const m = analyse(tx(row, row, '2026-08-01,charge,#2,paid,2026-08-03,5.00,0.20,4.80,USD'));
  assert.equal(m.results[0].transactionCount, 3);
  assert.equal(m.results[0].agg.grossCharges, 2500);
  assert.ok(m.txns[1].flags.includes('possible_duplicate_row'));
  assert.ok(!m.txns[0].flags.includes('possible_duplicate_row'));
});

test('column order does not change any computed total', () => {
  const a = analyse(fx('normal-transactions.csv')).results[0].agg;
  const b = analyse(fx('reordered-transactions.csv')).results[0].agg;
  for (const k of ['grossCharges', 'refunds', 'adjustments', 'totalFees', 'computedNet']) assert.equal(a[k], b[k], k);
});

test('a UTF-8 BOM and CRLF line endings do not break header detection or totals', () => {
  const a = analyse(fx('normal-transactions.csv')).results[0].agg;
  const b = analyse(fx('bom-crlf-transactions.csv')).results[0].agg;
  assert.equal(a.computedNet, b.computedNet);
});

test('commas and quotes inside a quoted Order field survive parsing', () => {
  const m = analyse(fx('quoted-and-injection-transactions.csv'));
  assert.equal(m.txns[0].order, '#1001, re-order "A"');
});

test('a ragged row is reported, not silently padded with zeros', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,100.00,3.20', '2026-08-01,charge,#2,paid,2026-08-03,50.00,1.75,48.25,USD'));
  assert.ok(m.txns[0].flags.includes('ragged_row'));
  assert.equal(m.txns[0].net, MONEY_UNKNOWN);
  assert.equal(m.txns[0].netCheck, NET_CHECK.CANNOT_CHECK);
});

test('source_row counts parsed rows with blank lines removed and the header as row 1', () => {
  const m = analyse(H + '\n2026-08-01,charge,#1,paid,2026-08-03,1.00,0.00,1.00,USD\n\n\n2026-08-01,charge,#2,paid,2026-08-03,2.00,0.00,2.00,USD\n');
  assert.deepEqual(m.txns.map(t => t.line), [2, 3]);
  assert.equal(m.txns[1].prov.amount.source_row, 3);
  assert.equal(m.txns[1].prov.amount.raw_value, '2.00');
  assert.equal(m.txns[1].prov.amount.normalized_value, 200);
});

/* ---------- pending and matching --------------------------------------- */

test('rows with no Payout Date go to the not-yet-paid-out bucket and are excluded from results', () => {
  const m = analyse(DEMO_TRANSACTIONS);
  assert.equal(m.results.length, 3);
  const pending = [...m.pending.values()];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].txns.length, 3);
  assert.ok(m.findings.some(f => f.code === 'pending_not_paid_out'));
});

test('a payout whose rows are not yet paid is PENDING_NOT_PAID and never matched to a payouts row', () => {
  const m = analyse(tx('2026-08-01,charge,#1,pending,2026-08-03,100.00,3.20,96.80,USD'), 't.csv', po('2026-08-03,pending,100.00,0,0,0,3.20,0,96.80,USD'), 'p.csv');
  assert.equal(m.results[0].status, STATUS.PENDING_NOT_PAID);
  assert.equal(m.results[0].reportedTotal, NOT_AVAILABLE);
  assert.equal(m.unmatchedPayouts.length, 1);
});

test('without a payouts export every paid payout is NO_PAYOUT_ROW with the reason stated', () => {
  const m = analyse(fx('normal-transactions.csv'));
  assert.equal(m.results[0].status, STATUS.NO_PAYOUT_ROW);
  assert.match(m.results[0].reason, /not supplied/);
  assert.ok(!m.findings.some(f => f.code === 'no_payout_row'), 'not a finding when the file was simply not given');
});

test('a one-cent disagreement produces DIFFERENCE with the exact signed delta', () => {
  const m = analyse(fx('normal-transactions.csv'), 'n.csv', fx('payouts-difference.csv'), 'p.csv');
  assert.equal(m.results[0].status, STATUS.DIFFERENCE);
  assert.equal(m.results[0].difference, 1);
  assert.equal(m.results[0].reportedTotal, 12006);
  assert.ok(m.findings.some(f => f.code === 'payout_difference' && /0\.01/.test(f.message)));
});

test('a payout row with no matching transactions is UNMATCHED_PAYOUT_ROW', () => {
  const m = analyse(fx('normal-transactions.csv'), 'n.csv', po('2026-08-03,paid,150.00,-20.00,-5.00,0,4.95,0,120.05,USD', '2026-08-04,paid,10,0,0,0,0.30,0,9.70,USD'), 'p.csv');
  assert.equal(m.unmatchedPayouts.length, 1);
  assert.equal(m.unmatchedPayouts[0].status, STATUS.UNMATCHED_PAYOUT_ROW);
  assert.ok(m.findings.some(f => f.code === 'unmatched_payout_row'));
});

test('two payouts sharing a date and currency without a Payout ID are AMBIGUOUS_MATCH, never pick-first', () => {
  const m = analyse(fx('normal-transactions.csv'), 'n.csv', fx('payouts-ambiguous.csv'), 'p.csv');
  assert.equal(m.results[0].status, STATUS.AMBIGUOUS_MATCH);
  assert.equal(m.results[0].reportedTotal, NOT_AVAILABLE);
  assert.equal(m.unmatchedPayouts.length, 2);
  assert.ok(m.findings.some(f => f.code === 'ambiguous_payout_match'));
});

test('a Payout ID, when present on both sides, separates two payouts on the same date', () => {
  const m = analyse(fx('transactions-with-payout-id.csv'), 't.csv', fx('payouts-with-id.csv'), 'p.csv');
  assert.equal(m.results.length, 2);
  assert.deepEqual(m.results.map(r => r.status), [STATUS.MATCHED, STATUS.MATCHED]);
  assert.deepEqual(m.results.map(r => r.matchBasis), ['Payout ID', 'Payout ID']);
  assert.deepEqual(m.results.map(r => r.bankReference).sort(), ['REF-1', 'REF-2']);
});

test('bank reference is displayed but never used as identity', () => {
  const m = analyse(tx('2026-08-01,charge,#1,paid,2026-08-03,100.00,3.20,96.80,USD'), 't.csv',
    'Payout Date,Status,Charges,Refunds,Adjustments,Reserved Funds,Fees,Retried Amount,Total,Currency,Bank Reference\n2026-08-04,paid,100.00,0,0,0,3.20,0,96.80,USD,REF-X\n', 'p.csv');
  assert.equal(m.results[0].status, STATUS.NO_PAYOUT_ROW);
});

test('a negative fee is flagged as information, not treated as an error', () => {
  const m = analyse(tx('2026-08-01,refund,#1,paid,2026-08-03,-10.00,-0.30,-9.70,USD'));
  assert.ok(m.txns[0].flags.includes('negative_fee'));
  assert.equal(m.findings.find(f => f.code === 'negative_fee').severity, 'info');
});

test('a positive refund raises unexpected_sign but is still totalled as exported', () => {
  const m = analyse(tx('2026-08-01,refund,#1,paid,2026-08-03,10.00,0.00,10.00,USD'));
  assert.ok(m.txns[0].flags.includes('unexpected_sign'));
  assert.equal(m.results[0].agg.refunds, 1000);
});

test('a zero-amount row is reported and not dropped', () => {
  const m = analyse(tx('2026-08-01,adjustment,,paid,2026-08-03,0.00,0.00,0.00,USD'));
  assert.equal(m.results[0].transactionCount, 1);
  assert.ok(m.txns[0].flags.includes('zero_amount_row'));
});

test('an inconsistent payouts row is flagged by its own internal check', () => {
  const { payouts } = toPayoutSummaries(parseCsv(po('2026-08-03,paid,100.00,0,0,0,3.20,0,96.81,USD')));
  assert.equal(payouts[0].internalCheck, NET_CHECK.MISMATCH);
});

test('dates are compared on the date part only, without timezone arithmetic', () => {
  assert.equal(dateOnly('2023-10-31 12:00:42 +0100'), '2023-10-31');
  assert.equal(dateOnly(' 2026-08-03'), '2026-08-03');
  assert.equal(dateOnly('31/10/2023'), null);
});

/* ---------- exports ----------------------------------------------------- */

test('merchant text in exports cannot become a formula; computed numbers stay numeric', () => {
  const m = analyse(fx('quoted-and-injection-transactions.csv'));
  const detail = transactionDetailCsv(m);
  assert.ok(detail.includes('"\'=HYPERLINK(""http://evil"",""x"")"'), 'checkout payload defused');
  assert.ok(detail.includes('"\'+cmd|'), 'type payload defused');
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(detail));
  // Row 2's Type is the payload itself, so it is UNKNOWN_TYPE ("other"): gross is 100.00, other 50.00.
  const summary = payoutSummaryCsv(m);
  assert.ok(/,100\.00,/.test(summary), 'gross charges exported as a bare number');
  assert.ok(/,50\.00,/.test(summary), 'unknown-type amount exported under other as a bare number');
});

test('an exported CSV round-trips through our parser with the expected shape', () => {
  const m = analyse(DEMO_TRANSACTIONS, 'd.csv', DEMO_PAYOUTS, 'p.csv');
  const rows = parseCsv(payoutSummaryCsv(m));
  assert.equal(rows.length, 1 + 3);
  assert.equal(rows[0].length, rows[1].length);
  assert.equal(rows[2][rows[0].indexOf('match_status')], STATUS.DIFFERENCE);
  assert.equal(rows[2][rows[0].indexOf('difference')], '0.01');
  const detail = parseCsv(transactionDetailCsv(m));
  assert.equal(detail.length, 1 + 15);
  assert.equal(detail[1][detail[0].indexOf('vat_as_exported')], '0.00');
});

test('unavailable values export as NOT_AVAILABLE_FROM_SOURCE, never as 0 or blank', () => {
  const m = analyse('Type,Order,Payout Status,Payout Date,Amount,Currency\ncharge,#1,paid,2026-08-03,100.00,USD\n');
  const rows = parseCsv(payoutSummaryCsv(m));
  assert.equal(rows[1][rows[0].indexOf('total_fees')], NOT_AVAILABLE);
  assert.equal(rows[1][rows[0].indexOf('computed_net')], NOT_AVAILABLE);
});

test('download filenames are sanitised', () => {
  assert.equal(safeFilename('../evil name?.csv', 'csv'), 'evil-name-.csv.csv');
  assert.equal(safeFilename('', 'csv'), 'export.csv');
  assert.match(safeFilename('payoutproof summary', 'csv'), /^payoutproof-summary\.csv$/);
});

test('UTF-16 byte order marks are recognised so the page can ask for a UTF-8 export', () => {
  assert.equal(looksUtf16(new Uint8Array([0xff, 0xfe, 0x54, 0x00])), true);
  assert.equal(looksUtf16(new Uint8Array([0xfe, 0xff, 0x00, 0x54])), true);
  assert.equal(looksUtf16(new Uint8Array([0xef, 0xbb, 0xbf, 0x54])), false);
});

/* ---------- demo -------------------------------------------------------- */

test('the embedded demo files are byte-identical to docs/sample', () => {
  assert.equal(readFileSync(new URL(`../docs/sample/${DEMO_TRANSACTIONS_NAME}`, import.meta.url), 'utf8'), DEMO_TRANSACTIONS);
  assert.equal(readFileSync(new URL(`../docs/sample/${DEMO_PAYOUTS_NAME}`, import.meta.url), 'utf8'), DEMO_PAYOUTS);
});

test('the demo pair produces exactly one DIFFERENCE of 0.01 and two MATCHED payouts', () => {
  const m = analyse(DEMO_TRANSACTIONS, DEMO_TRANSACTIONS_NAME, DEMO_PAYOUTS, DEMO_PAYOUTS_NAME);
  assert.deepEqual(m.results.map(r => r.status), [STATUS.MATCHED, STATUS.DIFFERENCE, STATUS.MATCHED]);
  assert.equal(m.results[1].difference, 1);
  assert.equal(m.findings.filter(f => f.code === 'payout_difference').length, 1);
  assert.equal(m.errors.length, 0);
});

/* ---------- scale ------------------------------------------------------- */

test('50,000 rows parse and reconcile with correct totals, inside the time bound', () => {
  const rows = [];
  for (let i = 0; i < 50000; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    rows.push(`2026-08-${day} 10:00:00 -0400,charge,#${i},paid,2026-08-${day},10.00,0.30,9.70,USD`);
  }
  const t0 = performance.now();
  const m = analyse(tx(...rows));
  const elapsed = performance.now() - t0;
  assert.equal(m.results.length, 28);
  const total = m.results.reduce((a, r) => a + r.agg.computedNet, 0);
  assert.equal(total, 50000 * 970);
  assert.ok(elapsed < 10000, `took ${elapsed}ms`);
});

test('a file over the row cap is refused with the cap named', () => {
  const rows = new Array(LIMITS.MAX_ROWS + 1).fill('2026-08-01,charge,#1,paid,2026-08-03,1.00,0.00,1.00,USD');
  const m = analyse(H + '\n' + rows.join('\n') + '\n');
  assert.equal(m.results.length, 0);
  assert.match(m.errors[0], new RegExp(String(LIMITS.MAX_ROWS)));
});
