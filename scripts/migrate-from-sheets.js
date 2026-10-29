#!/usr/bin/env node
'use strict';
/*
 * Copies the database tabs from the OLD spreadsheet into the database. Run once, after npm run db:migrate.
 *   npm run migrate:sheets            dry run: shows what would be copied, changes nothing
 *   npm run migrate:sheets -- --apply copies it
 * The old spreadsheet is never changed. Tables that already have rows are skipped.
 */
const { loadDotEnv } = require('./_common');
loadDotEnv();
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { GoogleSheetsApi } = require('../server/sheets');
const { migrateFromSheets } = require('../server/migrate-sheets');

(async () => {
  const apply = process.argv.includes('--apply');
  const cfg = loadConfig();
  if (!cfg.serviceAccount || !cfg.sheetId) { console.error('SHEET_ID and the service account must be set in .env.'); process.exit(1); }
  if (!cfg.db) { console.error('DATABASE_URL must be set in .env.'); process.exit(1); }
  if (apply && !cfg.dataKey) { console.error('DATA_KEY must be set before copying the directory. Back up the key somewhere safe.'); process.exit(1); }
  const api = new GoogleSheetsApi({ serviceAccount: cfg.serviceAccount });
  const db = openDb(Object.assign({ kind: 'mysql' }, cfg.db));
  try {
    const out = await migrateFromSheets({ api, ssId: cfg.sheetId, db, dataKey: cfg.dataKey, apply });
    console.log(apply ? 'Copy finished:' : 'Dry run (nothing changed):');
    out.report.forEach(r => console.log('  ' + r.tab.padEnd(14) + ' -> ' + r.table.padEnd(13) + ' ' + r.status));
    if (!apply) console.log('\nRun again with -- --apply to copy.');
  } catch (e) {
    console.error('Copy failed and was rolled back: ' + e.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
