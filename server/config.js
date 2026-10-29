'use strict';
/* Settings come from environment variables (see .env.example). Nothing is hard-coded here. */
const fs = require('fs');

function parseDatabaseUrl(u) {
  const x = new URL(u);   // mysql://user:password@host:4000/database
  return {
    host: x.hostname,
    port: Number(x.port || 4000),
    user: decodeURIComponent(x.username),
    password: decodeURIComponent(x.password),
    database: decodeURIComponent(x.pathname.replace(/^\//, ''))
  };
}

function loadConfig(env = process.env) {
  const get = (k, d) => (env[k] === undefined || env[k] === '' ? d : env[k]);

  let db;
  if (get('DATABASE_URL', '')) db = parseDatabaseUrl(get('DATABASE_URL', ''));
  else db = { host: get('DB_HOST', ''), port: Number(get('DB_PORT', 4000)), user: get('DB_USER', ''), password: get('DB_PASSWORD', ''), database: get('DB_NAME', '') };
  const local = /^(localhost|127\.0\.0\.1)$/.test(db.host);
  db.ssl = get('DB_SSL', local ? 'false' : 'true') === 'true';   // TiDB Cloud and most hosted MySQL need TLS

  let serviceAccount = null;
  if (get('GOOGLE_SERVICE_ACCOUNT_JSON', '')) serviceAccount = JSON.parse(get('GOOGLE_SERVICE_ACCOUNT_JSON', ''));
  else if (get('GOOGLE_SERVICE_ACCOUNT_FILE', '')) serviceAccount = JSON.parse(fs.readFileSync(get('GOOGLE_SERVICE_ACCOUNT_FILE', ''), 'utf8'));

  return {
    port: Number(get('PORT', 8787)),
    branch: get('BRANCH_NAME', 'Mumbai Branch'),
    googleClientId: get('GOOGLE_CLIENT_ID', ''),
    sheetId: get('SHEET_ID', ''),
    backendSheetId: get('BACKEND_SHEET_ID', ''),
    serviceAccount,
    sessionSecret: get('SESSION_SECRET', ''),
    dataKey: get('DATA_KEY', ''),
    db,
    allowedOrigins: get('ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
    serveStatic: get('SERVE_STATIC', 'true') === 'true',
    staticDir: get('STATIC_DIR', ''),
    snapshotTtlMs: Number(get('SNAPSHOT_TTL_SECONDS', 45)) * 1000,
    efficiencyEveryMin: Number(get('EFFICIENCY_EVERY_MIN', 10)),
    syncEveryMin: Number(get('SYNC_EVERY_MIN', 10)),
    // backend sheet reading (see README "Backend sheet")
    backendTabs: get('BACKEND_TABS', '').split(',').map(s => s.trim()).filter(Boolean),
    textDateOrder: get('TEXT_DATE_ORDER', 'MDY') === 'DMY' ? 'DMY' : 'MDY',   // only for dates typed as text
    countNiAsLogin: get('COUNT_NI_AS_LOGIN', 'true') === 'true',              // "Customer NI" counts as a login
    // fixed business rules (same as the Apps Script version)
    adminHistoryDays: 180,
    tlHistoryDays: 60,
    sessionDays: 7,
    caseWindowDays: 14,
    logKeepDays: 14,
    syncDays: 60,
    backfillDays: 180,
    templateRows: 5000
  };
}

/**
 * Problems with the settings. `errors` stop the server from starting; `warnings` are shown in the log
 * and on the health check (for example a missing DATA_KEY only blocks the directory screen).
 */
function configProblems(cfg) {
  const errors = [], warnings = [];
  if (!cfg.db.host || !cfg.db.user || !cfg.db.database) errors.push('The database is not set: give DATABASE_URL (or DB_HOST, DB_USER, DB_PASSWORD, DB_NAME).');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) errors.push('SESSION_SECRET must be a random string of at least 32 characters.');
  if (!cfg.googleClientId) warnings.push('GOOGLE_CLIENT_ID is not set, so nobody can sign in yet.');
  if (!cfg.sheetId) warnings.push('SHEET_ID is not set, so the attendance and logins data cannot be read.');
  if (!cfg.serviceAccount) warnings.push('The Google service account is not set (GOOGLE_SERVICE_ACCOUNT_JSON or _FILE).');
  if (cfg.dataKey) {
    if (Buffer.from(cfg.dataKey, 'base64').length !== 32) errors.push('DATA_KEY must be 32 random bytes encoded as base64 (for example: openssl rand -base64 32).');
  } else warnings.push('DATA_KEY is not set. Directory fields (PAN, Aadhaar, account number) cannot be saved without it.');
  return { errors, warnings };
}

module.exports = { loadConfig, configProblems, parseDatabaseUrl };
