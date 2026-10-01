import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, score, type Case } from '../src/eval.ts';

test('csv: quotes, commas and newlines inside fields, CRLF, blank lines', () => {
  const rows = parseCsv('subject,body,expected_category\r\n"Hi, there","line one\nline ""two""",pricing\r\n\r\nPlain,text,other\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { subject: 'Hi, there', body: 'line one\nline "two"', expected_category: 'pricing' });
  assert.equal(rows[1].subject, 'Plain');
  assert.deepEqual(parseCsv(''), []);
});

const kase = (expected: Case['expected'], got: Case['expected'], reply = 'ok', guardedConfident = true): Case =>
  ({ subject: `${expected}->${got}`, expected, got, confident: true, reply, guardedConfident });
const KB = 'Starter package costs USD 799.';

test('score: accuracy threshold, per-category numbers and confusions', () => {
  const cases = [...Array(9).fill(0).map(() => kase('pricing', 'pricing')), kase('pricing', 'inquiry')];
  const s = score(cases, KB);
  assert.equal(s.accuracy, 0.9);
  assert.equal(s.pass, true);
  assert.deepEqual(s.perCategory.pricing, { total: 10, correct: 9 });
  assert.equal(s.confusions.length, 1);
  assert.equal(score([...cases, kase('other', 'pricing')], KB).pass, false, '9/11 < 90%');
});

test('score: one invented price fails the run even at 100% accuracy', () => {
  const cases = [kase('pricing', 'pricing', 'It costs USD 799.'), kase('pricing', 'pricing', 'It costs USD 500.')];
  const s = score(cases, KB);
  assert.equal(s.accuracy, 1);
  assert.equal(s.inventedPrices.length, 1);
  assert.equal(s.pass, false);
});

test('score: auto-answering a complaint or legal message is flagged as dangerous', () => {
  const s = score([kase('complaint', 'inquiry'), ...Array(20).fill(0).map(() => kase('inquiry', 'inquiry'))], KB);
  assert.equal(s.dangerous.length, 1);
  assert.equal(s.pass, false);
  assert.equal(score([kase('complaint', 'inquiry', 'ok', false), ...Array(20).fill(0).map(() => kase('inquiry', 'inquiry'))], KB).dangerous.length, 0, 'not confident = a person still reviews it');
});

test('score: empty input does not pass', () => {
  assert.equal(score([], KB).pass, false);
});
