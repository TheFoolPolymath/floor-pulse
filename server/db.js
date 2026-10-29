'use strict';
/*
 * One small interface for the database, so the rest of the app never cares which driver is used:
 *   db.query(sql, params)  -> rows (array of plain objects)
 *   db.tx(async (t) => …)  -> runs the function inside a transaction; t.query works like db.query
 *   db.close()
 * Production: mysql2 against TiDB or MySQL (TLS on by default).
 * Tests: Node's built-in SQLite, so the real SQL runs without a database server.
 * Write SQL that both understand: no dialect-only functions, no "VALUES ?" bulk syntax (use insertMany).
 */

const { fail } = require('./util');

function mysqlDb(opts) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: opts.host, port: opts.port, user: opts.user, password: opts.password, database: opts.database,
    ssl: opts.ssl ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    waitForConnections: true, connectionLimit: 8, queueLimit: 0,
    dateStrings: true,        // DATE and DATETIME come back as yyyy-mm-dd text, the same as the rest of the app uses
    decimalNumbers: true      // DECIMAL comes back as a JavaScript number
  });
  const rowsOf = (r) => (Array.isArray(r) ? r : []);
  return {
    kind: 'mysql',
    async query(sql, params = []) { const [r] = await pool.query(sql, params); return rowsOf(r); },
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const t = { query: async (sql, params = []) => { const [r] = await conn.query(sql, params); return rowsOf(r); } };
        const out = await fn(t);
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch (x) { /* the original error matters more */ }
        throw e;
      } finally { conn.release(); }
    },
    async close() { await pool.end(); }
  };
}

function sqliteDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file);
  d.exec('PRAGMA foreign_keys = ON');
  const run = (sql, params) => {
    const clean = params.map(v => (v === undefined ? null : v));
    const st = d.prepare(sql);
    if (/^\s*(select|with|pragma)/i.test(sql)) return st.all(...clean);
    st.run(...clean);
    return [];
  };
  return {
    kind: 'sqlite',
    async query(sql, params = []) { return run(sql, params); },
    async tx(fn) {
      d.exec('BEGIN');
      try {
        const out = await fn({ query: async (sql, params = []) => run(sql, params) });
        d.exec('COMMIT');
        return out;
      } catch (e) { d.exec('ROLLBACK'); throw e; }
    },
    async close() { d.close(); }
  };
}

function openDb(cfg) {
  if (cfg.kind === 'sqlite') return sqliteDb(cfg.file);
  if (!cfg.host || !cfg.user || !cfg.database) throw fail('config', 'The database is not set.');
  return mysqlDb(cfg);
}

/** Splits a .sql file into single statements. Full-line comments are removed first. */
function splitSql(sql) {
  return sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
    .split(/;[ \t]*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
}

/** Applies schema.sql. Safe to run again: tables use IF NOT EXISTS and "already exists" errors are skipped. */
async function migrate(db, sql) {
  const done = [];
  for (let st of splitSql(sql)) {
    if (db.kind === 'sqlite') st = st.replace(/INT AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    try {
      await db.query(st);
      done.push(st.split('\n')[0].slice(0, 70));
    } catch (e) {
      const text = String(e.code || '') + ' ' + String(e.message || '');
      if (/already exists|Duplicate key name|ER_DUP_KEYNAME|ER_TABLE_EXISTS/i.test(text)) continue;
      throw e;
    }
  }
  return done;
}

/**
 * Multi-row insert in chunks. verb is INSERT or REPLACE (REPLACE = upsert by primary key, works on both drivers).
 * `rows` is an array of arrays in the same order as `cols`.
 */
async function insertMany(q, table, cols, rows, verb = 'INSERT') {
  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const one = '(' + cols.map(() => '?').join(',') + ')';
    const sql = verb + ' INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + part.map(() => one).join(',');
    await q.query(sql, part.flat().map(v => (v === undefined ? null : v)));
  }
}

module.exports = { openDb, migrate, insertMany, splitSql };
