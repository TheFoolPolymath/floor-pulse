/**
 * A tiny pretend Google Apps Script, so Code.gs can be tested on a normal computer.
 * Used by tools/test-code-gs.js. Not needed to run the app.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function makeServer(opts = {}) {
  const NOW = { t: new Date(opts.now || '2026-10-27T10:30:00+05:30').getTime() };
  const logs = [], triggers = [], registry = {}, props = {}, tokens = {};
  const empty = v => v === '' || v === undefined || v === null;

  class Range {
    constructor(sh, r, c, nr, nc) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > sh.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      Object.assign(this, { sh, r, c, nr, nc });
    }
    getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = this.sh.get(this.r + i, this.c + j); row.push(v === undefined ? '' : v); } o.push(row); } return o; }
    getDisplayValues() { return this.getValues().map(row => row.map(v => v instanceof Date ? (v.getUTCFullYear() < 1950 ? 'TIME' : v.toISOString().slice(0, 10)) : String(v))); }
    setValues(a) { if (a.length !== this.nr || a[0].length !== this.nc) throw new Error('Dimensions mismatch ' + a.length + 'x' + a[0].length + ' vs ' + this.nr + 'x' + this.nc); a.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
    setValue(v) { this.sh.set(this.r, this.c, v); return this; }
    setFormula(v) { this.sh.set(this.r, this.c, v); return this; }
  }
  ['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat', 'setDataValidation', 'setFontSize', 'setWrap', 'setVerticalAlignment', 'setNote'].forEach(m => { Range.prototype[m] = function () { return this; }; });

  class Sheet {
    constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.validations = 0; }
    get(r, c) { return this.cells[r - 1] && this.cells[r - 1][c - 1]; }
    set(r, c, v) { while (this.cells.length < r) this.cells.push([]); const row = this.cells[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(a, n) { this.maxRows += n; }
    getLastRow() { for (let r = this.cells.length; r >= 1; r--) if (this.cells[r - 1].some(v => !empty(v))) return r; return 0; }
    getLastColumn() { let m = 0; this.cells.forEach(row => row.forEach((v, i) => { if (!empty(v)) m = Math.max(m, i + 1); })); return m; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    setFrozenRows() {} setColumnWidth() {}
    clear() { this.cells = []; }
    deleteRows(s, n) { this.cells.splice(s - 1, n); }
    deleteRow(r) { this.cells.splice(r - 1, 1); }
  }
  class Spreadsheet {
    constructor(name) { this.name = name; this.id = 'sheet-' + Object.keys(registry).length; this.sheets = [new Sheet('Sheet1')]; registry[this.id] = this; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n, idx) { const s = new Sheet(n); if (idx === undefined) this.sheets.push(s); else this.sheets.splice(idx, 0, s); return s; }
    getSheets() { return this.sheets; }
    deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
    setActiveSheet() {} setSpreadsheetTimeZone(z) { this.tz = z; } getSpreadsheetTimeZone() { return this.tz || 'Asia/Kolkata'; }
    getId() { return this.id; } getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getName() { return this.name; } rename(n) { this.name = n; }
  }

  class FDate extends Date {
    constructor(...a) { if (a.length === 0) super(NOW.t); else super(...a); }
    static now() { return NOW.t; }
  }
  Object.defineProperty(FDate, Symbol.hasInstance, { value: o => o instanceof Date });   // real Date cells must count as dates inside the sandbox
  const ist = d => { const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).forEach(x => { p[x.type] = x.value; }); return p; };

  const sandbox = {
    console, Date: FDate, Math, JSON, Number, String, Object, Array, RegExp, Error, isFinite, Intl, parseInt,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: {
      create: n => new Spreadsheet(n),
      openById: id => { if (!registry[id]) throw new Error('No such sheet'); return registry[id]; },
      getActiveSpreadsheet: () => { throw new Error('No active spreadsheet'); },
      newDataValidation: () => { const b = { requireValueInList: () => b, requireValueInRange: () => b, setAllowInvalid: () => b, build: () => ({}) }; return b; }
    },
    Session: { getActiveUser: () => ({ getEmail: () => opts.owner || 'owner@gmail.com' }), getEffectiveUser: () => ({ getEmail: () => opts.owner || 'owner@gmail.com' }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: (...a) => logs.push(a.join(' ')) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.h, id: t })),
      deleteTrigger: t => { const i = triggers.indexOf(t.id); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: h => { const t = { h }; const b = { timeBased: () => b, everyMinutes: () => b, everyDays: () => b, atHour: () => b, create: () => { triggers.push(t); } }; return b; },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' })
    },
    UrlFetchApp: {
      fetch: url => {
        const tok = decodeURIComponent(url.split('id_token=')[1] || ''), info = tokens[tok];
        return info ? { getResponseCode: () => 200, getContentText: () => JSON.stringify(info) } : { getResponseCode: () => 400, getContentText: () => '{"error":"invalid_token"}' };
      }
    },
    Utilities: {
      formatDate: (d, tz, f) => { const p = ist(d); if (f === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day; if (f === 'yyyy-MM') return p.year + '-' + p.month; if (f === 'yyyy-MM-dd HH:mm') return p.year + '-' + p.month + '-' + p.day + ' ' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute; if (f === 'HH:mm') return (p.hour === '24' ? '00' : p.hour) + ':' + p.minute; if (f === 'u') return String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1); throw new Error('fmt ' + f); },
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: x => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      computeHmacSha256Signature: (m, k) => crypto.createHmac('sha256', k).update(m).digest(),
      newBlob: b => ({ getDataAsString: () => Buffer.from(b).toString('utf8') })
    }
  };
  vm.createContext(sandbox);
  ['Code.gs', 'BackendSync.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), sandbox));

  const call = body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return {
    sandbox, call, logs, triggers, registry, props, NOW,
    run: fn => vm.runInContext(fn, sandbox),
    setNow: s => { NOW.t = new Date(s).getTime(); },
    /** register a pretend Google sign-in for an email; returns the id_token string to send */
    googleToken(email, extra = {}) {
      const t = 'gtok-' + email + '-' + Math.random().toString(36).slice(2);
      tokens[t] = Object.assign({ aud: sandbox.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com', email_verified: 'true', exp: String(Math.floor(NOW.t / 1000) + 3600), email, name: email.split('@')[0] }, extra);
      return t;
    },
    sheet: (n) => registry[props.SHEET_ID].getSheetByName(n)
  };
}
module.exports = { makeServer };
