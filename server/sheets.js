'use strict';
/*
 * Google Sheets, for the five tabs that stay in the spreadsheet:
 *   Attendance, KPI_MIS (logins), Calls_MIS (calls), Efficiency_Log, Audit_Log.
 *
 * Three layers:
 *   GoogleSheetsApi   plain REST calls, authenticated with the service account (no SDK needed)
 *   MemorySheetsApi   the same methods on memory, for tests
 *   SheetStore        the Floor Pulse spreadsheet: reads rows as objects, appends, and keeps a
 *                     short-lived cache of the four tables the dashboard reads on every refresh.
 */
const crypto = require('crypto');
const { str, fail, colLetter } = require('./util');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Headers and formats of the five tabs. Date columns are written as yyyy-mm-dd text. */
const TAB_SPECS = [
  { name: 'Attendance', cols: ['date', 'emp_code', 'status', 'in_time'], text: ['emp_code', 'in_time'], dates: ['date'] },
  { name: 'KPI_MIS', cols: ['date', 'emp_code', 'logins', 'approved', 'rejected', 'pending', 'disbursed', 'disbursed_amount', 'not_interested', 'source'], text: ['emp_code', 'source'], dates: ['date'] },
  { name: 'Calls_MIS', cols: ['date', 'emp_code', 'calls', 'connected', 'talk_seconds'], text: ['emp_code'], dates: ['date'] },
  { name: 'Efficiency_Log', cols: ['timestamp', 'scope', 'present', 'target_logins', 'logins', 'target_calls', 'calls', 'score'], text: ['timestamp', 'scope'], dates: [] },
  { name: 'Audit_Log', cols: ['when', 'email', 'action', 'target'], text: ['when', 'email', 'target'], dates: [] }
];

/* ---------------------------- real Google ---------------------------- */

function b64u(x) { return Buffer.from(x).toString('base64url'); }

/** A signed JWT that Google exchanges for a short-lived access token (service-account flow). */
function signServiceJwt(sa, nowSec) {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const input = head + '.' + claim;
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(sa.private_key).toString('base64url');
  return input + '.' + sig;
}

class GoogleSheetsApi {
  constructor({ serviceAccount, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
      throw fail('config', 'The Google service account is not set (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE).');
    }
    this.sa = serviceAccount;
    this.fetch = fetchImpl;
    this.now = now;
    this._tok = null;
  }

  async _token() {
    if (this._tok && this._tok.exp - 60 > this.now() / 1000) return this._tok.value;
    const nowSec = Math.floor(this.now() / 1000);
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceJwt(this.sa, nowSec) })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw fail('backend', 'Google would not give the server access to the sheets (' + (j.error_description || j.error || res.status) + ').');
    this._tok = { value: j.access_token, exp: nowSec + (Number(j.expires_in) || 3600) };
    return this._tok.value;
  }

  async _call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const token = await this._token();
      const res = await this.fetch(API + path, {
        method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const why = (j.error && j.error.message) || ('HTTP ' + res.status);
        throw fail('backend', 'Google Sheets said: ' + why);
      }
      return j;
    }
  }

  async titles(ssId) {
    const j = await this._call('GET', '/' + encodeURIComponent(ssId) + '?fields=sheets(properties(sheetId,title))');
    return (j.sheets || []).map(s => ({ sheetId: s.properties.sheetId, title: s.properties.title }));
  }
  async grid(ssId, tab, opts = {}) {
    const q = opts.unformatted
      ? 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'
      : 'valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';
    const j = await this._call('GET', '/' + encodeURIComponent(ssId) + '/values/' + encodeURIComponent(tab) + '?' + q);
    return j.values || [];
  }
  async headerRow(ssId, tab) {
    const j = await this._call('GET', '/' + encodeURIComponent(ssId) + '/values/' + encodeURIComponent(tab + '!1:1'));
    return ((j.values || [])[0] || []).map(str);
  }
  async append(ssId, tab, rows) {
    if (!rows.length) return;
    await this._call('POST', '/' + encodeURIComponent(ssId) + '/values/' + encodeURIComponent(tab) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: rows });
  }
  /** Writes rows starting at row 2 and clears any old rows that are now below them. */
  async overwrite(ssId, tab, rows, oldCount, width) {
    const base = '/' + encodeURIComponent(ssId) + '/values';
    if (rows.length) await this._call('PUT', base + '/' + encodeURIComponent(tab + '!A2') + '?valueInputOption=RAW', { values: rows });
    if (oldCount > rows.length) {
      const from = rows.length + 2, to = oldCount + 1;
      await this._call('POST', base + ':batchClear', { ranges: [tab + '!A' + from + ':' + colLetter(width) + to] });
    }
  }
  async deleteFirst(ssId, tab, n) {
    if (n <= 0) return;
    const t = (await this.titles(ssId)).find(x => x.title === tab);
    if (!t) return;
    await this._call('POST', '/' + encodeURIComponent(ssId) + ':batchUpdate', { requests: [{ deleteDimension: { range: { sheetId: t.sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + n } } }] });
  }
  async batchUpdate(ssId, requests) {
    if (requests.length) await this._call('POST', '/' + encodeURIComponent(ssId) + ':batchUpdate', { requests });
  }
  async write(ssId, a1, values) {
    await this._call('PUT', '/' + encodeURIComponent(ssId) + '/values/' + encodeURIComponent(a1) + '?valueInputOption=USER_ENTERED', { values });
  }
}

/* ---------------------------- memory (tests) ---------------------------- */

class MemorySheetsApi {
  constructor() { this.books = {}; }
  /** tabs: { name: [[header...], [row...], ...] } */
  addBook(ssId, tabs) {
    this.books[ssId] = {};
    Object.keys(tabs).forEach((name, i) => { this.books[ssId][name] = { sheetId: i + 1, grid: tabs[name].map(r => r.slice()) }; });
    return this.books[ssId];
  }
  _tab(ssId, tab) {
    const b = this.books[ssId];
    if (!b) throw fail('backend', 'Google Sheets said: The caller does not have access to the spreadsheet.');
    if (!b[tab]) throw fail('backend', 'Google Sheets said: Unable to parse range: ' + tab);
    return b[tab];
  }
  async titles(ssId) { return Object.keys(this.books[ssId] || {}).map(t => ({ sheetId: this.books[ssId][t].sheetId, title: t })); }
  async grid(ssId, tab) { return this._tab(ssId, tab).grid.map(r => r.slice()); }
  async headerRow(ssId, tab) { return ((this._tab(ssId, tab).grid[0]) || []).map(str); }
  async append(ssId, tab, rows) { const t = this._tab(ssId, tab); if (!t.grid.length) t.grid.push([]); rows.forEach(r => t.grid.push(r.slice())); }
  async overwrite(ssId, tab, rows, oldCount) {
    const t = this._tab(ssId, tab);
    t.grid = [t.grid[0] || []].concat(rows.map(r => r.slice()));
  }
  async deleteFirst(ssId, tab, n) { const t = this._tab(ssId, tab); t.grid.splice(1, n); }
  async batchUpdate(ssId, requests) { this.requests = (this.requests || []).concat([[ssId, requests]]); }
  async write(ssId, a1, values) {
    const m = a1.match(/^(.+)!([A-Z]+)(\d+)$/);
    if (!m) throw fail('backend', 'MemorySheetsApi.write supports Tab!A1 only');
    const t = this._tab(ssId, m[1]), c = m[2].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1, r = Number(m[3]) - 1;
    values.forEach((row, i) => { while (t.grid.length <= r + i) t.grid.push([]); row.forEach((v, j) => { t.grid[r + i][c + j] = v; }); });
  }
}

/* ---------------------------- the Floor Pulse spreadsheet ---------------------------- */

class SheetStore {
  constructor({ api, spreadsheetId, now = () => Date.now(), ttlMs = 45000 }) {
    this.api = api;
    this.ssId = spreadsheetId;
    this.now = now;
    this.ttlMs = ttlMs;
    this._snap = null;
    this._pending = null;
  }

  /** Every non-empty row of a tab as an object keyed by its header. */
  async objects(tab, opts) {
    const g = await this.api.grid(this.ssId, tab, opts);
    if (!g.length) return [];
    const head = g[0].map(str), out = [];
    for (let r = 1; r < g.length; r++) {
      const o = {};
      let any = false;
      head.forEach((h, c) => {
        if (!h) return;
        const v = g[r][c] === undefined ? '' : g[r][c];
        if (v !== '') any = true;
        o[h] = v;
      });
      if (any) out.push(o);
    }
    return out;
  }

  /** Adds rows at the bottom, in the column order the sheet actually has. */
  async appendObjects(tab, objs) {
    if (!objs.length) return;
    const head = await this.api.headerRow(this.ssId, tab);
    await this.api.append(this.ssId, tab, objs.map(o => head.map(h => (o[h] === undefined || o[h] === null ? '' : o[h]))));
    this.invalidate();
  }

  /** Replaces the rows of a tab (keeps the header). Used for the KPI_MIS rewrite during a sync. */
  async replaceObjects(tab, objs) {
    const head = await this.api.headerRow(this.ssId, tab);
    const g = await this.api.grid(this.ssId, tab);
    const oldCount = Math.max(0, g.length - 1);
    await this.api.overwrite(this.ssId, tab, objs.map(o => head.map(h => (o[h] === undefined || o[h] === null ? '' : o[h]))), oldCount, Math.max(head.length, 1));
    this.invalidate();
  }

  /** Attendance, KPI_MIS, Calls_MIS and Efficiency_Log, read together and cached for a short time. */
  async snapshot(force = false) {
    if (!force && this._snap && this.now() - this._snap.at < this.ttlMs) return this._snap.data;
    if (!this._pending) {
      this._pending = Promise.all([this.objects('Attendance'), this.objects('KPI_MIS'), this.objects('Calls_MIS'), this.objects('Efficiency_Log')])
        .then(([attendance, kpi, calls, efficiency]) => {
          const data = { attendance, kpi, calls, efficiency };
          this._snap = { at: this.now(), data };
          return data;
        })
        .finally(() => { this._pending = null; });
    }
    return this._pending;
  }

  invalidate() { this._snap = null; }
}

/** Creates any missing tab, adds any missing column on the right, and makes the header row bold. */
async function ensureTabs(api, ssId) {
  const titles = (await api.titles(ssId)).map(t => t.title);
  const requests = [];
  for (const spec of TAB_SPECS) {
    if (titles.indexOf(spec.name) < 0) {
      requests.push({ addSheet: { properties: { title: spec.name, gridProperties: { frozenRowCount: 1 } } } });
    }
  }
  if (requests.length) await api.batchUpdate(ssId, requests);
  const report = [];
  for (const spec of TAB_SPECS) {
    const head = await api.headerRow(ssId, spec.name);
    const missing = spec.cols.filter(c => head.indexOf(c) < 0);
    if (missing.length) {
      const start = head.length + 1;
      await api.write(ssId, spec.name + '!' + colLetter(start) + '1', [missing]);
    }
    report.push({ tab: spec.name, added: missing.length ? missing : [] });
  }
  return report;
}

module.exports = { GoogleSheetsApi, MemorySheetsApi, SheetStore, TAB_SPECS, ensureTabs, signServiceJwt };
