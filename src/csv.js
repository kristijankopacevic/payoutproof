/* Typed CSV cells for every export PayoutProof writes.
 *
 * Audited local copy of MarginProof `src/csv.js` (commit d5fb2de/ba812c8);
 * bodies verbatim, see REUSE_NOTES.md.
 *
 * Why this exists: a merchant's product export is untrusted input. A SKU or
 * product title such as `=HYPERLINK("http://evil","x")` or `+cmd|' /C calc'!A0`
 * that is copied into an exported CSV becomes a live formula the moment the
 * merchant opens the file in Excel, Sheets or LibreOffice. Wrapping a cell in
 * quotes does NOT prevent that. Spreadsheet applications treat a cell that
 * begins with = + - @ (and tab / carriage return) as a formula or DDE call.
 *
 * Two cell types, chosen by the caller, never inferred from the value:
 *   csvText(v)   untrusted or free text. Always quoted; a leading formula
 *                trigger character is neutralised with a leading apostrophe.
 *   csvNumber(v) a number this site computed itself (integer minor units
 *                converted with fromMinor, percentages, counts). Emitted as a
 *                bare numeric literal so `-7.99` stays a number. Anything that
 *                is not a plain numeric literal falls back to csvText, so a
 *                mistake degrades to a harmless quoted string, never to a
 *                formula.
 */

// Leading whitespace (including NBSP via \s) does not hide a trigger.
const FORMULA_TRIGGER = /^\s*[=+\-@\t\r]/;
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;
// Control characters other than tab, newline and carriage return are stripped;
// tab and CR are kept so the trigger check above can neutralise them.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const STRIP_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Untrusted or free text → quoted, formula-neutralised CSV cell. */
export function csvText(value) {
  let s = String(value ?? '').replace(STRIP_CONTROL, '');
  if (FORMULA_TRIGGER.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Site-generated number → bare numeric literal; anything else → csvText. */
export function csvNumber(value) {
  if (value === null || value === undefined || value === '') return '""';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '""';
  }
  const s = String(value).trim();
  return NUMERIC_LITERAL.test(s) ? s : csvText(value);
}

/** Join already-typed cells into one CSV line. */
export function csvRow(cells) {
  return cells.join(',');
}

/** Build a CSV document from header names and rows of already-typed cells. */
export function buildCsv(header, rows) {
  return [csvRow(header.map(csvText))].concat(rows.map(csvRow)).join('\n');
}
