'use strict';
/* Pure-logic tests: fingerprints (must match the old Apps Script exactly), backend parsing, scoring, dates, sessions, encryption. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, stageOf, backendDate, amountOrReason, buildMatcher, mapHeaders } = require('../server/backend-sync');
const { score } = require('../server/metrics');
const { normEmail, dateStr, addDays, todayIST, str, num } = require('../server/util');
const { makeToken, readToken, parseDataKey, encryptField, decryptField } = require('../server/security');

const SECRET = 'unit-test-secret-'.repeat(3);

test('hash matches the legacy Apps Script hash_ (case IDs depend on it)', () => {
  // Golden values produced by the original BackendSync.gs hash_ function.
  assert.equal(hash(''), 'wvjl67o803');
  assert.equal(hash('a'), '262p94epp1d');
  assert.equal(hash('Rahul Verma'), '15omfehrutr');
  assert.equal(hash('B|2026-10-01|Asha Rao|Karan|Sunil Jadhav|HDFC'), '2eo5oau8ahf');
  assert.equal(hash('Ünïcödé ₹ 5L'), '2cfc2lk83cj');
  assert.equal(hash('x'.repeat(200)), '1zxr1z96qro');
});

test('stage rules: first match wins and the default is PENDING', () => {
  assert.equal(stageOf('Disbursed'), 'DISBURSED');
  assert.equal(stageOf('Approved For Disbursal'), 'APPROVED', 'must not count as disbursed');
  assert.equal(stageOf('Approved'), 'APPROVED');
  assert.equal(stageOf('Rejected by bank'), 'REJECTED');
  assert.equal(stageOf('Declined'), 'REJECTED');
  assert.equal(stageOf('NI'), 'NOT_INTERESTED');
  assert.equal(stageOf('Not interested'), 'NOT_INTERESTED');
  assert.equal(stageOf('Document pending'), 'QUERY');
  assert.equal(stageOf('Login done'), 'PENDING');
  assert.equal(stageOf(''), 'PENDING');
  assert.equal(stageOf('something new'), 'PENDING');
});

test('backend dates: serial numbers are exact, typed dates follow the order setting', () => {
  assert.equal(backendDate(45930, 'DMY'), '2025-09-30');
  assert.equal(backendDate('2026-10-05', 'DMY'), '2026-10-05');
  assert.equal(backendDate('05/10/2026', 'DMY'), '2026-10-05');
  assert.equal(backendDate('05/10/2026', 'MDY'), '2026-05-10');
  assert.equal(backendDate('13/25/2026', 'DMY'), '', 'impossible dates are rejected');
  assert.equal(backendDate('', 'DMY'), '');
});

test('amount column: numbers are amounts, words are rejection reasons', () => {
  assert.deepEqual(amountOrReason(150000), { amount: 150000, reason: '' });
  assert.deepEqual(amountOrReason('₹1,50,000'), { amount: 150000, reason: '' });
  assert.deepEqual(amountOrReason('Low CIBIL'), { amount: 0, reason: 'Low CIBIL' });
  assert.deepEqual(amountOrReason(''), { amount: 0, reason: '' });
});

test('headers are recognised whatever their spelling', () => {
  const col = mapHeaders(['Date', 'TL Name', 'TC Emp ID', 'TC Name', 'Customer Name', 'Stage', 'Amount', 'Bank Name']);
  assert.equal(col.date, 0);
  assert.equal(col.tl, 1);
  assert.equal(col.empid, 2);
  assert.equal(col.tc, 3);
  assert.equal(col.customer, 4);
  assert.equal(col.stage, 5);
  assert.equal(col.amount, 6);
  assert.equal(col.bank, 7);
});

test('matcher: an employee ID always wins; a shared first name is settled by the TL name', () => {
  const emps = [
    { emp_code: 'EMP001', name: 'Rahul Verma', role: 'TELECALLER', team_id: 'T1', status: 'ACTIVE' },
    { emp_code: 'EMP005', name: 'Rahul Shah', role: 'TELECALLER', team_id: 'T2', status: 'ACTIVE' },
    { emp_code: 'TL01', name: 'Asha Rao', role: 'TL', team_id: 'T1', status: 'ACTIVE' },
    { emp_code: 'TL02', name: 'Bharat Shah', role: 'TL', team_id: 'T2', status: 'ACTIVE' }
  ];
  const match = buildMatcher(emps, []);
  assert.equal(match('Rahul', 'Asha Rao', '').emp.code, 'EMP001', 'TL name picks the right Rahul');
  assert.equal(match('Rahul', 'Bharat Shah', '').emp.code, 'EMP005');
  assert.equal(match('Rahul Verma', '', '').emp.code, 'EMP001');
  const byId = match('Priya', 'Asha Rao', 'EMP005');
  assert.equal(byId.emp.code, 'EMP005', 'the ID wins over the name');
  assert.ok(byId.warn, 'a mismatched name is flagged, not silently accepted');
  assert.ok(match('Nobody', '', '').error, 'unknown name gives a clear error');
  assert.ok(match('x', '', 'EMP999').error, 'unknown ID gives a clear error');
});

test('score: full marks at target, halved when half the logins and calls', () => {
  const k = { connBm: 0.4, disbBm: 0.3 };
  assert.equal(score(10, 10, 100, 100, 40, 3, k), 100);
  const half = score(5, 10, 50, 100, 0, 0, k);
  assert.ok(Math.abs(half - 100 * (0.45 * 0.5 + 0.30 * 0.5)) < 1e-9);
  assert.equal(score(0, 0, 0, 0, 0, 0, k), 0, 'no target means no score, never NaN');
  assert.equal(score(20, 10, 200, 100, 0, 0, k) <= 100, true, 'caps at 100');
});

test('dates: IST calendar helpers', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(todayIST(new Date('2026-10-28T19:00:00Z')), '2026-10-29', '19:00 UTC is already the 29th in India');
  assert.equal(dateStr('29/10/2026'), '2026-10-29');
  assert.equal(str(null), '');
  assert.equal(num('12.5'), 12.5);
  assert.equal(num('abc'), 0);
});

test('emails: Gmail rules (dots and +tags ignored) so one person has one identity', () => {
  assert.equal(normEmail('Asha.Rao+work@gmail.com'), 'asharao@gmail.com');
  assert.equal(normEmail('A.B+x@GMAIL.com'), 'ab@gmail.com');
  assert.equal(normEmail('Someone@Example.com'), 'someone@example.com');
});

test('session tokens: valid until expiry, rejected when tampered or after expiry', () => {
  const now = Date.parse('2026-10-29T09:00:00Z');
  const tok = makeToken('admin@gmail.com', SECRET, now, 7);
  assert.equal(readToken(tok, SECRET, now + 1000), 'admin@gmail.com');
  assert.equal(readToken(tok, 'another-secret-another-secret-xx', now + 1000), null, 'wrong secret');
  assert.equal(readToken(tok, SECRET, now + 8 * 864e5), null, 'expired');
  assert.equal(readToken(tok.slice(0, -2) + 'AA', SECRET, now + 1000), null, 'tampered');
  assert.equal(readToken('', SECRET, now), null);
  assert.equal(readToken(undefined, SECRET, now), null);
});

test('encryption: round-trips, uses a fresh nonce, and rejects tampering', () => {
  const key = parseDataKey(Buffer.alloc(32, 7).toString('base64'));
  const a = encryptField('ABCDE1234F', key);
  const b = encryptField('ABCDE1234F', key);
  assert.notEqual(a, b, 'same plaintext must not give the same ciphertext');
  assert.ok(a.startsWith('v1:'));
  assert.equal(decryptField(a, key), 'ABCDE1234F');
  assert.equal(encryptField('', key), '', 'empty stays empty');
  const bad = a.slice(0, -3) + (a.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  assert.throws(() => decryptField(bad, key));
  assert.throws(() => parseDataKey(Buffer.alloc(16).toString('base64')), 'key must be 32 bytes');
});
