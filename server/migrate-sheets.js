'use strict';
/*
 * One-time copy of the database tabs from the OLD spreadsheet into the database.
 *  - Read-only on the spreadsheet. The old tabs are never changed or deleted.
 *  - Only fills a table that is still EMPTY. A table that already has rows is skipped, so running it
 *    again can never overwrite newer data.
 *  - Directory PAN, Aadhaar and account number are encrypted with DATA_KEY on the way in.
 *  - Attendance, KPI_MIS, Calls_MIS, Efficiency_Log and Audit_Log stay in the sheet and are not copied.
 *  - Import_Issues is not copied: it is rebuilt by every backend sync.
 */
const { str, num, dateOrEmpty, normEmail } = require('./util');
const { encryptField, parseDataKey } = require('./security');
const { insertMany } = require('./db');

const nullDate = (v) => dateOrEmpty(v) || null;

/** For each old tab: the new table, how to turn a row into table columns, and whether the table is keyed by an auto id. */
const PLAN = [
  { tab: 'Employees', table: 'employees', cols: ['emp_code', 'name', 'team_id', 'team_name', 'leader_code', 'role', 'status', 'join_date', 'exit_date'],
    map: (o) => [str(o.emp_code), str(o.name), str(o.team_id), str(o.team_name), str(o.leader_code), str(o.role).toUpperCase(), str(o.status).toUpperCase() || 'ACTIVE', nullDate(o.join_date), nullDate(o.exit_date)] },
  { tab: 'Access', table: 'access_users', cols: ['email_key', 'email', 'name', 'role', 'team_id', 'status', 'added_on'],
    map: (o) => [normEmail(o.email), str(o.email), str(o.name), str(o.role).toUpperCase(), str(o.team_id), str(o.status).toUpperCase() || 'ACTIVE', nullDate(o.added_on)] },
  { tab: 'Config', table: 'app_config', cols: ['config_key', 'config_value', 'note'],
    map: (o) => [str(o.key), num(o.value), str(o.note)], skipRow: (o) => !str(o.key) || !isFinite(Number(o.value)) },
  { tab: 'Name_Map', table: 'name_map', cols: ['tc_name', 'tl_name', 'emp_code'], autoId: true,
    map: (o) => [str(o.tc_name), str(o.tl_name), str(o.emp_code).toUpperCase()] },
  { tab: 'Directory', table: 'directory', dirFields: true,
    cols: ['emp_code', 'full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'pan_enc', 'aadhaar_enc', 'bank_name', 'account_holder', 'account_no_enc', 'ifsc', 'bank_branch', 'designation', 'salary', 'updated_on', 'updated_by'],
    map: (o, key) => [str(o.emp_code), str(o.full_name), nullDate(o.dob), str(o.gender), str(o.marital_status), str(o.blood_group), str(o.father_name), str(o.mother_name), str(o.emergency_name), str(o.emergency_phone), str(o.address), str(o.mobile), str(o.email),
      encryptField(o.pan, key), encryptField(o.aadhaar, key), str(o.bank_name), str(o.account_holder), encryptField(o.account_no, key), str(o.ifsc), str(o.bank_branch), str(o.designation), str(o.salary) === '' ? null : num(o.salary), nullDate(o.updated_on), str(o.updated_by)] },
  { tab: 'Targets', table: 'targets', cols: ['scope', 'target_id', 'target_month', 'target_amount', 'set_by', 'set_on'],
    map: (o) => [str(o.scope).toUpperCase(), str(o.id), str(o.month), num(o.target_amount), str(o.set_by), nullDate(o.set_on)] },
  { tab: 'Remarks', table: 'remarks', cols: ['remark_id', 'remark_date', 'emp_code', 'category', 'note', 'given_by', 'created_at', 'status'],
    map: (o) => [str(o.remark_id), nullDate(o.date), str(o.emp_code), str(o.category), str(o.note), str(o.given_by), str(o.created_at), str(o.status) || 'ACTIVE'] },
  { tab: 'Cases', table: 'cases', cols: ['case_id', 'case_date', 'emp_code', 'customer', 'bank', 'product', 'amount', 'stage', 'stage_date', 'updated_by', 'source', 'rm', 'location', 'reason'],
    map: (o) => [str(o.case_id), nullDate(o.date), str(o.emp_code), str(o.customer), str(o.bank), str(o.product), num(o.amount), str(o.stage).toUpperCase(), nullDate(o.stage_date), str(o.updated_by), str(o.source) || 'APP', str(o.rm), str(o.location), str(o.reason)] },
  { tab: 'Case_Notes', table: 'case_notes', cols: ['case_id', 'note_at', 'by_name', 'note'], autoId: true,
    map: (o) => [str(o.case_id), str(o.date), str(o.by), str(o.note)] },
  { tab: 'Devices', table: 'devices', cols: ['device_id', 'email_key', 'email', 'name', 'role', 'device', 'mode', 'platform', 'first_seen', 'last_seen', 'sign_ins'],
    map: (o) => [str(o.device_id), normEmail(o.email), str(o.email), str(o.name), str(o.role), str(o.device), str(o.mode), str(o.platform), str(o.first_seen), str(o.last_seen), num(o.sign_ins)] }
];

/** Reads a tab as objects keyed by its header row. A missing tab gives []. */
async function readTab(api, ssId, tab) {
  const titles = (await api.titles(ssId)).map(t => t.title);
  if (titles.indexOf(tab) < 0) return null;
  const grid = await api.grid(ssId, tab);
  if (!grid.length) return [];
  const head = grid[0].map(str);
  return grid.slice(1)
    .filter(r => r.some(c => str(c) !== ''))
    .map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

/**
 * Plans (and, with apply: true, performs) the copy. Returns one report line per old tab.
 * @param {object} p { api, ssId, db, dataKey, apply }
 */
async function migrateFromSheets({ api, ssId, db, dataKey, apply = false }) {
  const key = typeof dataKey === 'string' ? (dataKey ? parseDataKey(dataKey) : null) : dataKey;   // config holds base64
  const report = [];
  const pending = [];

  for (const step of PLAN) {
    const objs = await readTab(api, ssId, step.tab);
    if (objs === null) { report.push({ tab: step.tab, table: step.table, status: 'tab not found, skipped', rows: 0 }); continue; }
    const rows = [];
    for (const o of objs) {
      if (step.skipRow && step.skipRow(o)) continue;
      const row = step.map(o, key);
      rows.push(row);
    }
    pending.push({ step, rows });
    report.push({ tab: step.tab, table: step.table, status: 'ready', rows: rows.length });
  }

  if (!apply) {
    for (const line of report) if (line.status === 'ready') line.status = 'would copy ' + line.rows + ' rows';
    return { apply: false, report };
  }

  await db.tx(async (t) => {
    for (const { step, rows } of pending) {
      const line = report.find(r => r.tab === step.tab);
      const [{ n }] = await t.query('SELECT COUNT(*) AS n FROM ' + step.table);
      if (Number(n) > 0) { line.status = 'skipped: table already has ' + n + ' rows'; continue; }
      if (!rows.length) { line.status = 'nothing to copy'; continue; }
      await insertMany(t, step.table, step.cols, rows, 'INSERT');
      line.status = 'copied ' + rows.length + ' rows';
    }
  });
  return { apply: true, report };
}

module.exports = { migrateFromSheets, readTab, PLAN };
