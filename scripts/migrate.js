#!/usr/bin/env node
'use strict';
/* Creates or updates the database tables (safe to run again). Usage: npm run db:migrate */
const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('./_common');
loadDotEnv();
const { loadConfig, configProblems } = require('../server/config');
const { openDb, migrate } = require('../server/db');

(async () => {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (!cfg.db) { console.error('DATABASE_URL is not set in .env. See .env.example.'); process.exit(1); }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const db = openDb(Object.assign({ kind: 'mysql' }, cfg.db));
  try {
    await migrate(db, sql);
    const tables = await db.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()").catch(() => []);
    console.log('Database is up to date.' + (tables.length ? ' Tables: ' + tables.map(r => r.t || r.TABLE_NAME).join(', ') : ''));
    problems.warnings.forEach(w => console.warn('WARNING: ' + w));
  } catch (e) {
    console.error('Migration failed: ' + e.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
