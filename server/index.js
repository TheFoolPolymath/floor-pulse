#!/usr/bin/env node
'use strict';
/* Starts Floor Pulse: the website and the API on one port, plus the background timers. */
const http = require('http');
const { loadConfig, configProblems } = require('./config');
const { openDb } = require('./db');
const { GoogleSheetsApi } = require('./sheets');
const { createContext } = require('./context');
const { createHandler } = require('./app');
const { startJobs } = require('./jobs');

const cfg = loadConfig();
const problems = configProblems(cfg);
problems.warnings.forEach(w => console.warn('WARNING: ' + w));
if (problems.errors.length) {
  problems.errors.forEach(e => console.error('ERROR: ' + e));
  console.error('Fix the settings in .env (see .env.example) and start again.');
  process.exit(1);
}

const log = (m) => console.error(new Date().toISOString() + ' ' + m);
const db = openDb(Object.assign({ kind: 'mysql' }, cfg.db));
const api = cfg.serviceAccount ? new GoogleSheetsApi({ serviceAccount: cfg.serviceAccount }) : null;
const ctx = createContext({ cfg, db, api, log });

const server = http.createServer(createHandler(ctx));
server.listen(cfg.port, () => console.log('Floor Pulse is running on port ' + cfg.port + '.'));
startJobs(ctx);

function shutdown() {
  server.close(() => { db.close().finally(() => process.exit(0)); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
