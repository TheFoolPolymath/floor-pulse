'use strict';
/* Integration tests over HTTP: sign-in, data scoping, admin-only actions, directory encryption, cases and remarks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');

test('sign-in: unknown Google account is refused, known admin gets a token', async () => {
  const env = await makeEnv();
  try {
    const stranger = await env.call({ action: 'login', id_token: 'good:stranger@gmail.com:X' });
    assert.equal(stranger.error, 'not_allowed');
    const bad = await env.call({ action: 'login', id_token: 'forged' });
    assert.ok(bad.error, 'a token Google does not vouch for must be refused');
    const adm = await env.call({ action: 'login', id_token: 'good:admin@gmail.com:Admin' });
    assert.equal(adm.ok, true);
    assert.equal(adm.user.role, 'ADMIN');
    assert.ok(adm.token);
  } finally { await env.close(); }
});

test('data call needs a valid session and returns the expected keys', async () => {
  const env = await makeEnv();
  try {
    const none = await env.call({ action: 'data' });
    assert.equal(none.error, 'auth');
    const tok = await env.signIn('admin@gmail.com', 'Admin');
    const d = await env.call({ action: 'data', token: tok });
    for (const k of ['role', 'employees', 'attendance', 'kpi', 'calls', 'cases', 'remarks', 'team_daily', 'targets', 'efficiency_log']) {
      assert.ok(k in d, 'missing key ' + k);
    }
    assert.equal(d.employees.length, 6);
    assert.equal(d.kpi.length, 5);
    assert.equal(d.calls.length, 5);
  } finally { await env.close(); }
});

test('team leader sees only their own team per person, but team totals for all', async () => {
  const env = await makeEnv();
  try {
    const tok = await env.signIn('asha@gmail.com', 'Asha Rao');
    const t = await env.call({ action: 'data', token: tok });
    assert.equal(t.error, undefined);
    const codes = new Set(t.kpi.map(k => k.emp_code));
    assert.deepEqual([...codes].sort(), ['EMP001', 'EMP002']);
    const emps = t.employees.map(e => e.emp_code).sort();
    assert.deepEqual(emps, ['EMP001', 'EMP002', 'TL01']);
    assert.ok(t.team_daily.length > 0, 'team totals should be present');
  } finally { await env.close(); }
});

test('admin-only actions are refused for a team leader', async () => {
  const env = await makeEnv();
  try {
    const tl = await env.signIn('asha@gmail.com', 'Asha Rao');
    const dir = await env.call({ action: 'directory', token: tl });
    assert.equal(dir.error, 'forbidden');
    const tgt = await env.call({ action: 'target_set', token: tl, month: '2026-10', items: [] });
    assert.equal(tgt.error, 'forbidden');
    const rem = await env.call({ action: 'remark_add', token: tl, emp_code: 'EMP001', category: 'Dress code', note: 'x' });
    assert.equal(rem.error, 'forbidden');
  } finally { await env.close(); }
});

test('directory: PAN round-trips, is encrypted at rest, and is not in the normal data call', async () => {
  const env = await makeEnv();
  try {
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    const save = await env.call({ action: 'dir_save', token: adm, emp_code: 'EMP001', name: 'Rahul Verma', status: 'ACTIVE',
      fields: { pan: 'ABCDE1234F', aadhaar: '234567890123', account_no: '123456789012', mobile: '9876543210', full_name: 'Rahul Verma' } });
    assert.equal(save.ok, true);
    const dir = await env.call({ action: 'directory', token: adm });
    assert.equal(dir.directory.find(x => x.emp_code === 'EMP001').pan, 'ABCDE1234F');
    const raw = await env.db.query("SELECT pan_enc FROM directory WHERE emp_code='EMP001'");
    assert.ok(String(raw[0].pan_enc).startsWith('v1:'), 'PAN must be stored encrypted');
    assert.ok(!String(raw[0].pan_enc).includes('ABCDE'), 'plain PAN must not appear in the database');
    const d = await env.call({ action: 'data', token: adm });
    assert.equal(JSON.stringify(d).includes('ABCDE1234F'), false, 'PAN must not leak into the data call');
  } finally { await env.close(); }
});

test('cases: team leader can add a case for own telecaller, not for another team', async () => {
  const env = await makeEnv();
  try {
    const tl = await env.signIn('asha@gmail.com', 'Asha Rao');
    const ok = await env.call({ action: 'case_add', token: tl, emp_code: 'EMP001', customer: 'Sunil Jadhav', bank: 'HDFC Bank', amount: '5L', stage: 'PENDING' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.match(ok.case_id, /^C/);
    const other = await env.call({ action: 'case_add', token: tl, emp_code: 'EMP003', customer: 'X', bank: 'Y', amount: '1L', stage: 'PENDING' });
    assert.ok(other.error, 'another team\'s telecaller must be refused');
    const d = await env.call({ action: 'data', token: tl });
    assert.ok(d.cases.some(c => c.case_id === ok.case_id), 'the new case should show in the data call');
  } finally { await env.close(); }
});

test('remarks: admin adds a remark, voiding hides it from the data call', async () => {
  const env = await makeEnv();
  try {
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    const add = await env.call({ action: 'remark_add', token: adm, emp_code: 'EMP001', category: 'Dress code', note: 'Late to floor' });
    assert.equal(add.ok, true, JSON.stringify(add));
    let d = await env.call({ action: 'data', token: adm });
    assert.ok(d.remarks.some(r => r.remark_id === add.remark_id));
    const v = await env.call({ action: 'remark_void', token: adm, remark_id: add.remark_id });
    assert.equal(v.ok, true, JSON.stringify(v));
    d = await env.call({ action: 'data', token: adm });
    assert.equal(d.remarks.some(r => r.remark_id === add.remark_id), false);
  } finally { await env.close(); }
});

test('targets: admin can save a monthly target', async () => {
  const env = await makeEnv();
  try {
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    const r = await env.call({ action: 'target_set', token: adm, month: '2026-10', items: [{ scope: 'EMP', id: 'EMP001', amount: '16L' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { await env.close(); }
});

test('an unknown action is refused cleanly', async () => {
  const env = await makeEnv();
  try {
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    const r = await env.call({ action: 'nope', token: adm });
    assert.equal(r.error, 'bad_request');
  } finally { await env.close(); }
});
