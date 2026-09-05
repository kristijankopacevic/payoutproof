/* CSV export safety — run with: node --test tests/
 *
 * Every export on this site copies merchant-controlled text (SKUs, titles,
 * finding details) into a CSV. These tests prove that such text cannot become
 * an executable spreadsheet formula, and that the numbers we generate
 * ourselves still export as numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { csvText, csvNumber, buildCsv } from '../src/csv.js';
import { parseCsv } from '../src/parse.js';

const unquote = cell => parseCsv(cell + '\n')[0][0];

test('formula triggers at the start of untrusted text are neutralised', () => {
  for (const payload of [
    '=HYPERLINK("http://evil.example","click")',
    "+cmd|' /C calc'!A0",
    '-1+1',
    '@SUM(A1:A9)',
    '\tX',
    '\rX',
    '=1+1',
    '  =cmd',          // leading whitespace does not hide the trigger
    ' =cmd',      // non-breaking space either
  ]) {
    const cell = csvText(payload);
    const roundTripped = unquote(cell);
    assert.equal(roundTripped[0], "'", `payload must gain a leading apostrophe: ${JSON.stringify(payload)}`);
    assert.ok(!/^[=+\-@\t\r]/.test(roundTripped), 'must not start with a formula character');
  }
});

test('ordinary text survives unchanged, including quotes and commas', () => {
  assert.equal(unquote(csvText('Candle, large "vanilla"')), 'Candle, large "vanilla"');
  assert.equal(unquote(csvText('SKU-001')), 'SKU-001');
  assert.equal(csvText(null), '""');
  assert.equal(csvText(undefined), '""');
});

test('control characters that could hide a payload are stripped from text', () => {
  assert.equal(unquote(csvText('a\x01b\x7fc')), 'abc');
});

test('generated numbers export as bare numeric literals, negatives included', () => {
  assert.equal(csvNumber(-7.99), '-7.99');
  assert.equal(csvNumber(0), '0');
  assert.equal(csvNumber(1234.5), '1234.5');
  assert.equal(csvNumber('12.00'), '12.00');
  assert.equal(csvNumber('-0.01'), '-0.01');
});

test('a non-numeric value passed as a number is treated as untrusted text', () => {
  assert.equal(csvNumber('=1+1'), csvText('=1+1'));
  assert.equal(csvNumber('-1+1'), csvText('-1+1'));
  assert.equal(csvNumber('abc'), '"abc"');
  assert.equal(csvNumber(NaN), '""');
  assert.equal(csvNumber(Infinity), '""');
  assert.equal(csvNumber(null), '""');
  assert.equal(csvNumber(''), '""');
});

test('a built CSV round-trips through our parser with payloads defused', () => {
  const csv = buildCsv(['SKU', 'Price', 'Reason'], [
    [csvText('=HYPERLINK("http://evil","x")'), csvNumber(-7.99), csvText('below cost')],
    [csvText('A-1'), csvNumber(12), csvText('+cmd')],
  ]);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['SKU', 'Price', 'Reason']);
  assert.equal(rows[1][0], "'=HYPERLINK(\"http://evil\",\"x\")");
  assert.equal(rows[1][1], '-7.99');
  assert.equal(rows[2][2], "'+cmd");
  assert.equal(rows.length, 3);
});

test('header names themselves go through text escaping', () => {
  const csv = buildCsv(['=bad header'], []);
  assert.equal(parseCsv(csv + '\n')[0][0], "'=bad header");
});
