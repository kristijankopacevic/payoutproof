/* PayoutProof parsing helpers — run with: node --test tests/
 *
 * These cover the audited local copy in src/parse.js (see REUSE_NOTES.md). The
 * cases are ported from the MarginProof suite the helpers came from, so the
 * copy is proven to behave identically here rather than assumed to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseNumber, toMinor, fromMinor, MONEY_UNKNOWN } from '../src/parse.js';

test('csv parser handles quotes, embedded commas and escaped quotes', () => {
  const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('csv parser strips a BOM so the first header still matches', () => {
  const rows = parseCsv('\ufeffPayout Date,Amount\n2026-08-03,10.00\n');
  assert.equal(rows[0][0], 'Payout Date');
});

test('csv parser accepts CRLF and drops blank lines', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('numbers parse in both european and anglo formats, with currency noise', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('$12.00'), 12);
  assert.equal(parseNumber('12,50 €'), 12.5);
  assert.equal(parseNumber('-3.5'), -3.5);
});

test('empty and junk values are unknown, never zero', () => {
  assert.equal(parseNumber(''), MONEY_UNKNOWN);
  assert.equal(parseNumber('   '), MONEY_UNKNOWN);
  assert.equal(parseNumber(undefined), MONEY_UNKNOWN);
  assert.equal(parseNumber(null), MONEY_UNKNOWN);
  assert.equal(parseNumber('n/a'), MONEY_UNKNOWN);
  assert.notEqual(parseNumber(''), 0);
});

test('money is held as integer minor units, so decimals cannot drift', () => {
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor(0.1) + toMinor(0.2), 30, '0.1+0.2 is exact in cents');
  assert.equal(toMinor(-7.99), -799);
  assert.equal(toMinor(MONEY_UNKNOWN), MONEY_UNKNOWN, 'unknown stays unknown');
  assert.equal(fromMinor(1999), 19.99);
  assert.equal(fromMinor(MONEY_UNKNOWN), MONEY_UNKNOWN);
});
