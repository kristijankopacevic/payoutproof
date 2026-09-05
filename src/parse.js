/* PayoutProof — CSV parsing and integer-minor-unit money helpers.
 *
 * Audited local copy of the generic helpers from MarginProof `src/audit.js`
 * (github.com/kristijankopacevic/marginproof, commit ba812c8). Function bodies
 * are verbatim; see REUSE_NOTES.md. Kept local on purpose: PayoutProof has no
 * runtime dependency on any other repository.
 *
 * The rule that shapes everything downstream: UNKNOWN IS NOT ZERO. A value the
 * export does not carry, or that cannot be parsed, is MONEY_UNKNOWN (null) and
 * is never silently replaced by 0.
 */

export const MONEY_UNKNOWN = null;

/* ---------- money is integers ------------------------------------------
 * Every monetary value in this file is an integer count of minor units
 * (cents). Nothing is stored or compared as a floating-point currency amount.
 *
 * This is not theoretical tidiness. In binary floating point
 * 19.99 - 19.99*0.3 is 13.992999999999999, and a merchant repricing a
 * catalogue off "13.99 vs 13.993" deserves better than an answer that depends
 * on which side of a rounding boundary the noise fell. Parsing converts to
 * cents once, at the edge; formatting converts back once, for display; and
 * everything between is integer arithmetic.
 */

/** Convert a parsed decimal amount to integer minor units, or null. */
export function toMinor(value) {
  if (value === MONEY_UNKNOWN) return MONEY_UNKNOWN;
  // Round half away from zero on the scaled value: the input already came from
  // a decimal string, so this only absorbs the representation error.
  return Math.round(value * 100);
}

/** Integer minor units back to a display number. */
export function fromMinor(minor) {
  return minor === MONEY_UNKNOWN ? MONEY_UNKNOWN : minor / 100;
}

/* ---------- parsing ---------------------------------------------------- */

/** RFC4180-ish CSV split: handles quoted fields, embedded commas and "" escapes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  // Strip a UTF-8 BOM; Shopify and Excel both emit one and it corrupts the
  // first header name, which silently breaks column detection.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

/** Numbers as merchants actually export them: "1.234,56", "$12.00", "12 %".
 *
 * Returns a plain decimal. Callers that hold money call `toMinor` on the
 * result; quantities such as stock counts stay decimal.
 */
export function parseNumber(raw) {
  if (raw === undefined || raw === null) return MONEY_UNKNOWN;
  let s = String(raw).trim();
  if (s === '') return MONEY_UNKNOWN;
  s = s.replace(/[^\d.,-]/g, '');   // '-' last in the class is literal (lint: no-useless-escape)
  if (s === '' || s === '-') return MONEY_UNKNOWN;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,56
  else s = s.replace(/,/g, '');                                          // 1,234.56
  const n = Number(s);
  return Number.isFinite(n) ? n : MONEY_UNKNOWN;
}
