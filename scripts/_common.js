'use strict';
/* Shared start-up for the command-line scripts: loads .env and opens the database and Google connection. */
const fs = require('fs');
const path = require('path');

/** Loads .env from the project folder into process.env (no extra package needed). Existing variables win. */
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

module.exports = { loadDotEnv };
