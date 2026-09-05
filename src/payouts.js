/* PayoutProof engine — pure, deterministic, no DOM.
 *
 * Input:  Shopify Payments "balance transactions" export (required) and the
 *         "payouts" export (optional). Both are CSV files the merchant already
 *         downloads from Finance > Payouts.
 * Output: transactions grouped by payout, per-payout totals computed from the
 *         source rows, a comparison with the payout total Shopify reported,
 *         findings, and CSV exports with provenance on every amount.
 *
 * Rules this file is built around (asserted by tests):
 *   - Money is integer minor units (see parse.js). No floating-point sums.
 *   - UNKNOWN is not ZERO. A value the export does not carry is reported as
 *     NOT_AVAILABLE_FROM_SOURCE and never enters a total as 0.
 *   - Amount, Fee and Net are all parsed and kept. Amount − Fee is checked
 *     against Net per row; Σ(Amount − Fee) and Σ(Net) are both computed per
 *     payout and compared. Nothing is silently substituted.
 *   - Matching a payout to the payouts export uses Payout ID when both sides
 *     have it, otherwise date + currency only when exactly one candidate
 *     exists. Several candidates → AMBIGUOUS_MATCH, never "pick first".
 *   - Type values are mapped by an explicit, deliberately narrow table. An
 *     unlisted type is surfaced as a finding, never silently bucketed.
 *   - The VAT column, when present, is passed through as exported. It enters
 *     no arithmetic and is not interpreted.
 */

import { parseCsv, parseNumber, toMinor, fromMinor, MONEY_UNKNOWN } from './parse.js';
import { csvText, csvNumber, buildCsv } from './csv.js';

export const NOT_AVAILABLE = 'NOT_AVAILABLE_FROM_SOURCE';

export const LIMITS = Object.freeze({
  MAX_BYTES: 25 * 1024 * 1024,   // checked by the page before reading the file
  MAX_ROWS: 200000,              // checked here after parsing
  RENDER_ROWS: 500,              // page renders at most this many detail rows
});

export const STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  DIFFERENCE: 'DIFFERENCE',
  NO_PAYOUT_ROW: 'NO_PAYOUT_ROW',
  PENDING_NOT_PAID: 'PENDING_NOT_PAID',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  INCOMPLETE_SOURCE: 'INCOMPLETE_SOURCE',
  UNMATCHED_PAYOUT_ROW: 'UNMATCHED_PAYOUT_ROW',
});

export const BUCKET = Object.freeze({
  CHARGES: 'CHARGES', REFUNDS: 'REFUNDS', ADJUSTMENTS: 'ADJUSTMENTS', DISPUTES: 'DISPUTES',
  RESERVES: 'RESERVES', TRANSFERS: 'TRANSFERS', PAYOUT_ROWS: 'PAYOUT_ROWS', UNKNOWN_TYPE: 'UNKNOWN_TYPE',
});

export const NET_CHECK = Object.freeze({ OK: 'OK', MISMATCH: 'MISMATCH', CANNOT_CHECK: 'CANNOT_CHECK' });

/* ---------- column detection ------------------------------------------- */

const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Balance transactions export. Order matters: most explicit alias first.
const TX_FIELDS = {
  transactionDate:    ['transactiondate', 'date'],
  type:               ['type', 'transactiontype'],
  order:              ['order', 'ordername', 'ordernumber', 'orderid'],
  cardBrand:          ['cardbrand'],
  cardSource:         ['cardsource'],
  payoutStatus:       ['payoutstatus'],
  payoutDate:         ['payoutdate'],
  availableOn:        ['availableon'],
  amount:             ['amount', 'grossamount', 'gross'],
  fee:                ['fee', 'fees'],
  net:                ['net', 'netamount'],
  checkout:           ['checkout', 'checkoutid'],
  paymentMethodName:  ['paymentmethodname', 'paymentmethod'],
  presentmentAmount:  ['presentmentamount'],
  presentmentCurrency:['presentmentcurrency'],
  currency:           ['currency', 'payoutcurrency'],
  vat:                ['vat', 'feevat', 'tax'],
  payoutId:           ['payoutid'],
  bankReference:      ['bankreference', 'traceid'],
};
const TX_REQUIRED = ['type', 'amount'];
const TX_OPTIONAL = Object.keys(TX_FIELDS).filter(k => !TX_REQUIRED.includes(k));

// Payouts export (one row per payout).
const PO_FIELDS = {
  payoutDate:     ['payoutdate', 'date'],
  status:         ['status', 'payoutstatus'],
  charges:        ['charges'],
  refunds:        ['refunds'],
  adjustments:    ['adjustments'],
  reservedFunds:  ['reservedfunds', 'reserves', 'reservedamount'],
  fees:           ['fees', 'fee'],
  retriedAmount:  ['retriedamount', 'retried'],
  total:          ['total', 'netamount', 'payoutamount', 'amount'],
  currency:       ['currency', 'payoutcurrency'],
  bankReference:  ['bankreference', 'traceid', 'reference'],
  payoutId:       ['payoutid', 'id'],
};

function detect(header, fields) {
  const normalised = header.map(norm);
  const index = Object.create(null);
  for (const [key, aliases] of Object.entries(fields)) {
    for (const alias of aliases) {
      const i = normalised.indexOf(alias);
      if (i !== -1) { index[key] = i; break; }
    }
  }
  return index;
}

/** Decide what kind of export a header row is, and where each column sits. */
export function detectPayoutColumns(header) {
  const h = header.map(norm);
  const tx = detect(header, TX_FIELDS);
  const po = detect(header, PO_FIELDS);
  // A transactions export always has a Type and an Amount column. Fee and Net
  // are optional here on purpose: without them the page still groups the rows
  // and reports every total as NOT_AVAILABLE_FROM_SOURCE instead of 0.
  const looksTx = tx.amount !== undefined && tx.type !== undefined;
  const looksPo = po.total !== undefined && po.payoutDate !== undefined
    && (h.includes('charges') || h.includes('fees')) && !looksTx;
  if (looksTx) {
    return { kind: 'transactions', index: tx, header,
      present: Object.keys(tx), absent: TX_OPTIONAL.filter(k => tx[k] === undefined) };
  }
  if (looksPo) {
    return { kind: 'payouts', index: po, header,
      present: Object.keys(po), absent: Object.keys(PO_FIELDS).filter(k => po[k] === undefined) };
  }
  return { kind: 'unknown', index: {}, header, present: [], absent: [] };
}

/* ---------- classification -------------------------------------------- */

// Deliberately narrow. An unlisted value is UNKNOWN_TYPE and raises a
// finding; guessing a bucket would silently move money.
const TYPE_TABLE = Object.assign(Object.create(null), {
  'charge': BUCKET.CHARGES,
  'refund': BUCKET.REFUNDS,
  'adjustment': BUCKET.ADJUSTMENTS,
  'chargeback': BUCKET.DISPUTES,
  'dispute': BUCKET.DISPUTES,
  'reserve': BUCKET.RESERVES,
  'transfer': BUCKET.TRANSFERS,
  'payout': BUCKET.PAYOUT_ROWS,
});
const SIGN_EXPECTATION = Object.assign(Object.create(null), {
  [BUCKET.CHARGES]: +1, [BUCKET.REFUNDS]: -1,
});

export function classifyType(raw) {
  const normalized = String(raw ?? '').toLowerCase().trim().replace(/[_\-\s]+/g, ' ');
  // "charge_back", "Charge-Back" and "chargeback" are the same word.
  const bucket = TYPE_TABLE[normalized.replace(/ /g, '')];
  return bucket ? { normalized, bucket, known: true } : { normalized, bucket: BUCKET.UNKNOWN_TYPE, known: false };
}

/* ---------- parsing helpers -------------------------------------------- */

const DATE_ONLY = /^\s*(\d{4}-\d{2}-\d{2})/;
export function dateOnly(raw) {
  const m = DATE_ONLY.exec(String(raw ?? ''));
  return m ? m[1] : null;
}

const PAREN_NEGATIVE = /^\s*\(.*\)\s*$/;

/** Parse one money cell into integer minor units with provenance. */
function money(raw, file, row, column) {
  const prov = { source_file: file, source_row: row, source_column: column,
    raw_value: raw === undefined ? NOT_AVAILABLE : String(raw), normalized_value: MONEY_UNKNOWN,
    currency: null, transformation: '' };
  if (raw === undefined) { prov.transformation = 'column absent'; return { value: MONEY_UNKNOWN, prov, flag: null }; }
  const s = String(raw).trim();
  if (s === '') { prov.transformation = 'empty cell → UNKNOWN'; return { value: MONEY_UNKNOWN, prov, flag: null }; }
  if (PAREN_NEGATIVE.test(s)) {
    prov.transformation = 'parenthesised value refused → UNKNOWN';
    return { value: MONEY_UNKNOWN, prov, flag: 'ambiguous_negative_format' };
  }
  const dec = parseNumber(s);
  if (dec === MONEY_UNKNOWN) { prov.transformation = 'not numeric → UNKNOWN'; return { value: MONEY_UNKNOWN, prov, flag: 'unparseable_amount' }; }
  const minor = toMinor(dec);
  prov.normalized_value = minor; prov.transformation = 'parseNumber → integer minor units (×100)';
  return { value: minor, prov, flag: null };
}

const text = (r, idx, key) => (idx[key] === undefined ? undefined : String(r[idx[key]] ?? '').trim());
const isPaid = s => String(s ?? '').trim().toLowerCase() === 'paid';

/* ---------- transactions ------------------------------------------------ */

export function toTransactions(rows, fileName = 'transactions.csv') {
  if (!rows.length) return { txns: [], kind: 'unknown', index: {}, header: [], absent: [], rowErrors: ['empty file'] };
  if (rows.length - 1 > LIMITS.MAX_ROWS) {
    return { txns: [], kind: 'unknown', index: {}, header: rows[0], absent: [],
      rowErrors: [`too many rows: ${rows.length - 1} exceeds the ${LIMITS.MAX_ROWS} row cap`] };
  }
  const det = detectPayoutColumns(rows[0]);
  if (det.kind !== 'transactions') return { txns: [], ...det, rowErrors: [] };
  const idx = det.index, header = det.header;
  const seen = new Map();
  const txns = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ordinal = i + 1;                 // 1-based ordinal in parsed CSV, header = 1, blank lines removed
    const flags = [];
    if (r.length < header.length) flags.push('ragged_row');
    const key = r.join('');
    seen.set(key, (seen.get(key) || 0) + 1);
    if (seen.get(key) > 1) flags.push('possible_duplicate_row');

    const cls = classifyType(text(r, idx, 'type'));
    if (!cls.known) flags.push('unknown_transaction_type');

    const amount = money(r[idx.amount], fileName, ordinal, header[idx.amount]);
    const fee = idx.fee === undefined ? money(undefined, fileName, ordinal, 'Fee') : money(r[idx.fee], fileName, ordinal, header[idx.fee]);
    const net = idx.net === undefined ? money(undefined, fileName, ordinal, 'Net') : money(r[idx.net], fileName, ordinal, header[idx.net]);
    for (const m of [amount, fee, net]) if (m.flag) flags.push(m.flag);

    const currency = text(r, idx, 'currency') || '';
    amount.prov.currency = fee.prov.currency = net.prov.currency = currency || null;

    /** @type {string} */ let netCheck = NET_CHECK.CANNOT_CHECK;
    /** @type {number|null} */ let calculatedNet = MONEY_UNKNOWN;
    if (amount.value !== MONEY_UNKNOWN && fee.value !== MONEY_UNKNOWN) {
      calculatedNet = amount.value - fee.value;
      if (net.value !== MONEY_UNKNOWN) netCheck = calculatedNet === net.value ? NET_CHECK.OK : NET_CHECK.MISMATCH;
    }
    if (netCheck === NET_CHECK.MISMATCH) flags.push('net_mismatch');

    const expect = SIGN_EXPECTATION[cls.bucket];
    if (expect && amount.value !== MONEY_UNKNOWN && amount.value !== 0 && Math.sign(amount.value) !== expect) flags.push('unexpected_sign');
    if (fee.value !== MONEY_UNKNOWN && fee.value < 0) flags.push('negative_fee');
    if (amount.value === 0 && (fee.value === 0 || fee.value === MONEY_UNKNOWN)) flags.push('zero_amount_row');
    if ((amount.value === 0 || amount.value === MONEY_UNKNOWN) && fee.value !== MONEY_UNKNOWN && fee.value !== 0) flags.push('fee_only_row');

    const payoutDateRaw = text(r, idx, 'payoutDate');
    const payoutDate = payoutDateRaw ? dateOnly(payoutDateRaw) : null;
    if (payoutDateRaw && !payoutDate) flags.push('unparseable_payout_date');
    const transactionDateRaw = text(r, idx, 'transactionDate');

    txns.push({
      line: ordinal, sourceFile: fileName,
      typeRaw: text(r, idx, 'type') ?? '', typeNormalized: cls.normalized, bucket: cls.bucket, knownType: cls.known,
      order: text(r, idx, 'order') ?? NOT_AVAILABLE,
      checkout: text(r, idx, 'checkout') ?? NOT_AVAILABLE,
      transactionDateRaw: transactionDateRaw ?? NOT_AVAILABLE,
      transactionDate: transactionDateRaw ? dateOnly(transactionDateRaw) : null,
      availableOn: text(r, idx, 'availableOn') ?? NOT_AVAILABLE,
      payoutStatus: text(r, idx, 'payoutStatus') ?? NOT_AVAILABLE,
      payoutDateRaw: payoutDateRaw ?? NOT_AVAILABLE, payoutDate,
      payoutId: text(r, idx, 'payoutId') || null,
      bankReference: text(r, idx, 'bankReference') ?? NOT_AVAILABLE,
      currency,
      presentmentAmountRaw: text(r, idx, 'presentmentAmount') ?? NOT_AVAILABLE,
      presentmentCurrency: text(r, idx, 'presentmentCurrency') ?? NOT_AVAILABLE,
      paymentMethodName: text(r, idx, 'paymentMethodName') ?? NOT_AVAILABLE,
      cardBrand: text(r, idx, 'cardBrand') ?? NOT_AVAILABLE,
      vatRaw: text(r, idx, 'vat') ?? NOT_AVAILABLE,      // as exported; never used in arithmetic
      amount: amount.value, fee: fee.value, net: net.value, calculatedNet, netCheck,
      prov: { amount: amount.prov, fee: fee.prov, net: net.prov },
      flags,
    });
  }
  return { txns, kind: det.kind, index: idx, header, absent: det.absent, rowErrors: [] };
}

/* ---------- payouts export --------------------------------------------- */

export function toPayoutSummaries(rows, fileName = 'payouts.csv') {
  if (!rows.length) return { payouts: [], kind: 'unknown', index: {}, header: [], absent: [], rowErrors: ['empty file'] };
  const det = detectPayoutColumns(rows[0]);
  if (det.kind !== 'payouts') return { payouts: [], ...det, rowErrors: [] };
  const idx = det.index, header = det.header;
  const payouts = [];
  const comp = ['charges', 'refunds', 'adjustments', 'reservedFunds', 'fees', 'retriedAmount', 'total'];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ordinal = i + 1;
    const flags = [];
    if (r.length < header.length) flags.push('ragged_row');
    const m = {}, prov = {};
    for (const k of comp) {
      const cell = idx[k] === undefined ? money(undefined, fileName, ordinal, k) : money(r[idx[k]], fileName, ordinal, header[idx[k]]);
      m[k] = cell.value; prov[k] = cell.prov; if (cell.flag) flags.push(cell.flag);
    }
    const payoutDateRaw = text(r, idx, 'payoutDate') ?? '';
    const payoutDate = dateOnly(payoutDateRaw);
    if (!payoutDate) flags.push('unparseable_payout_date');
    // Internal consistency of the payouts export itself. Informational only.
    const parts = ['charges', 'refunds', 'adjustments', 'reservedFunds', 'retriedAmount'];
    /** @type {string} */ let internal = NET_CHECK.CANNOT_CHECK;
    if (parts.every(k => m[k] !== MONEY_UNKNOWN) && m.fees !== MONEY_UNKNOWN && m.total !== MONEY_UNKNOWN) {
      const sum = parts.reduce((a, k) => a + m[k], 0) - m.fees;
      internal = sum === m.total ? NET_CHECK.OK : NET_CHECK.MISMATCH;
      if (internal === NET_CHECK.MISMATCH) flags.push('payout_row_internal_mismatch');
    }
    payouts.push({
      line: ordinal, sourceFile: fileName, payoutDateRaw, payoutDate,
      status: text(r, idx, 'status') ?? NOT_AVAILABLE,
      currency: text(r, idx, 'currency') || '',
      bankReference: text(r, idx, 'bankReference') ?? NOT_AVAILABLE,   // displayed, never used as identity
      payoutId: text(r, idx, 'payoutId') || null,
      ...m, prov, internalCheck: internal, flags, matched: false,
    });
  }
  return { payouts, kind: det.kind, index: idx, header, absent: det.absent, rowErrors: [] };
}

/* ---------- grouping ---------------------------------------------------- */

const SEP = '\u0000';
export const groupKey = (payoutDate, payoutId, currency) => `${payoutDate}${SEP}${payoutId || ''}${SEP}${currency || ''}`;

function emptyAgg() {
  return { CHARGES: 0, REFUNDS: 0, ADJUSTMENTS: 0, DISPUTES: 0, RESERVES: 0, TRANSFERS: 0, UNKNOWN_TYPE: 0, PAYOUT_ROWS: 0,
    counts: { CHARGES: 0, REFUNDS: 0, ADJUSTMENTS: 0, DISPUTES: 0, RESERVES: 0, TRANSFERS: 0, UNKNOWN_TYPE: 0, PAYOUT_ROWS: 0 },
    totalFees: 0, calculatedNet: 0, reportedNetSum: 0,
    unknownAmount: 0, unknownFee: 0, unknownNet: 0 };
}

function aggregate(txns) {
  const a = emptyAgg();
  for (const t of txns) {
    a.counts[t.bucket]++;
    if (t.amount === MONEY_UNKNOWN) a.unknownAmount++; else a[t.bucket] += t.amount;
    if (t.fee === MONEY_UNKNOWN) a.unknownFee++; else a.totalFees += t.fee;
    if (t.net === MONEY_UNKNOWN) a.unknownNet++; else a.reportedNetSum += t.net;
    if (t.bucket !== BUCKET.PAYOUT_ROWS && t.calculatedNet !== MONEY_UNKNOWN) a.calculatedNet += t.calculatedNet;
  }
  // Any UNKNOWN operand poisons the aggregate it belongs to. UNKNOWN is not ZERO.
  const complete = a.unknownAmount === 0 && a.unknownFee === 0;
  const out = {
    grossCharges: a.unknownAmount ? NOT_AVAILABLE : a.CHARGES,
    refunds: a.unknownAmount ? NOT_AVAILABLE : a.REFUNDS,
    adjustments: a.unknownAmount ? NOT_AVAILABLE : a.ADJUSTMENTS,
    disputes: a.unknownAmount ? NOT_AVAILABLE : a.DISPUTES,
    reserves: a.unknownAmount ? NOT_AVAILABLE : a.RESERVES,
    transfers: a.unknownAmount ? NOT_AVAILABLE : a.TRANSFERS,
    other: a.unknownAmount ? NOT_AVAILABLE : a.UNKNOWN_TYPE,
    payoutRows: a.unknownAmount ? NOT_AVAILABLE : a.PAYOUT_ROWS,
    totalFees: a.unknownFee ? NOT_AVAILABLE : a.totalFees,
    calculatedNet: complete ? a.calculatedNet : NOT_AVAILABLE,          // Σ(Amount − Fee)
    reportedNetSum: a.unknownNet ? NOT_AVAILABLE : a.reportedNetSum,    // Σ(Net column)
    counts: a.counts, unknown: { amount: a.unknownAmount, fee: a.unknownFee, net: a.unknownNet },
  };
  // The figure compared with the payout total, and why.
  if (out.calculatedNet !== NOT_AVAILABLE) {
    out.computedNet = out.calculatedNet; out.computedNetBasis = 'sum of Amount − Fee per row';
  } else if (out.reportedNetSum !== NOT_AVAILABLE) {
    out.computedNet = out.reportedNetSum; out.computedNetBasis = 'sum of the Net column (Amount or Fee missing on some rows)';
  } else {
    out.computedNet = NOT_AVAILABLE; out.computedNetBasis = 'not computable: Amount/Fee and Net missing';
  }
  out.netAggregateCheck = (out.calculatedNet !== NOT_AVAILABLE && out.reportedNetSum !== NOT_AVAILABLE)
    ? (out.calculatedNet === out.reportedNetSum ? NET_CHECK.OK : NET_CHECK.MISMATCH) : NET_CHECK.CANNOT_CHECK;
  return out;
}

export function groupByPayout(txns) {
  const groups = new Map(), pending = new Map();
  for (const t of txns) {
    if (!t.payoutDate) {
      const k = `${t.currency || ''}${SEP}${String(t.payoutStatus || '').toLowerCase()}`;
      if (!pending.has(k)) pending.set(k, { key: k, currency: t.currency, payoutStatus: t.payoutStatus, txns: [] });
      pending.get(k).txns.push(t);
      continue;
    }
    const k = groupKey(t.payoutDate, t.payoutId, t.currency);
    if (!groups.has(k)) groups.set(k, { key: k, payoutDate: t.payoutDate, payoutId: t.payoutId, currency: t.currency, txns: [] });
    groups.get(k).txns.push(t);
  }
  for (const g of groups.values()) {
    g.allPaid = g.txns.every(t => isPaid(t.payoutStatus));
    g.statuses = [...new Set(g.txns.map(t => t.payoutStatus))];
    g.agg = aggregate(g.txns);
  }
  for (const p of pending.values()) p.agg = aggregate(p.txns);
  return { groups, pending };
}

/* ---------- reconciliation ---------------------------------------------- */

export function reconcile(groups, summaries) {
  const supplied = Array.isArray(summaries);
  const list = supplied ? summaries : [];
  for (const s of list) s.matched = false;
  const results = [];
  const sorted = [...groups.values()].sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.currency.localeCompare(b.currency));
  for (const g of sorted) {
    /** @type {Record<string, any>} */
    const res = { key: g.key, payoutDate: g.payoutDate, payoutId: g.payoutId, currency: g.currency,
      transactionCount: g.txns.length, statuses: g.statuses, agg: g.agg, txns: g.txns,
      reportedTotal: NOT_AVAILABLE, difference: NOT_AVAILABLE, bankReference: NOT_AVAILABLE,
      summary: null, status: null, reason: '', matchBasis: '' };
    if (!g.allPaid) {
      res.status = STATUS.PENDING_NOT_PAID; res.reason = `payout status is ${g.statuses.join(' / ')}, not paid`;
      results.push(res); continue;
    }
    if (g.agg.computedNet === NOT_AVAILABLE) {
      res.status = STATUS.INCOMPLETE_SOURCE; res.reason = g.agg.computedNetBasis;
      results.push(res); continue;
    }
    if (!supplied) {
      res.status = STATUS.NO_PAYOUT_ROW; res.reason = 'payouts export not supplied';
      results.push(res); continue;
    }
    // Identity priority: explicit Payout ID on both sides → date + currency with exactly one candidate.
    let candidates;
    if (g.payoutId && list.some(s => s.payoutId)) {
      candidates = list.filter(s => !s.matched && s.payoutId && s.payoutId === g.payoutId);
      res.matchBasis = 'Payout ID';
    } else {
      candidates = list.filter(s => !s.matched && s.payoutDate === g.payoutDate && (s.currency || '') === (g.currency || ''));
      res.matchBasis = 'payout date + currency';
    }
    if (candidates.length === 0) {
      res.status = STATUS.NO_PAYOUT_ROW; res.reason = `no payout row for ${g.payoutDate} ${g.currency}`.trim();
    } else if (candidates.length > 1) {
      res.status = STATUS.AMBIGUOUS_MATCH;
      res.reason = `${candidates.length} payout rows share ${res.matchBasis}; cannot identify the deposit without a Payout ID`;
    } else {
      const s = candidates[0]; s.matched = true; res.summary = s;
      res.bankReference = s.bankReference;
      if (s.total === MONEY_UNKNOWN) {
        res.status = STATUS.INCOMPLETE_SOURCE; res.reason = 'payout Total missing in payouts export';
      } else {
        res.reportedTotal = s.total;
        res.difference = s.total - g.agg.computedNet;            // exact integers
        res.status = res.difference === 0 ? STATUS.MATCHED : STATUS.DIFFERENCE;
        res.reason = res.difference === 0 ? `reported total equals ${g.agg.computedNetBasis}` : `reported total − ${g.agg.computedNetBasis}`;
      }
    }
    results.push(res);
  }
  const unmatchedPayouts = list.filter(s => !s.matched).map(s => ({ ...s, status: STATUS.UNMATCHED_PAYOUT_ROW }));
  return { results, unmatchedPayouts };
}

/* ---------- findings ---------------------------------------------------- */

const ROW_FLAG_TEXT = {
  unknown_transaction_type: ['check', 'Unknown transaction type — counted under "other", please verify'],
  net_mismatch: ['check', 'Amount − Fee does not equal Net on this row'],
  possible_duplicate_row: ['check', 'Identical to an earlier row — possible duplicate; kept in totals, please verify'],
  ambiguous_negative_format: ['check', 'Parenthesised amount refused as ambiguous; treated as UNKNOWN'],
  unparseable_amount: ['check', 'Amount, Fee or Net is not a number; treated as UNKNOWN'],
  unparseable_payout_date: ['check', 'Payout Date could not be read as YYYY-MM-DD'],
  ragged_row: ['check', 'Row has fewer cells than the header; missing cells are UNKNOWN'],
  unexpected_sign: ['info', 'Sign is unusual for this type (a positive refund or a negative charge)'],
  negative_fee: ['info', 'Negative fee (a fee refund) — kept as exported'],
  fee_only_row: ['info', 'Fee with no amount on this row'],
  zero_amount_row: ['info', 'Zero amount row'],
};

export function findings(model) {
  const out = [];
  for (const r of model.results) {
    if (r.status === STATUS.DIFFERENCE) out.push({ severity: 'check', code: 'payout_difference', where: `${r.payoutDate} ${r.currency}`,
      message: `Reported payout total differs from ${r.agg.computedNetBasis} by ${fmt(r.difference)} ${r.currency}` });
    if (r.status === STATUS.AMBIGUOUS_MATCH) out.push({ severity: 'check', code: 'ambiguous_payout_match', where: `${r.payoutDate} ${r.currency}`, message: r.reason });
    if (r.status === STATUS.INCOMPLETE_SOURCE) out.push({ severity: 'check', code: 'incomplete_source', where: `${r.payoutDate} ${r.currency}`, message: `Cannot reconcile: ${r.reason}` });
    if (r.status === STATUS.NO_PAYOUT_ROW && model.payoutsSupplied) out.push({ severity: 'check', code: 'no_payout_row', where: `${r.payoutDate} ${r.currency}`, message: r.reason });
    if (r.agg.netAggregateCheck === NET_CHECK.MISMATCH) out.push({ severity: 'check', code: 'net_aggregate_mismatch', where: `${r.payoutDate} ${r.currency}`,
      message: `Σ(Amount − Fee) = ${fmt(r.agg.calculatedNet)} but Σ(Net) = ${fmt(r.agg.reportedNetSum)}` });
  }
  for (const u of model.unmatchedPayouts) out.push({ severity: 'check', code: 'unmatched_payout_row', where: `${u.payoutDate} ${u.currency}`,
    message: `Payout row (total ${fmt(u.total)}) has no transactions in the transactions export` });
  for (const p of model.pending.values()) out.push({ severity: 'info', code: 'pending_not_paid_out', where: p.currency || '',
    message: `${p.txns.length} transaction(s) with no Payout Date (status ${p.payoutStatus}) — not yet paid out, not reconciled` });
  const flagged = new Map();
  for (const t of model.txns) for (const f of t.flags) {
    if (!flagged.has(f)) flagged.set(f, []);
    flagged.get(f).push(t.line);
  }
  for (const [f, lines] of flagged) {
    const [severity, message] = ROW_FLAG_TEXT[f] || ['info', f];
    out.push({ severity, code: f, where: `rows ${lines.slice(0, 12).join(', ')}${lines.length > 12 ? ` … (${lines.length} total)` : ''}`, message, count: lines.length });
  }
  for (const s of model.payouts) if (s.internalCheck === NET_CHECK.MISMATCH) out.push({ severity: 'info', code: 'payout_row_internal_mismatch',
    where: `payouts export row ${s.line}`, message: 'Charges + Refunds + Adjustments + Reserved + Retried − Fees does not equal Total on this payout row' });
  if (model.results.some(r => !r.payoutId) && model.payoutsSupplied) out.push({ severity: 'info', code: 'no_payout_id',
    where: 'transactions export', message: 'No Payout ID column: two payouts on the same date and currency cannot be told apart (AMBIGUOUS_MATCH).' });
  const order = { check: 0, info: 1 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ---------- totals ------------------------------------------------------ */

const KEYS = ['grossCharges', 'refunds', 'adjustments', 'disputes', 'reserves', 'transfers', 'other', 'totalFees', 'computedNet'];

export function totalsByCurrency(results) {
  const byCurrency = new Map();
  for (const r of results) {
    const c = r.currency || '(no currency column)';
    if (!byCurrency.has(c)) {
      /** @type {Record<string, any>} */
      const fresh = { currency: c, payouts: 0, transactions: 0, reportedTotal: 0, reportedTotalCount: 0,
        ...Object.fromEntries(KEYS.map(k => [k, 0])) };
      byCurrency.set(c, fresh);
    }
    const t = byCurrency.get(c);
    t.payouts++; t.transactions += r.transactionCount;
    for (const k of KEYS) {
      if (t[k] === NOT_AVAILABLE) continue;
      t[k] = r.agg[k] === NOT_AVAILABLE ? NOT_AVAILABLE : t[k] + r.agg[k];
    }
    if (r.reportedTotal !== NOT_AVAILABLE) { t.reportedTotal += r.reportedTotal; t.reportedTotalCount++; }
  }
  const rows = [...byCurrency.values()];
  return { byCurrency: rows, crossCurrencyTotal: rows.length > 1 ? NOT_AVAILABLE : (rows[0] ? rows[0].computedNet : NOT_AVAILABLE) };
}

/* ---------- unknown / missing ------------------------------------------ */

export function unknownReport(model) {
  const absent = model.columns.transactions.absent || [];
  const counts = { amount: 0, fee: 0, net: 0 };
  for (const t of model.txns) {
    if (t.amount === MONEY_UNKNOWN) counts.amount++;
    if (t.fee === MONEY_UNKNOWN) counts.fee++;
    if (t.net === MONEY_UNKNOWN) counts.net++;
  }
  return {
    absentColumns: absent,
    unknownValues: counts,
    notInAnyExport: ['sales tax per order', 'shipping per order', 'fee VAT semantics (VAT column passed through as exported only)',
      'bank statement lines', 'orders paid through other gateways'],
    payoutsSupplied: model.payoutsSupplied,
  };
}

/* ---------- pipeline ---------------------------------------------------- */

/** Run everything. `payoutsText` is optional. */
export function analyse(transactionsText, transactionsFile = 'transactions.csv', payoutsText = null, payoutsFile = 'payouts.csv') {
  const tx = toTransactions(parseCsv(transactionsText), transactionsFile);
  const model = { txns: tx.txns, columns: { transactions: tx, payouts: null }, payouts: [], payoutsSupplied: false,
    errors: [...tx.rowErrors], results: [], unmatchedPayouts: [], pending: new Map(), findings: [], totals: null, unknown: null };
  if (tx.kind !== 'transactions') {
    model.errors.push(tx.kind === 'payouts'
      ? 'This looks like the payouts export. Drop it in the second slot; the first file must be the balance transactions export.'
      : `Not a Shopify Payments transactions export: expected columns like Transaction Date, Type, Amount, Fee, Net. Found: ${tx.header.join(', ') || '(none)'}`);
    return model;
  }
  if (payoutsText !== null && payoutsText !== undefined) {
    const po = toPayoutSummaries(parseCsv(payoutsText), payoutsFile);
    model.columns.payouts = po;
    if (po.kind === 'payouts') { model.payouts = po.payouts; model.payoutsSupplied = true; }
    else model.errors.push(`Second file is not a payouts export: expected Payout Date, Charges, Refunds, Fees, Total. Found: ${po.header.join(', ') || '(none)'}`);
  }
  const { groups, pending } = groupByPayout(model.txns);
  const rec = reconcile(groups, model.payoutsSupplied ? model.payouts : null);
  model.results = rec.results; model.unmatchedPayouts = rec.unmatchedPayouts; model.pending = pending;
  model.totals = totalsByCurrency(model.results);
  model.findings = findings(model);
  model.unknown = unknownReport(model);
  return model;
}

/* ---------- exports ----------------------------------------------------- */

export const fmt = minor => (minor === MONEY_UNKNOWN || minor === NOT_AVAILABLE) ? NOT_AVAILABLE : fromMinor(minor).toFixed(2);
const numOrNA = v => (v === MONEY_UNKNOWN || v === NOT_AVAILABLE) ? csvText(NOT_AVAILABLE) : csvNumber(fmt(v));

export function safeFilename(base, ext) {
  const clean = String(base).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'export';
  return `${clean}.${ext}`;
}

export function payoutSummaryCsv(model) {
  const header = ['payout_date', 'payout_id', 'currency', 'payout_status', 'transaction_count', 'gross_charges', 'refunds',
    'adjustments', 'disputes', 'reserves', 'transfers', 'other', 'total_fees', 'computed_net', 'computed_net_basis',
    'sum_of_net_column', 'reported_total', 'difference', 'match_status', 'bank_reference', 'source_files', 'notes'];
  const rows = model.results.map(r => [
    csvText(r.payoutDate), csvText(r.payoutId ?? NOT_AVAILABLE), csvText(r.currency), csvText(r.statuses.join(' / ')),
    csvNumber(r.transactionCount), numOrNA(r.agg.grossCharges), numOrNA(r.agg.refunds), numOrNA(r.agg.adjustments),
    numOrNA(r.agg.disputes), numOrNA(r.agg.reserves), numOrNA(r.agg.transfers), numOrNA(r.agg.other), numOrNA(r.agg.totalFees),
    numOrNA(r.agg.computedNet), csvText(r.agg.computedNetBasis), numOrNA(r.agg.reportedNetSum), numOrNA(r.reportedTotal),
    numOrNA(r.difference), csvText(r.status), csvText(r.bankReference),
    csvText([...new Set(r.txns.map(t => t.sourceFile))].join(' | ')), csvText(r.reason),
  ]);
  for (const u of model.unmatchedPayouts) rows.push([
    csvText(u.payoutDate ?? u.payoutDateRaw), csvText(u.payoutId ?? NOT_AVAILABLE), csvText(u.currency), csvText(u.status),
    csvNumber(0), ...Array(8).fill(csvText(NOT_AVAILABLE)), csvText('no transactions in transactions export'),
    csvText(NOT_AVAILABLE), numOrNA(u.total), csvText(NOT_AVAILABLE), csvText(STATUS.UNMATCHED_PAYOUT_ROW), csvText(u.bankReference),
    csvText(u.sourceFile), csvText('payout row without matching transactions'),
  ]);
  return buildCsv(header, rows);
}

export function transactionDetailCsv(model) {
  const header = ['source_file', 'source_row', 'payout_date', 'payout_id', 'currency', 'type_raw', 'type_normalized', 'bucket',
    'order', 'checkout', 'transaction_date_raw', 'transaction_date', 'available_on', 'payout_status',
    'amount_raw', 'amount', 'fee_raw', 'fee', 'net_raw', 'net', 'calculated_net', 'net_check',
    'presentment_amount_raw', 'presentment_currency', 'vat_as_exported', 'transformation', 'flags'];
  const rows = model.txns.map(t => [
    csvText(t.sourceFile), csvNumber(t.line), csvText(t.payoutDate ?? NOT_AVAILABLE), csvText(t.payoutId ?? NOT_AVAILABLE),
    csvText(t.currency), csvText(t.typeRaw), csvText(t.typeNormalized), csvText(t.bucket),
    csvText(t.order), csvText(t.checkout), csvText(t.transactionDateRaw), csvText(t.transactionDate ?? NOT_AVAILABLE),
    csvText(t.availableOn), csvText(t.payoutStatus),
    csvText(t.prov.amount.raw_value), numOrNA(t.amount), csvText(t.prov.fee.raw_value), numOrNA(t.fee),
    csvText(t.prov.net.raw_value), numOrNA(t.net), numOrNA(t.calculatedNet), csvText(t.netCheck),
    csvText(t.presentmentAmountRaw), csvText(t.presentmentCurrency), csvText(t.vatRaw),
    csvText(t.prov.amount.transformation), csvText(t.flags.join(' ')),
  ]);
  return buildCsv(header, rows);
}

/** UTF-16 files start with a byte-order mark; we ask for a UTF-8 re-export instead of guessing. */
export function looksUtf16(bytes) {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}
