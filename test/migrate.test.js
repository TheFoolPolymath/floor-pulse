'use strict';
/* One-time migration from the old spreadsheet: dry run, copy, encryption, idempotence, and the old sheet left untouched. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, KEY } = require('./harness');
const { migrateFromSheets } = require('../server/migrate-sheets');
const { parseDataKey, decryptField } = require('../server/security');

const OLD = 'OLD_SHEET';
const DIR_HEAD = ['emp_code', 'full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'pan', 'aadhaar', 'bank_name', 'account_holder', 'account_no', 'ifsc', 'bank_branch', 'designation', 'salary', 'updated_on', 'updated_by'];

function oldBook({ withDevices = true } = {}) {
  const book = {
    Employees: [['emp_code', 'name', 'team_id', 'team_name', 'leader_code', 'role', 'status', 'join_date', 'exit_date'],
      ['TL01', 'Asha Rao', 'T1', 'Alpha', '', 'TL', 'ACTIVE', '2025-02-01', ''],
      ['EMP001', 'Rahul Verma', 'T1', 'Alpha', 'TL01', 'TELECALLER', 'ACTIVE', '2025-03-01', '']],
    Access: [['email', 'name', 'role', 'team_id', 'status', 'added_on'], ['Admin@Gmail.com', 'Admin', 'ADMIN', '', 'ACTIVE', '2025-01-01']],
    Config: [['key', 'value', 'note'], ['per_head_calls', 250, 'calls per head']],
    Name_Map: [['tc_name', 'tl_name', 'emp_code'], ['Rahul', 'Asha Rao', 'EMP001']],
    Directory: [DIR_HEAD, ['EMP001', 'Rahul Verma', '1995-04-12', 'Male', 'Single', 'O+', 'Father', 'Mother', 'Contact', '9999999999', 'Pune', '9876543210', 'rahul@example.com', 'ABCDE1234F', '234567890123', 'HDFC Bank', 'Rahul Verma', '123456789012', 'HDFC0001234', 'Pune', 'Telecaller', 15000, '2026-01-10', 'admin@gmail.com']],
    Targets: [['scope', 'id', 'month', 'target_amount', 'set_by', 'set_on'], ['EMP', 'EMP001', '2026-10', 1600000, 'admin@gmail.com', '2026-10-01']],
    Remarks: [['remark_id', 'date', 'emp_code', 'category', 'note', 'given_by', 'created_at', 'status'], ['R1', '2026-10-20', 'EMP001', 'Late coming', 'Came at 11', 'admin@gmail.com', '2026-10-20 11:05', 'ACTIVE']],
    Cases: [['case_id', 'date', 'emp_code', 'customer', 'bank', 'product', 'amount', 'stage', 'stage_date', 'updated_by', 'source', 'rm', 'location', 'reason'],
      ['C1', '2026-10-28', 'EMP001', 'Sunil Jadhav', 'HDFC Bank', '', 150000, 'DISBURSED', '2026-10-28', 'Asha', 'APP', '', 'Pune', '']],
    Case_Notes: [['case_id', 'date', 'by', 'note'], ['C1', '2026-10-28 10:00', 'Asha Rao', 'Waiting for salary slip']],
    Import_Issues: [['when', 'type', 'date', 'tc_name', 'tl_name', 'customer', 'detail', 'sheet_row'], ['x', 'Bad date', '', '', '', '', 'old', '']]
  };
  if (withDevices) book.Devices = [['device_id', 'email', 'name', 'role', 'device', 'mode', 'platform', 'first_seen', 'last_seen', 'sign_ins'], ['abcdef1234567890', 'asha@gmail.com', 'Asha Rao', 'TL', 'Pixel', 'app', 'android', '2026-10-01 09:00', '2026-10-29 09:00', 12]];
  return book;
}

test('migration: dry run changes nothing and reports what it would copy', async () => {
  const env = await makeEnv({ seed: false });
  try {
    env.api.addBook(OLD, oldBook());
    const before = JSON.stringify(await env.api.grid(OLD, 'Employees'));
    const out = await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: parseDataKey(KEY), apply: false });
    assert.equal(out.apply, false);
    assert.match(out.report.find(r => r.tab === 'Employees').status, /would copy 2 rows/);
    const [{ n }] = await env.db.query('SELECT COUNT(*) AS n FROM employees');
    assert.equal(Number(n), 0, 'a dry run writes nothing');
    assert.equal(JSON.stringify(await env.api.grid(OLD, 'Employees')), before);
  } finally { await env.close(); }
});

test('migration: copies every database tab, encrypts directory secrets, and leaves the old sheet untouched', async () => {
  const env = await makeEnv({ seed: false });
  try {
    env.api.addBook(OLD, oldBook());
    const beforeGrids = await Promise.all(['Employees', 'Directory', 'Cases'].map(t => env.api.grid(OLD, t)));
    const out = await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: parseDataKey(KEY), apply: true });
    assert.equal(out.apply, true);
    const statuses = Object.fromEntries(out.report.map(r => [r.tab, r.status]));
    assert.equal(statuses.Employees, 'copied 2 rows');
    assert.equal(statuses.Access, 'copied 1 rows');
    assert.equal(statuses.Devices, 'copied 1 rows');
    assert.equal(statuses.Import_Issues, undefined, 'import issues are not copied');

    const [emp] = await env.db.query("SELECT COUNT(*) AS n FROM employees");
    assert.equal(Number(emp.n), 2);
    const acc = await env.db.query("SELECT email_key FROM access_users");
    assert.equal(acc[0].email_key, 'admin@gmail.com', 'the access key is the normalised email');

    const dir = (await env.db.query("SELECT * FROM directory WHERE emp_code='EMP001'"))[0];
    assert.ok(dir.pan_enc.startsWith('v1:'));
    assert.equal(decryptField(dir.pan_enc, parseDataKey(KEY)), 'ABCDE1234F');
    assert.equal(decryptField(dir.aadhaar_enc, parseDataKey(KEY)), '234567890123');
    assert.equal(decryptField(dir.account_no_enc, parseDataKey(KEY)), '123456789012');
    assert.equal(dir.bank_name, 'HDFC Bank');

    const cfg = await env.db.query("SELECT config_value FROM app_config WHERE config_key='per_head_calls'");
    assert.equal(Number(cfg[0].config_value), 250);
    const tgt = await env.db.query("SELECT target_amount FROM targets");
    assert.equal(Number(tgt[0].target_amount), 1600000);

    const after = await Promise.all(['Employees', 'Directory', 'Cases'].map(t => env.api.grid(OLD, t)));
    assert.deepEqual(after, beforeGrids, 'the old spreadsheet is not changed');
  } finally { await env.close(); }
});

test('migration: accepts the key as stored in .env (base64 text), as the script passes it', async () => {
  const env = await makeEnv({ seed: false });
  try {
    env.api.addBook(OLD, oldBook());
    await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: KEY, apply: true });
    const dir = (await env.db.query("SELECT pan_enc FROM directory WHERE emp_code='EMP001'"))[0];
    assert.equal(decryptField(dir.pan_enc, parseDataKey(KEY)), 'ABCDE1234F');
  } finally { await env.close(); }
});

test('migration: running it again never overwrites or duplicates', async () => {
  const env = await makeEnv({ seed: false });
  try {
    env.api.addBook(OLD, oldBook());
    const key = parseDataKey(KEY);
    await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: key, apply: true });
    // the team now edits in the app: change a value in the database
    await env.db.query("UPDATE employees SET name='Rahul V.' WHERE emp_code='EMP001'");
    const again = await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: key, apply: true });
    assert.match(again.report.find(r => r.tab === 'Employees').status, /skipped: table already has 2 rows/);
    const [row] = await env.db.query("SELECT name FROM employees WHERE emp_code='EMP001'");
    assert.equal(row.name, 'Rahul V.', 'newer data in the database is kept');
  } finally { await env.close(); }
});

test('migration: a missing old tab is reported and skipped, not an error', async () => {
  const env = await makeEnv({ seed: false });
  try {
    env.api.addBook(OLD, oldBook({ withDevices: false }));
    const out = await migrateFromSheets({ api: env.api, ssId: OLD, db: env.db, dataKey: parseDataKey(KEY), apply: true });
    assert.equal(out.report.find(r => r.tab === 'Devices').status, 'tab not found, skipped');
    assert.equal(out.report.find(r => r.tab === 'Employees').status, 'copied 2 rows');
  } finally { await env.close(); }
});
