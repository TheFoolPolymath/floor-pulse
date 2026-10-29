'use strict';
/* Test helpers: a real HTTP server backed by SQLite (in memory) and in-memory sheets, with a fake Google sign-in. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../server/config');
const { openDb, migrate } = require('../server/db');
const { MemorySheetsApi, TAB_SPECS } = require('../server/sheets');
const { createContext } = require('../server/context');
const { createHandler } = require('../server/app');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const SHEET_ID = 'FP_SHEET_TEST';
const BACKEND_ID = 'BACKEND_SHEET_TEST';
const KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'test-secret-'.repeat(4);
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

/** Team leaders and telecallers used across the tests. Team T1 = Alpha (Asha Rao), T2 = Bravo (Bharat Shah). */
const EMPLOYEES = [
  ['TL01', 'Asha Rao', 'T1', 'Alpha', '', 'TL', 'ACTIVE', '2025-02-01', ''],
  ['TL02', 'Bharat Shah', 'T2', 'Bravo', '', 'TL', 'ACTIVE', '2025-02-01', ''],
  ['EMP001', 'Rahul Verma', 'T1', 'Alpha', 'TL01', 'TELECALLER', 'ACTIVE', '2025-03-01', ''],
  ['EMP002', 'Sana Khan', 'T1', 'Alpha', 'TL01', 'TELECALLER', 'ACTIVE', '2025-03-01', ''],
  ['EMP003', 'Karan Mehta', 'T2', 'Bravo', 'TL02', 'TELECALLER', 'ACTIVE', '2025-03-01', ''],
  ['EMP004', 'Divya Iyer', 'T2', 'Bravo', 'TL02', 'TELECALLER', 'LEFT', '2025-03-01', '2026-10-01']
];
const ACCESS = [
  ['admin@gmail.com', 'Admin', 'ADMIN', '', 'ACTIVE', '2025-01-01'],
  ['asha@gmail.com', 'Asha Rao', 'TL', 'T1', 'ACTIVE', '2025-02-01'],
  ['bharat@example.com', 'Bharat Shah', 'TL', 'T2', 'ACTIVE', '2025-02-01']
];

function sheetRows(today) {
  const att = [], kpi = [], calls = [];
  // two working days so the views have history; today is partly done
  const days = [addDay(today, -1), today];
  days.forEach((d) => {
    ['EMP001', 'EMP002', 'EMP003'].forEach((c, i) => {
      att.push([d, c, i === 1 && d === today ? 'A' : 'P', '10:0' + i]);
      if (i === 1 && d === today) return;
      kpi.push([d, c, 3 + i, 1, 1, 1, i === 0 ? 1 : 0, i === 0 ? 150000 : 0, 1, 'SHEET']);
      calls.push([d, c, 120 + i * 30, 50 + i * 10, 2000 + i * 900]);
    });
  });
  return { att, kpi, calls };
}
function addDay(ymd, n) { return new Date(Date.parse(ymd + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }

/** Seeds the database with the employees, access rows, and default config. */
async function seedDb(db) {
  for (const e of EMPLOYEES) {
    await db.query('INSERT INTO employees (emp_code, name, team_id, team_name, leader_code, role, status, join_date, exit_date) VALUES (?,?,?,?,?,?,?,?,?)', [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8] || null]);
  }
  for (const a of ACCESS) {
    await db.query('INSERT INTO access_users (email_key, email, name, role, team_id, status, added_on) VALUES (?,?,?,?,?,?,?)', [require('../server/util').normEmail(a[0]), a[0], a[1], a[2], a[3], a[4], a[5]]);
  }
  const cfgRows = [['per_head_logins', 2, ''], ['per_head_calls', 250, ''], ['connect_benchmark', 0.4, ''], ['disb_benchmark', 0.3, ''], ['shift_start_min', 600, ''], ['shift_end_min', 1140, ''], ['stuck_days', 3, '']];
  for (const r of cfgRows) await db.query('INSERT INTO app_config (config_key, config_value, note) VALUES (?,?,?)', r);
}

function fakeGoogle() {
  // id_token format used by the tests: "good:<email>:<name>"; anything else is refused by Google
  return async (url) => {
    const m = String(url).match(/id_token=([^&]+)/);
    const tok = m ? decodeURIComponent(m[1]) : '';
    const p = tok.split(':');
    const ok = p[0] === 'good' && p.length >= 2;
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { aud: CLIENT_ID, iss: 'https://accounts.google.com', email: p[1], email_verified: 'true', name: p[2] || p[1], exp: String(Math.floor(Date.now() / 1000) + 600) } : { error: 'invalid_token' }) };
  };
}

/**
 * A complete app for one test: SQLite database, memory sheets, fixed clock.
 * `today` is the India date the tests work on. The clock is 14:40 IST on that date, inside the shift.
 */
async function makeEnv({ today = '2026-10-29', hour = '14:40', backend = false, seed = true, extraCfg = {} } = {}) {
  const db = await openDb({ kind: 'sqlite', file: ':memory:' });
  await migrate(db, SCHEMA);
  if (seed) await seedDb(db);
  const cfg = loadConfig(Object.assign({
    SESSION_SECRET: SECRET, DATA_KEY: KEY, GOOGLE_CLIENT_ID: CLIENT_ID, SHEET_ID, BRANCH_NAME: 'Test Branch',
    DATABASE_URL: 'mysql://u:p@localhost:3306/test', DB_SSL: 'false'
  }, extraCfg, backend ? { BACKEND_SHEET_ID: BACKEND_ID } : {}));
  cfg.serveStatic = false;
  cfg.syncDays = 60;
  const api = new MemorySheetsApi();
  const rows = sheetRows(today);
  const byName = { Attendance: rows.att, KPI_MIS: rows.kpi, Calls_MIS: rows.calls, Efficiency_Log: [], Audit_Log: [] };
  const tabs = {};
  TAB_SPECS.forEach((s) => { tabs[s.name] = [s.cols].concat(byName[s.name] || []); });
  api.addBook(SHEET_ID, tabs);
  const clockMs = Date.parse(today + 'T' + hour + ':00+05:30');
  let clock = clockMs;
  const ctx = createContext({ cfg, db, api, now: () => new Date(clock), fetch: fakeGoogle(), log: () => {} });
  ctx.tick = (ms) => { clock += ms; };
  ctx.setClock = (ms) => { clock = ms; };
  ctx.cfg.backendSheetId = backend ? BACKEND_ID : '';
  const handler = createHandler(ctx);
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    ctx, db, api, base,
    async call(body) {
      const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      return r.json();
    },
    async signIn(email, name) {
      const out = await this.call({ action: 'login', id_token: 'good:' + email + ':' + (name || email) });
      if (out.error) throw new Error('sign-in failed for ' + email + ': ' + out.message);
      return out.token;
    },
    async close() { server.close(); await db.close(); }
  };
}

module.exports = { makeEnv, SHEET_ID, BACKEND_ID, KEY, SECRET, CLIENT_ID, EMPLOYEES, ACCESS, SCHEMA, addDay };
