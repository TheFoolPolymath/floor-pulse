'use strict';
/*
 * All SQL for the tables in db/schema.sql. Every function takes `q` first: the database or a transaction.
 * Rows come back with the same field names the rest of the app uses (for example case_date is returned as `date`).
 */
const { encryptField, decryptField, parseDataKey } = require('./security');
const { insertMany } = require('./db');
const { str, num, normEmail, dateOrEmpty, clean } = require('./util');

const DIR_SENSITIVE = { pan: 'pan_enc', aadhaar: 'aadhaar_enc', account_no: 'account_no_enc' };
const DIR_PLAIN = ['full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'account_holder', 'ifsc', 'bank_name', 'bank_branch', 'designation', 'salary'];
const DIR_FIELDS = ['full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'pan', 'aadhaar', 'bank_name', 'account_holder', 'account_no', 'ifsc', 'bank_branch', 'designation', 'salary'];

function makeRepo({ dataKey }) {
  const key = typeof dataKey === 'string' ? parseDataKey(dataKey) : dataKey;

  return {
    /* ---------------- employees ---------------- */
    async employees(q) {
      const rows = await q.query('SELECT emp_code, name, team_id, team_name, leader_code, role, status, join_date, exit_date FROM employees ORDER BY team_id, emp_code');
      return rows.map(r => ({ emp_code: str(r.emp_code), name: str(r.name), team_id: str(r.team_id), team_name: str(r.team_name), leader_code: str(r.leader_code), role: str(r.role), status: str(r.status), join_date: dateOrEmpty(r.join_date), exit_date: dateOrEmpty(r.exit_date) }));
    },
    async insertEmployee(q, e) {
      await q.query('INSERT INTO employees (emp_code, name, team_id, team_name, leader_code, role, status, join_date, exit_date) VALUES (?,?,?,?,?,?,?,?,?)',
        [e.emp_code, e.name, e.team_id, e.team_name || '', e.leader_code || '', e.role, e.status || 'ACTIVE', e.join_date || null, e.exit_date || null]);
    },
    async updateEmployee(q, code, f) {
      const cols = ['name', 'team_id', 'team_name', 'leader_code', 'status', 'join_date', 'exit_date'];
      const set = cols.filter(c => f[c] !== undefined);
      if (!set.length) return;
      await q.query('UPDATE employees SET ' + set.map(c => c + ' = ?').join(', ') + ' WHERE emp_code = ?',
        set.map(c => (f[c] === '' ? null : f[c])).concat([code]));
    },

    /* ---------------- access ---------------- */
    async access(q) {
      const rows = await q.query('SELECT email, email_key, name, role, team_id, status, added_on FROM access_users ORDER BY email');
      return rows.map(r => ({ email: str(r.email), email_key: str(r.email_key), name: str(r.name), role: str(r.role).toUpperCase(), team_id: str(r.team_id), status: str(r.status).toUpperCase() || 'ACTIVE', added_on: dateOrEmpty(r.added_on) }));
    },
    async accessFor(q, email) {
      const rows = await q.query('SELECT email, email_key, name, role, team_id, status, added_on FROM access_users WHERE email_key = ?', [normEmail(email)]);
      const r = rows[0];
      return r ? { email: str(r.email), email_key: str(r.email_key), name: str(r.name), role: str(r.role).toUpperCase(), team_id: str(r.team_id), status: str(r.status).toUpperCase(), added_on: dateOrEmpty(r.added_on) } : null;
    },
    async upsertAccess(q, a) {
      await q.query('DELETE FROM access_users WHERE email_key = ?', [normEmail(a.email)]);
      await q.query('INSERT INTO access_users (email_key, email, name, role, team_id, status, added_on) VALUES (?,?,?,?,?,?,?)',
        [normEmail(a.email), str(a.email).toLowerCase(), a.name || '', a.role, a.team_id || '', a.status || 'ACTIVE', a.added_on || null]);
    },
    async setAccessStatus(q, emailKey, status) {
      await q.query('UPDATE access_users SET status = ? WHERE email_key = ?', [status, emailKey]);
    },

    /* ---------------- config, name map, import problems, state ---------------- */
    async config(q) {
      const rows = await q.query('SELECT config_key, config_value, note FROM app_config ORDER BY config_key');
      return rows.map(r => ({ key: str(r.config_key), value: num(r.config_value), note: str(r.note) }));
    },
    async nameMap(q) {
      const rows = await q.query('SELECT tc_name, tl_name, emp_code FROM name_map');
      return rows.map(r => ({ tc_name: str(r.tc_name), tl_name: str(r.tl_name), emp_code: str(r.emp_code) }));
    },
    async importIssues(q) {
      const rows = await q.query('SELECT when_at, issue_type, issue_date, tc_name, tl_name, customer, detail, sheet_row FROM import_issues ORDER BY id');
      return rows.map(r => ({ when: str(r.when_at), type: str(r.issue_type), date: str(r.issue_date), tc_name: str(r.tc_name), tl_name: str(r.tl_name), customer: str(r.customer), detail: str(r.detail), sheet_row: str(r.sheet_row) }));
    },
    async replaceImportIssues(q, list) {
      await q.query('DELETE FROM import_issues');
      await insertMany(q, 'import_issues', ['when_at', 'issue_type', 'issue_date', 'tc_name', 'tl_name', 'customer', 'detail', 'sheet_row'],
        list.map(o => [o.when, o.type, o.date, o.tc_name, o.tl_name, o.customer, o.detail, o.sheet_row]));
    },
    async getState(q, k) {
      const rows = await q.query('SELECT state_value FROM app_state WHERE state_key = ?', [k]);
      return rows[0] ? str(rows[0].state_value) : '';
    },
    async setState(q, k, v) {
      await q.query('REPLACE INTO app_state (state_key, state_value) VALUES (?, ?)', [k, String(v)]);
    },

    /* ---------------- directory (sensitive fields encrypted) ---------------- */
    async directory(q) {
      const rows = await q.query('SELECT * FROM directory');
      return rows.map(r => {
        const o = { emp_code: str(r.emp_code) };
        DIR_PLAIN.forEach(k => { o[k] = r[k] == null ? '' : (k === 'dob' ? dateOrEmpty(r.dob) : r[k]); });
        o.salary = r.salary == null ? '' : num(r.salary);
        Object.keys(DIR_SENSITIVE).forEach(k => { o[k] = decryptField(r[DIR_SENSITIVE[k]], key); });
        o.updated_on = dateOrEmpty(r.updated_on);
        o.updated_by = str(r.updated_by);
        return o;
      });
    },
    /** Saves the personal details of one employee. `f` holds plain values; sensitive ones are encrypted here. */
    async saveDirectory(q, code, f, updatedOn, updatedBy) {
      const row = { emp_code: code, updated_on: updatedOn || null, updated_by: updatedBy || '' };
      DIR_PLAIN.forEach(k => { row[k] = f[k] === undefined || f[k] === '' ? (k === 'salary' || k === 'dob' ? null : '') : f[k]; });
      Object.keys(DIR_SENSITIVE).forEach(k => { row[DIR_SENSITIVE[k]] = encryptField(f[k], key); });
      const cols = ['emp_code'].concat(Object.keys(row).filter(c => c !== 'emp_code'));
      await q.query('REPLACE INTO directory (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')', cols.map(c => row[c]));
    },

    /* ---------------- targets ---------------- */
    async targets(q) {
      const rows = await q.query('SELECT scope, target_id, target_month, target_amount, set_by, set_on FROM targets');
      return rows.map(r => ({ scope: str(r.scope), id: str(r.target_id), month: str(r.target_month), target_amount: r.target_amount == null ? '' : num(r.target_amount), set_by: str(r.set_by), set_on: dateOrEmpty(r.set_on) }));
    },
    async upsertTarget(q, scope, id, month, amount, by, on) {
      await q.query('REPLACE INTO targets (scope, target_id, target_month, target_amount, set_by, set_on) VALUES (?,?,?,?,?,?)', [scope, id, month, amount, by, on]);
    },
    async deleteTarget(q, scope, id, month) {
      await q.query('DELETE FROM targets WHERE scope = ? AND target_id = ? AND target_month = ?', [scope, id, month]);
    },

    /* ---------------- remarks ---------------- */
    async remarks(q, fromDate) {
      const rows = await q.query('SELECT remark_id, remark_date, emp_code, category, note, given_by, created_at, status FROM remarks WHERE remark_date >= ?', [fromDate]);
      return rows.map(r => ({ remark_id: str(r.remark_id), date: dateOrEmpty(r.remark_date), emp_code: str(r.emp_code), category: str(r.category), note: str(r.note), given_by: str(r.given_by), created_at: str(r.created_at), status: str(r.status).toUpperCase() }));
    },
    async remarkById(q, id) {
      const rows = await q.query('SELECT remark_id FROM remarks WHERE remark_id = ?', [id]);
      return rows[0] || null;
    },
    async insertRemark(q, r) {
      await q.query('INSERT INTO remarks (remark_id, remark_date, emp_code, category, note, given_by, created_at, status) VALUES (?,?,?,?,?,?,?,?)',
        [r.remark_id, r.date, r.emp_code, r.category, r.note, r.given_by, r.created_at, 'ACTIVE']);
    },
    async voidRemark(q, id) {
      await q.query("UPDATE remarks SET status = 'VOID' WHERE remark_id = ?", [id]);
    },

    /* ---------------- cases and notes ---------------- */
    async cases(q, fromDate, toDate) {
      const rows = await q.query('SELECT case_id, case_date, emp_code, customer, bank, product, amount, stage, stage_date, updated_by, source, rm, location, reason FROM cases WHERE case_date >= ? AND case_date <= ?', [fromDate, toDate]);
      return rows.map(caseOut);
    },
    async caseById(q, id) {
      const rows = await q.query('SELECT case_id, case_date, emp_code, customer, bank, product, amount, stage, stage_date, updated_by, source, rm, location, reason FROM cases WHERE case_id = ?', [id]);
      return rows[0] ? caseOut(rows[0]) : null;
    },
    async insertCase(q, c) {
      await q.query('INSERT INTO cases (case_id, case_date, emp_code, customer, bank, product, amount, stage, stage_date, updated_by, source, rm, location, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [c.case_id, c.date, c.emp_code, c.customer, c.bank, c.product || '', c.amount || 0, c.stage, c.stage_date || c.date, c.updated_by || '', c.source || 'APP', c.rm || '', c.location || '', c.reason || '']);
    },
    async insertCases(q, list) {
      await insertMany(q, 'cases', ['case_id', 'case_date', 'emp_code', 'customer', 'bank', 'product', 'amount', 'stage', 'stage_date', 'updated_by', 'source', 'rm', 'location', 'reason'],
        list.map(c => [c.case_id, c.date, c.emp_code, c.customer, c.bank, c.product || '', c.amount || 0, c.stage, c.stage_date || c.date, c.updated_by || '', c.source || 'APP', c.rm || '', c.location || '', c.reason || '']), 'REPLACE');
    },
    async updateCaseStage(q, id, stage, stageDate, by) {
      await q.query('UPDATE cases SET stage = ?, stage_date = ?, updated_by = ? WHERE case_id = ?', [stage, stageDate, by, id]);
    },
    async deleteBackendCases(q, fromDate) {
      await q.query("DELETE FROM cases WHERE source = 'BACKEND' AND case_date >= ?", [fromDate]);
    },
    async caseNotes(q, fromDate) {
      const rows = await q.query('SELECT case_id, note_at, by_name, note FROM case_notes WHERE note_at >= ? ORDER BY note_id', [fromDate + ' 00:00']);
      return rows.map(r => ({ case_id: str(r.case_id), date: str(r.note_at), by: str(r.by_name), note: str(r.note) }));
    },
    async addCaseNote(q, caseId, at, by, note) {
      await q.query('INSERT INTO case_notes (case_id, note_at, by_name, note) VALUES (?,?,?,?)', [caseId, at, by, note]);
    },

    /* ---------------- devices ---------------- */
    async devices(q) {
      const rows = await q.query('SELECT device_id, email, name, role, device, mode, platform, first_seen, last_seen, sign_ins FROM devices ORDER BY last_seen DESC LIMIT 300');
      return rows.map(r => ({ device_id: str(r.device_id), email: str(r.email), name: str(r.name), role: str(r.role), device: str(r.device), mode: str(r.mode), platform: str(r.platform), first_seen: str(r.first_seen), last_seen: str(r.last_seen), sign_ins: num(r.sign_ins) }));
    },
    async device(q, deviceId, emailKey) {
      const rows = await q.query('SELECT device_id, email, name, role, device, mode, platform, first_seen, last_seen, sign_ins FROM devices WHERE device_id = ? AND email_key = ?', [deviceId, emailKey]);
      const r = rows[0];
      return r ? { email: str(r.email), name: str(r.name), role: str(r.role), device: str(r.device), mode: str(r.mode), platform: str(r.platform), first_seen: str(r.first_seen), last_seen: str(r.last_seen), sign_ins: num(r.sign_ins) } : null;
    },
    async saveDevice(q, deviceId, emailKey, o) {
      await q.query('REPLACE INTO devices (device_id, email_key, email, name, role, device, mode, platform, first_seen, last_seen, sign_ins) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [deviceId, emailKey, o.email, o.name, o.role, o.device, o.mode, o.platform, o.first_seen, o.last_seen, o.sign_ins]);
    }
  };
}

function caseOut(r) {
  return {
    case_id: str(r.case_id), date: dateOrEmpty(r.case_date), emp_code: str(r.emp_code), customer: str(r.customer), bank: str(r.bank),
    product: str(r.product), amount: num(r.amount), stage: str(r.stage).toUpperCase(), stage_date: dateOrEmpty(r.stage_date) || dateOrEmpty(r.case_date),
    updated_by: str(r.updated_by), source: str(r.source), rm: str(r.rm), location: str(r.location), reason: str(r.reason)
  };
}

module.exports = { makeRepo, DIR_FIELDS, DIR_SENSITIVE, caseOut, clean };
