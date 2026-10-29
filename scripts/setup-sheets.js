#!/usr/bin/env node
'use strict';
/* Creates the four sheet tabs the app still uses (and adds any missing columns). Usage: npm run setup:sheets */
const { loadDotEnv } = require('./_common');
loadDotEnv();
const { loadConfig } = require('../server/config');
const { GoogleSheetsApi, ensureTabs } = require('../server/sheets');

(async () => {
  const cfg = loadConfig();
  if (!cfg.serviceAccount) { console.error('Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE in .env first.'); process.exit(1); }
  if (!cfg.sheetId) { console.error('Set SHEET_ID in .env first.'); process.exit(1); }
  const api = new GoogleSheetsApi({ serviceAccount: cfg.serviceAccount });
  const report = await ensureTabs(api, cfg.sheetId);
  (Array.isArray(report) ? report : []).forEach(line => console.log(line));
  console.log('Sheet tabs are ready.');
})().catch(e => { console.error('Setup failed: ' + e.message); process.exit(1); });
