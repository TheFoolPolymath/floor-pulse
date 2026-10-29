#!/usr/bin/env node
'use strict';
/* Checks the settings, the database connection and the Google sheets before going live. Usage: npm run check */
const { loadDotEnv } = require('./_common');
loadDotEnv();
const { loadConfig, configProblems } = require('../server/config');
const { openDb } = require('../server/db');
const { GoogleSheetsApi, TAB_SPECS } = require('../server/sheets');

(async () => {
  let failed = false;
  const cfg = loadConfig();
  const p = configProblems(cfg);
  p.errors.forEach(e => { failed = true; console.error('FAIL  ' + e); });
  p.warnings.forEach(w => console.warn('WARN  ' + w));

  if (cfg.db) {
    const db = openDb(Object.assign({ kind: 'mysql' }, cfg.db));
    try {
      await db.query('SELECT 1');
      console.log('OK    database reachable');
    } catch (e) { failed = true; console.error('FAIL  database: ' + e.message); }
    finally { await db.close(); }
  }

  if (cfg.serviceAccount && cfg.sheetId) {
    const api = new GoogleSheetsApi({ serviceAccount: cfg.serviceAccount });
    try {
      const titles = (await api.titles(cfg.sheetId)).map(t => t.title);
      console.log('OK    sheet reachable (' + titles.length + ' tabs)');
      const missing = TAB_SPECS.map(s => s.name).filter(n => titles.indexOf(n) < 0);
      if (missing.length) console.warn('WARN  missing tabs (run npm run setup:sheets): ' + missing.join(', '));
    } catch (e) {
      failed = true;
      console.error('FAIL  sheet: ' + e.message + '. Share the sheet with ' + cfg.serviceAccount.client_email + ' as Editor.');
    }
  }
  console.log(failed ? '\nNot ready. Fix the FAIL lines above.' : '\nReady.');
  process.exitCode = failed ? 1 : 0;
})();
