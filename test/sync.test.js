'use strict';
/* Backend sheet sync (end to end over HTTP) and the efficiency log job. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, BACKEND_ID } = require('./harness');
const { logEfficiency } = require('../server/jobs');

const HEAD = ['Date', 'TL Name', 'TC Emp ID', 'TC Name', 'Customer Name', 'RM', 'Stage', 'Amount', 'Bank Name', 'Location'];

function backendBook(today) {
  return [HEAD,
    [today, 'Asha Rao', 'EMP001', 'Rahul Verma', 'Sunil Jadhav', 'RM1', 'Disbursed', 150000, 'HDFC Bank', 'Pune'],
    [today, 'Asha Rao', 'EMP002', 'Sana Khan', 'Meena Rao', 'RM1', 'Rejected', 'Low CIBIL', 'Axis Bank', 'Pune'],
    [today, 'Asha Rao', '', 'Rahul', 'Ravi Shah', 'RM1', 'Pending', '', 'ICICI Bank', 'Pune'],
    [today, '', 'EMP999', 'Ghost', 'Nobody', '', 'Pending', 0, '', ''],
    ['2026-11-30', 'Asha Rao', 'EMP001', 'Rahul Verma', 'Future Customer', '', 'Pending', 0, '', ''],
    ['not a date', 'Asha Rao', 'EMP001', 'Rahul Verma', 'Broken Date', '', 'Pending', 0, '', '']
  ];
}

test('backend sync: imports cases, flags bad rows, and matches names through the TL', async () => {
  const env = await makeEnv({ backend: true });
  try {
    env.api.addBook(BACKEND_ID, { 'Backend Oct': backendBook('2026-10-29') });
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    const r = await env.call({ action: 'sync_backend', token: adm });
    assert.equal(r.ok, true, JSON.stringify(r));

    const d = await env.call({ action: 'data', token: adm });
    const bc = d.cases.filter(c => c.source === 'BACKEND');
    assert.equal(bc.length, 3, 'three valid rows become three cases');
    const sunil = bc.find(c => c.customer === 'Sunil Jadhav');
    assert.equal(sunil.stage, 'DISBURSED');
    assert.equal(sunil.amount, 150000);
    assert.equal(sunil.emp_code, 'EMP001');
    assert.equal(bc.find(c => c.customer === 'Meena Rao').reason, 'Low CIBIL');
    assert.equal(bc.find(c => c.customer === 'Ravi Shah').emp_code, 'EMP001', '"Rahul" under Asha resolves to Rahul Verma');

    const issues = await env.db.query('SELECT issue_type FROM import_issues');
    const types = issues.map(i => i.issue_type).sort();
    assert.ok(types.includes('Name not matched'), 'unknown Emp ID is reported');
    assert.ok(types.includes('Future date'), 'future date is reported');
    assert.ok(types.includes('Bad date'), 'unreadable date is reported');
  } finally { await env.close(); }
});

test('backend sync: case IDs are stable across runs (no duplicates, no churn)', async () => {
  const env = await makeEnv({ backend: true });
  try {
    env.api.addBook(BACKEND_ID, { 'Backend Oct': backendBook('2026-10-29') });
    const adm = await env.signIn('admin@gmail.com', 'Admin');
    await env.call({ action: 'sync_backend', token: adm });
    const first = (await env.call({ action: 'data', token: adm })).cases.filter(c => c.source === 'BACKEND').map(c => c.case_id).sort();
    await env.call({ action: 'sync_backend', token: adm });
    const second = (await env.call({ action: 'data', token: adm })).cases.filter(c => c.source === 'BACKEND').map(c => c.case_id).sort();
    assert.deepEqual(second, first);
    assert.equal(new Set(first).size, first.length);
  } finally { await env.close(); }
});

test('backend sync: a team leader cannot run it; a missing backend sheet is explained', async () => {
  const env = await makeEnv({ backend: true });
  try {
    const tl = await env.signIn('asha@gmail.com', 'Asha Rao');
    const r = await env.call({ action: 'sync_backend', token: tl });
    assert.equal(r.error, 'forbidden');
  } finally { await env.close(); }

  const env2 = await makeEnv({ backend: false });
  try {
    const adm = await env2.signIn('admin@gmail.com', 'Admin');
    const r = await env2.call({ action: 'sync_backend', token: adm });
    assert.equal(r.error, 'backend');
    assert.match(r.message, /not connected/);
  } finally { await env2.close(); }
});

test('efficiency log: writes rows inside the shift, nothing outside it or on Sunday', async () => {
  const inShift = await makeEnv({ hour: '14:40' });
  try {
    const n = await logEfficiency(inShift.ctx);
    assert.ok(n > 0, 'rows are written during the shift');
    const rows = await inShift.ctx.store.objects('Efficiency_Log');
    assert.ok(rows.length >= n);
  } finally { await inShift.close(); }

  const early = await makeEnv({ hour: '08:00' });
  try {
    assert.equal(await logEfficiency(early.ctx), 0, 'before the shift starts');
  } finally { await early.close(); }

  const sunday = await makeEnv({ today: '2026-11-01', hour: '14:40' });
  try {
    assert.equal(await logEfficiency(sunday.ctx), 0, 'Sundays are not logged');
  } finally { await sunday.close(); }
});
