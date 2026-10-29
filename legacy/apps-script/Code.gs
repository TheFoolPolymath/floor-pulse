/**
 * FLOOR PULSE  -  Google Sheet + sign-in + data API (Google Apps Script)
 * ======================================================================
 * One file does everything:
 *   1. setup()          creates your Google Sheet with every tab and column (run once)
 *   2. Web app          the dashboard calls this to sign people in and fetch data
 *   3. logEfficiency()  runs every 10 minutes by itself and records the efficiency score
 *
 * HOW TO USE (full steps are in README.md):
 *   a) Go to script.google.com > New project > paste this whole file > Save.
 *   b) Paste your Google Client ID on the line marked  EDIT THIS  below.
 *   c) Pick "setup" in the function dropdown at the top > Run > approve the permissions.
 *   d) Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 *
 * Who can see what is decided by the "Access" tab in the sheet (or the Staff and access
 * page inside the app): email, role (ADMIN or TL) and team. Nobody else gets in.
 */

// ===================== EDIT THIS (3 lines) =====================
var GOOGLE_CLIENT_ID = 'PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com';
var SHEET_NAME = 'Floor Pulse Data';   // name of the Google Sheet that setup() creates
var BRANCH_NAME = 'Mumbai Branch';     // shown under the app name
// ===============================================================

var TZ = 'Asia/Kolkata';
var ADMIN_HISTORY_DAYS = 180;   // how many days of history an admin can open
var TL_HISTORY_DAYS = 60;       // how many days of history a team leader can open
var SESSION_DAYS = 7;           // how long someone stays signed in on one device
var LOG_KEEP_DAYS = 14;         // Efficiency_Log rows older than this are deleted nightly

var TABS = [
  { name: 'Employees', cols: ['emp_code', 'name', 'team_id', 'team_name', 'leader_code', 'role', 'status', 'join_date', 'exit_date'], w: [90, 170, 70, 110, 100, 100, 80, 100, 100] },
  { name: 'Access', cols: ['email', 'name', 'role', 'team_id', 'status', 'added_on'], w: [260, 170, 80, 80, 90, 100] },
  { name: 'Attendance', cols: ['date', 'emp_code', 'status', 'in_time'], w: [100, 90, 70, 80] },
  { name: 'KPI_MIS', cols: ['date', 'emp_code', 'logins', 'approved', 'rejected', 'pending', 'disbursed', 'disbursed_amount', 'not_interested', 'source'], w: [100, 90, 70, 80, 80, 80, 80, 130, 110, 90] },
  { name: 'Calls_MIS', cols: ['date', 'emp_code', 'calls', 'connected', 'talk_seconds'], w: [100, 90, 70, 90, 100] },
  { name: 'Config', cols: ['key', 'value', 'note'], w: [170, 80, 520] },
  { name: 'Name_Map', cols: ['tc_name', 'tl_name', 'emp_code'], w: [160, 160, 100] },
  { name: 'Import_Issues', cols: ['when', 'type', 'date', 'tc_name', 'tl_name', 'customer', 'detail', 'sheet_row'], w: [130, 130, 100, 130, 130, 180, 520, 140] },
  { name: 'Directory', cols: ['emp_code', 'full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'pan', 'aadhaar', 'bank_name', 'account_holder', 'account_no', 'ifsc', 'bank_branch', 'designation', 'salary', 'updated_on', 'updated_by'], w: [90, 170, 90, 80, 100, 80, 150, 150, 160, 120, 300, 110, 220, 110, 120, 150, 170, 150, 110, 150, 140, 90, 100, 200] },
  { name: 'Targets', cols: ['scope', 'id', 'month', 'target_amount', 'set_by', 'set_on'], w: [70, 90, 80, 130, 200, 100] },
  { name: 'Remarks', cols: ['remark_id', 'date', 'emp_code', 'category', 'note', 'given_by', 'created_at', 'status'], w: [90, 100, 90, 220, 420, 160, 130, 80] },
  { name: 'Cases', cols: ['case_id', 'date', 'emp_code', 'customer', 'bank', 'product', 'amount', 'stage', 'stage_date', 'updated_by', 'source', 'rm', 'location', 'reason'], w: [80, 100, 90, 200, 150, 120, 110, 100, 100, 160, 90, 110, 110, 300] },
  { name: 'Case_Notes', cols: ['case_id', 'date', 'by', 'note'], w: [80, 130, 160, 480] },
  { name: 'Devices', cols: ['device_id', 'email', 'name', 'role', 'device', 'mode', 'platform', 'first_seen', 'last_seen', 'sign_ins'], w: [150, 240, 150, 70, 200, 120, 100, 130, 130, 70] },
  { name: 'Audit_Log', cols: ['when', 'email', 'action', 'target'], w: [130, 240, 140, 300] },
  { name: 'Efficiency_Log', cols: ['timestamp', 'scope', 'present', 'target_logins', 'logins', 'target_calls', 'calls', 'score'], w: [130, 80, 70, 100, 70, 100, 70, 70] }
];

var CONFIG_DEFAULTS = [
  ['per_head_logins', 2, 'Login (case) target for every telecaller who is present today'],
  ['per_head_calls', 250, 'Call target for every telecaller who is present today'],
  ['connect_benchmark', 0.4, 'A good connect rate. 0.40 means 40 of 100 calls should connect'],
  ['disb_benchmark', 0.3, 'A good share of logins that end in disbursal. 0.30 = 30 percent'],
  ['shift_start_min', 600, 'Shift start in minutes after midnight. 600 = 10:00'],
  ['shift_end_min', 1140, 'Shift end in minutes after midnight. 1140 = 19:00'],
  ['stuck_days', 3, 'A case that has not changed stage for this many days is flagged as stuck']
];

var CASE_WINDOW_DAYS = 14;      // cases are shown for this many days only (today included)
var STAGES = ['LOGIN', 'PENDING', 'QUERY', 'APPROVED', 'REJECTED', 'DISBURSED', 'NOT_INTERESTED'];
var REMARK_CATS = ['Dress code', 'Chewing gum / eating on the floor', 'Late coming', 'Mobile phone use', 'Rude or improper language', 'Not following instructions', 'Leaving seat / long breaks', 'Other'];
var DIR_FIELDS = ['full_name', 'dob', 'gender', 'marital_status', 'blood_group', 'father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'address', 'mobile', 'email', 'pan', 'aadhaar', 'bank_name', 'account_holder', 'account_no', 'ifsc', 'bank_branch', 'designation', 'salary'];
var GENDERS = ['Male', 'Female', 'Other'];
var MARITAL = ['Single', 'Married', 'Divorced', 'Widowed'];
var BLOODS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
var EMP_STATUSES = ['ACTIVE', 'PROBATION', 'NOTICE', 'LEFT'];   // LEFT = gone; the others still count as working

/* ================================================================
 *  SMALL HELPERS
 * ================================================================ */
function props_() { return PropertiesService.getScriptProperties(); }
function str_(v) { return String(v == null ? '' : v).trim(); }
function pad_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var n = Number(str_(v).replace(/[₹,\s]/g, ''));
  return isFinite(n) ? n : 0;
}
function err_(code, msg) { var e = new Error(msg); e.code = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Stops a typed name like  =IMPORTXML(...)  from becoming a live formula in the sheet. */
function safe_(v, max) {
  var s = str_(v).replace(/[\r\n\t]+/g, ' ').slice(0, max || 100);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

var SS_ = null;
function ss_() {
  if (SS_) return SS_;
  var id = props_().getProperty('SHEET_ID');
  if (id) { SS_ = SpreadsheetApp.openById(id); return SS_; }
  var a = null;
  try { a = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { a = null; }
  if (a) { SS_ = a; return a; }
  throw err_('config', 'The sheet is not set up yet. Open the Apps Script editor and run the setup function once.');
}

/** Dates may arrive as real dates or as typed text (2026-10-27 or 27/10/2026). Always return yyyy-mm-dd. */
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var s = str_(v), m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/))) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  return s;
}
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function addDays_(ymd, n) { return Utilities.formatDate(new Date(new Date(ymd + 'T00:00:00+05:30').getTime() + n * 864e5), TZ, 'yyyy-MM-dd'); }
function minsNow_() { var p = Utilities.formatDate(new Date(), TZ, 'HH:mm').split(':'); return (+p[0]) * 60 + (+p[1]); }
function isSunday_(ymd) { return Utilities.formatDate(new Date(ymd + 'T00:00:00+05:30'), TZ, 'u') === '7'; }

/** Gmail ignores dots and +tags, so a.b+x@gmail.com and ab@gmail.com are the same person. */
function normEmail_(e) {
  e = str_(e).toLowerCase();
  var at = e.lastIndexOf('@');
  if (at < 1) return e;
  var u = e.slice(0, at), d = e.slice(at + 1);
  if (d === 'gmail.com' || d === 'googlemail.com') { u = u.split('+')[0].replace(/\./g, ''); d = 'gmail.com'; }
  return u + '@' + d;
}

/** Read a tab into a list of objects (header row = keys). Cached for the length of one request. */
var DB_ = {};
function rows_(name) {
  if (DB_[name]) return DB_[name];
  var out = [], sh = ss_().getSheetByName(name);
  if (sh && sh.getLastRow() > 1 && sh.getLastColumn() > 0) {
    var rng = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
    var v = rng.getValues(), d = rng.getDisplayValues();
    var head = v[0].map(function (h) { return str_(h); });
    for (var r = 1; r < v.length; r++) {
      var o = {}, empty = true;
      for (var c = 0; c < head.length; c++) {
        if (!head[c]) continue;
        var x = v[r][c];
        if (x instanceof Date && head[c] === 'in_time') x = d[r][c];   // time-only cells come back as 1899 dates; use what the sheet shows
        if (x !== '' && x !== null) empty = false;
        o[head[c]] = x;
      }
      if (!empty) out.push(o);
    }
  }
  DB_[name] = out;
  return out;
}

function cfg_() {
  var c = {};
  rows_('Config').forEach(function (r) { c[str_(r.key)] = num_(r.value); });
  return {
    perLogin: c.per_head_logins || 2, perCalls: c.per_head_calls || 250,
    connBm: c.connect_benchmark || 0.4, disbBm: c.disb_benchmark || 0.3,
    start: c.shift_start_min || 600, end: c.shift_end_min || 1140
  };
}

/* ================================================================
 *  1. SETUP  (run once; safe to run again, it never deletes your data)
 * ================================================================ */
function setup() {
  var p = props_(), ss = null, id = p.getProperty('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }   // script was opened from inside a sheet
  }
  var fresh = false;
  if (!ss) { ss = SpreadsheetApp.create(SHEET_NAME); fresh = true; }
  p.setProperty('SHEET_ID', ss.getId());
  SS_ = ss; DB_ = {};
  ss.setSpreadsheetTimeZone(TZ);
  if (fresh) ss.rename(SHEET_NAME);

  TABS.forEach(function (t) { ensureTab_(ss, t); });
  var lists = {
    Employees: { role: ['TELECALLER', 'TL'], status: ['ACTIVE', 'PROBATION', 'NOTICE', 'LEFT'] },
    Access: { role: ['ADMIN', 'TL'], status: ['ACTIVE', 'REVOKED'] },
    Attendance: { status: ['P', 'A', 'L'] },
    Directory: { gender: GENDERS, marital_status: MARITAL, blood_group: BLOODS },
    Cases: { stage: STAGES },
    Targets: { scope: ['EMP', 'TEAM'] }
  };
  Object.keys(lists).forEach(function (tab) {
    var sh = ss.getSheetByName(tab), head = headers_(sh);
    Object.keys(lists[tab]).forEach(function (col) {
      var ci = head.indexOf(col) + 1;
      if (ci < 1) return;
      sh.getRange(2, ci, 2000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(lists[tab][col], true).setAllowInvalid(false).build());
    });
  });

  var cfg = ss.getSheetByName('Config');
  if (cfg.getLastRow() < 2) cfg.getRange(2, 1, CONFIG_DEFAULTS.length, 3).setValues(CONFIG_DEFAULTS);
  else {   // older sheets: add any new setting that is missing, never change existing values
    var have = {};
    rows_('Config').forEach(function (r) { have[str_(r.key)] = 1; });
    CONFIG_DEFAULTS.forEach(function (d) { if (!have[d[0]]) cfg.getRange(cfg.getLastRow() + 1, 1, 1, 3).setValues([d]); });
  }
  writeReadMe_(ss);

  var first = ss.getSheetByName('Access');
  var who = '';
  try { who = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(); } catch (e) { who = ''; }
  if (first.getLastRow() < 2 && who) first.getRange(2, 1, 1, 6).setValues([[who, '', 'ADMIN', '', 'ACTIVE', today_()]]);

  var dflt = ss.getSheetByName('Sheet1');
  if (dflt && ss.getSheets().length > 1 && dflt.getLastRow() === 0) ss.deleteSheet(dflt);
  ss.setActiveSheet(ss.getSheetByName('Employees'));

  secret_();
  installTriggers();
  Logger.log('DONE. Your sheet "%s" is ready:\n%s', ss.getName(), ss.getUrl());
  Logger.log(who ? 'First admin added: ' + who + ' (change it on the Access tab if needed).' : 'Add your own Gmail on the Access tab: role ADMIN, status ACTIVE.');
  Logger.log('Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone). Then run checkSetup to verify.');
}

function headers_(sh) { return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(str_); }

function ensureTab_(ss, t) {
  var sh = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
  if (sh.getMaxRows() < 3001) sh.insertRowsAfter(sh.getMaxRows(), 3001 - sh.getMaxRows());   // formatting below needs the rows to exist
  var existing = sh.getLastColumn() > 0 ? headers_(sh) : [];
  // add any missing columns on the right, never touch existing data
  var missing = t.cols.filter(function (c) { return existing.indexOf(c) < 0; });
  if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  var head = headers_(sh);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#1F2D3A').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  head.forEach(function (h, i) {
    var w = t.w[t.cols.indexOf(h)];
    if (w) sh.setColumnWidth(i + 1, w);
    var col = sh.getRange(2, i + 1, 3000, 1);
    if (h === 'date' || h === 'join_date' || h === 'exit_date' || h === 'dob' || h === 'stage_date') col.setNumberFormat('yyyy-mm-dd');
    else if (['in_time', 'timestamp', 'added_on', 'emp_code', 'leader_code', 'mobile', 'emergency_phone', 'pan', 'aadhaar', 'account_no', 'ifsc', 'month', 'id', 'case_id', 'remark_id', 'device_id', 'first_seen', 'last_seen', 'created_at', 'when', 'updated_on', 'set_on'].indexOf(h) >= 0) col.setNumberFormat('@');
  });
  return sh;
}

function writeReadMe_(ss) {
  var sh = ss.getSheetByName('Read_Me') || ss.insertSheet('Read_Me', 0);
  var lines = [
    ['FLOOR PULSE: how this sheet works'],
    [''],
    ['Employees', 'One row per person (telecallers and team leaders). Never delete a row: set status to LEFT so history stays.'],
    ['Access', 'Who can sign in with Google. email + role (ADMIN or TL) + team_id (only for TL) + status ACTIVE. Set REVOKED to remove access.'],
    ['Attendance', 'One row per person per working day. status P = present, A = absent, L = leave. Sundays need no rows.'],
    ['KPI_MIS', 'One row per person per day. Your backend OVERWRITES the same row as numbers change. Do not add a new row for each login.'],
    ['   logins', 'Number of cases logged in that day.'],
    ['   approved / rejected / pending', 'Number of cases in each stage.'],
    ['   disbursed', 'Number of cases disbursed.'],
    ['   disbursed_amount', 'Total rupees disbursed that day. Plain number like 450000, no commas or symbols.'],
    ['Calls_MIS', 'One row per person per day: calls, connected, talk_seconds. Same overwrite rule.'],
    ['Config', 'Targets and shift timings. Change a value and every target in the app changes.'],
    ['Name_Map', 'Only needed when a name in the backend sheet does not match Employees by itself. tc_name = the name as the backend types it, tl_name = their TL (optional, settles two people with one first name), emp_code = the person in Employees.'],
    ['Import_Issues', 'Rows of the backend sheet that could not be used (name not matched, bad date...). Rewritten on every sync. Fix the cause, the next sync picks it up. Do not edit.'],
    ['Directory', 'ADMIN ONLY. Personal, bank and salary details, one row per employee (emp_code). Name, team, status, join and exit date live on the Employees tab. Best edited inside the app, which checks PAN, Aadhaar, IFSC and mobile numbers. Share this Google Sheet with nobody except admins.'],
    ['Targets', 'Monthly rupee target. scope EMP + id = emp_code, or scope TEAM + id = team_id (optional: otherwise a team target is the sum of its members). month like 2026-10, target_amount plain number.'],
    ['Remarks', 'Admin notes about behaviour (dress code, chewing gum, etc.). Written in the app. status VOID = withdrawn; nothing is deleted.'],
    ['Cases', 'One row per customer case: date (login date), emp_code, customer, bank, amount, stage (LOGIN, PENDING, QUERY, APPROVED, REJECTED, DISBURSED), stage_date. The app shows the last 14 days. Rows with source BACKEND are rewritten from the backend sheet every 10 minutes (see BackendSync.gs). Admins and team leaders can still add cases in the app.'],
    ['Case_Notes', 'Why a case has not moved: written in the app by admins and team leaders.'],
    ['Devices', 'Which device and app (installed or browser) each team leader or admin signs in from, and when last seen. Written by the app.'],
    ['Audit_Log', 'Who opened or changed the Directory. Written by the app. Do not edit.'],
    ['Efficiency_Log', 'Written by the script every 10 minutes. Do not edit.'],
    [''],
    ['Dates', 'Type dates as 2026-10-27 (year-month-day).'],
    ['Teams', 'A team exists when Employees has a row with that team_id. team_id like T1, T2. The TL row gives the team its leader name.']
  ];
  sh.clear();
  sh.getRange(1, 1, lines.length, 2).setValues(lines.map(function (l) { return [l[0], l[1] || '']; }));
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sh.getRange(3, 1, lines.length - 2, 1).setFontWeight('bold');
  sh.setColumnWidth(1, 230); sh.setColumnWidth(2, 760);
  sh.getRange(1, 1, lines.length, 2).setWrap(true).setVerticalAlignment('top');
}

/** Run this any time to see whether everything is in place. */
function checkSetup() {
  var ok = true;
  function say(good, msg) { if (!good) ok = false; Logger.log((good ? 'OK    ' : 'FIX   ') + msg); }
  say(GOOGLE_CLIENT_ID.indexOf('PASTE') !== 0 && /\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID), 'GOOGLE_CLIENT_ID is filled in at the top of Code.gs');
  var ss = null;
  try { ss = ss_(); } catch (e) { ss = null; }
  say(!!ss, 'Sheet exists' + (ss ? ': ' + ss.getUrl() : ' (run setup)'));
  if (ss) {
    TABS.forEach(function (t) {
      var sh = ss.getSheetByName(t.name);
      var head = sh && sh.getLastColumn() > 0 ? headers_(sh) : [];
      var miss = t.cols.filter(function (c) { return head.indexOf(c) < 0; });
      say(!!sh && !miss.length, 'Tab ' + t.name + (miss.length ? ' is missing columns: ' + miss.join(', ') : ''));
    });
    var admins = rows_('Access').filter(function (r) { return str_(r.role).toUpperCase() === 'ADMIN' && str_(r.status).toUpperCase() === 'ACTIVE'; });
    say(admins.length > 0, 'At least one active ADMIN on the Access tab (' + admins.length + ' found)');
  }
  var trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  say(trig.indexOf('logEfficiency') >= 0, 'Efficiency timer is installed (every 10 minutes)');
  var url = ''; try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  say(!!url, url ? 'Web app is deployed: ' + url : 'Web app not deployed yet. Deploy > New deployment > Web app');
  Logger.log(ok ? 'ALL GOOD.' : 'Fix the lines marked FIX, then run checkSetup again.');
}

/* ================================================================
 *  2. SIGN-IN AND SESSIONS
 *  Google proves who the person is. We then look the email up on the Access tab.
 * ================================================================ */
function verifyGoogle_(idToken) {
  if (!str_(idToken)) throw err_('login', 'No Google sign-in was received. Please try again.');
  if (GOOGLE_CLIENT_ID.indexOf('PASTE') === 0) throw err_('config', 'GOOGLE_CLIENT_ID is not filled in at the top of Code.gs.');
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw err_('login', 'Google could not verify this sign-in. Please try again.');
  var t = JSON.parse(res.getContentText());
  if (t.aud !== GOOGLE_CLIENT_ID) throw err_('config', 'The Client ID in config.js and in Code.gs do not match. Make them identical.');
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw err_('login', 'This sign-in did not come from Google.');
  if (String(t.email_verified) !== 'true') throw err_('login', 'This Google account has no verified email.');
  if (Number(t.exp) * 1000 < Date.now()) throw err_('login', 'This sign-in has expired. Please try again.');
  return { email: str_(t.email), name: str_(t.name) };
}

function secret_() {
  var p = props_(), s = p.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SESSION_SECRET', s); }
  return s;
}
function sign_(msg) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret_())); }
function makeToken_(email) {
  var p = Utilities.base64EncodeWebSafe(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }));
  return p + '.' + sign_(p);
}
function readToken_(t) {
  t = str_(t);
  var i = t.indexOf('.');
  if (i < 1) return null;
  var p = t.slice(0, i), s = t.slice(i + 1), o;
  if (sign_(p) !== s) return null;
  try { o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p)).getDataAsString()); } catch (e) { return null; }
  if (!o || !o.e || o.x < Date.now() / 1000) return null;
  return o.e;
}

/** The Access-tab row for this email, or null. Checked on EVERY request so revoking works at once. */
function accessFor_(email) {
  var n = normEmail_(email), hit = null;
  rows_('Access').forEach(function (r) {
    if (normEmail_(r.email) === n && str_(r.status).toUpperCase() === 'ACTIVE') hit = r;
  });
  if (!hit) return null;
  var role = str_(hit.role).toUpperCase(), team = str_(hit.team_id);
  if (role !== 'ADMIN' && role !== 'TL') return null;
  if (role === 'TL' && !team) return null;
  return { email: n, name: str_(hit.name), role: role, team_id: role === 'TL' ? team : '' };
}

/* ================================================================
 *  WEB APP ENTRY POINTS
 * ================================================================ */
function doGet() { return json_({ ok: true, app: 'Floor Pulse API', hint: 'Open the dashboard website, not this link.' }); }

function doPost(e) {
  var out;
  DB_ = {}; SS_ = null;   // every request starts from a clean read of the sheet
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route_(body);
  } catch (err) {
    out = { error: err.code || 'server', message: err.code ? err.message : 'Something went wrong on the server: ' + err.message };
  }
  return json_(out);
}

var ADMIN_ACTIONS = { staff_add: 1, staff_remove: 1, team_add: 1, access_set: 1, access_revoke: 1, dir_save: 1, target_set: 1, remark_add: 1, remark_void: 1, sync_backend: 1 };
var CASE_ACTIONS = { case_add: 1, case_stage: 1, case_note: 1 };   // admin, or a team leader for their own team

function route_(b) {
  var action = str_(b.action);
  if (action === 'login') {
    var g = verifyGoogle_(b.id_token);
    DB_ = {};
    var acc = accessFor_(g.email);
    if (!acc) throw err_('not_allowed', 'The Google account ' + g.email + ' has not been given access. Ask your admin to add this email.');
    if (acc.role === 'TL' && !teamExists_(acc.team_id)) throw err_('not_allowed', 'Your team (' + acc.team_id + ') was not found in the Employees tab. Ask your admin.');
    touchDevice_(acc, b.device, true);
    return { ok: true, token: makeToken_(acc.email), user: { email: acc.email, name: acc.name || g.name, role: acc.role, team_id: acc.team_id } };
  }
  var email = readToken_(b.token);
  if (!email) throw err_('auth', 'Your session has ended. Please sign in again.');
  var me = accessFor_(email);
  if (!me) throw err_('auth', 'Your access was removed or changed. Please sign in again, or ask your admin.');
  if (action === 'data') {
    if (me.role === 'TL' && !teamExists_(me.team_id)) throw err_('noteam', 'Your team was not found. Ask your admin.');
    touchDevice_(me, b.device, false);
    delete DB_['Devices'];
    return buildData_(me);
  }
  if (action === 'directory') {   // personal, bank and salary data: admin only, never part of the normal data call, never cached by the app
    if (me.role !== 'ADMIN') throw err_('forbidden', 'Only an admin can open the employee directory.');
    audit_(me, 'directory_open', '');
    return { ok: true, directory: directoryOut_() };
  }
  if (ADMIN_ACTIONS[action] || CASE_ACTIONS[action]) {
    if (ADMIN_ACTIONS[action] && me.role !== 'ADMIN') throw err_('forbidden', 'Only an admin can do this.');
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      DB_ = {};
      var r = writeAction_(action, b, me);
      DB_ = {};
      return r;
    } finally { lock.releaseLock(); }
  }
  throw err_('bad_request', 'Unknown request.');
}

function teamExists_(id) {
  return rows_('Employees').some(function (e) { return str_(e.team_id) === str_(id); });
}

/* ================================================================
 *  DATA FOR THE DASHBOARD  (this is where "who sees what" is enforced)
 *    ADMIN: everything.
 *    TL:    full detail for their own team only, plus per-team TOTALS for every team
 *           (so they can see rankings, but never another team's people or numbers per person).
 * ================================================================ */
function empOut_(e) {
  return {
    emp_code: str_(e.emp_code), name: str_(e.name), team_id: str_(e.team_id), team_name: str_(e.team_name),
    leader_code: str_(e.leader_code), role: str_(e.role).toUpperCase(), status: str_(e.status).toUpperCase() || 'ACTIVE',
    join_date: dateStr_(e.join_date), exit_date: e.exit_date ? dateStr_(e.exit_date) : ''
  };
}

function teamList_(emps) {
  var out = [], seen = {};
  emps.forEach(function (e) {
    var id = str_(e.team_id);
    if (!id) return;
    var t = seen[id];
    if (!t) { t = seen[id] = { team_id: id, team_name: '', leader: '', size: 0 }; out.push(t); }
    if (!t.team_name && str_(e.team_name)) t.team_name = str_(e.team_name);
    var role = str_(e.role).toUpperCase(), left = str_(e.status).toUpperCase() === 'LEFT';
    if (role === 'TL' && !left && !t.leader) t.leader = str_(e.name);
    if (role === 'TELECALLER' && !left) t.size++;
  });
  out.forEach(function (t) { if (!t.team_name) t.team_name = t.team_id; });
  return out;
}

/** One row per team per day. Uses the SAME rules as the dashboard so rankings always agree. */
function teamDays_(emps, from, to) {
  var team = {};
  emps.forEach(function (e) {
    if (str_(e.role).toUpperCase() === 'TELECALLER' && str_(e.team_id)) team[str_(e.emp_code)] = str_(e.team_id);
  });
  var st = {}, acc = {};
  function cell(d, c) {
    var k = d + '|' + team[c];
    return acc[k] || (acc[k] = { date: d, team_id: team[c], present: 0, absent: 0, leave: 0, calls: 0, connected: 0, talk_seconds: 0, logins: 0, approved: 0, rejected: 0, pending: 0, disbursed: 0, disbursed_amount: 0 });
  }
  rows_('Attendance').forEach(function (r) {
    var d = dateStr_(r.date), c = str_(r.emp_code);
    if (!team[c] || d < from || d > to) return;
    var s = str_(r.status).toUpperCase();
    st[d + '|' + c] = s === 'P' ? 'P' : s === 'L' ? 'L' : 'A';
  });
  function present(d, c) { var k = d + '|' + c; if (!st[k]) st[k] = 'P'; return st[k] === 'P'; }   // numbers but no attendance row: treated as present
  rows_('KPI_MIS').forEach(function (r) {
    var d = dateStr_(r.date), c = str_(r.emp_code);
    if (!team[c] || d < from || d > to || !present(d, c)) return;
    var a = cell(d, c);
    a.logins += num_(r.logins); a.approved += num_(r.approved); a.rejected += num_(r.rejected); a.pending += num_(r.pending);
    a.disbursed += num_(r.disbursed); a.disbursed_amount += num_(r.disbursed_amount);
  });
  rows_('Calls_MIS').forEach(function (r) {
    var d = dateStr_(r.date), c = str_(r.emp_code);
    if (!team[c] || d < from || d > to || !present(d, c)) return;
    var a = cell(d, c);
    a.calls += num_(r.calls); a.connected += num_(r.connected); a.talk_seconds += num_(r.talk_seconds);
  });
  Object.keys(st).forEach(function (k) {
    var p = k.split('|'), a = cell(p[0], p[1]);
    if (st[k] === 'P') a.present++; else if (st[k] === 'L') a.leave++; else a.absent++;
  });
  return Object.keys(acc).map(function (k) { return acc[k]; });
}

function effRows_(me) {
  var sh = ss_().getSheetByName('Efficiency_Log');
  if (!sh || sh.getLastRow() < 2) return [];
  var last = sh.getLastRow(), n = Math.min(last - 1, 1500);
  var v = sh.getRange(last - n + 1, 1, n, 8).getDisplayValues();
  var cutoff = addDays_(today_(), -1), out = [];
  v.forEach(function (r) {
    var ts = str_(r[0]), m = ts.match(/^(\d{4}-\d{2}-\d{2})\D+(\d{2}):(\d{2})/);
    if (!m || m[1] < cutoff) return;
    if (me.role === 'TL' && str_(r[1]) !== me.team_id) return;
    out.push({ timestamp: m[1] + ' ' + m[2] + ':' + m[3], scope: str_(r[1]), present: num_(r[2]), target_logins: num_(r[3]), logins: num_(r[4]), target_calls: num_(r[5]), calls: num_(r[6]), score: num_(r[7]) });
  });
  return out;
}

function buildData_(me) {
  var isAdmin = me.role === 'ADMIN';
  var days = isAdmin ? ADMIN_HISTORY_DAYS : TL_HISTORY_DAYS;
  var to = today_(), from = addDays_(to, -(days - 1));
  var emps = rows_('Employees');
  var visible = isAdmin ? emps : emps.filter(function (e) { return str_(e.team_id) === me.team_id; });
  var codes = {};
  visible.forEach(function (e) { codes[str_(e.emp_code)] = true; });
  function inWin(r) { var d = dateStr_(r.date); return codes[str_(r.emp_code)] && d >= from && d <= to; }
  function withDate(r, keys) { var o = { date: dateStr_(r.date), emp_code: str_(r.emp_code) }; keys.forEach(function (k) { o[k] = r[k] === undefined ? '' : r[k]; }); return o; }

  var out = {
    role: me.role, team_id: me.team_id,
    user: { email: me.email, name: me.name },
    meta: { asof: new Date().toISOString(), branch: BRANCH_NAME, history_days: days, today: to },
    teams: teamList_(emps),
    employees: visible.map(empOut_),
    attendance: rows_('Attendance').filter(inWin).map(function (r) { var o = withDate(r, ['status', 'in_time']); o.status = str_(o.status).toUpperCase(); o.in_time = str_(o.in_time); return o; }),
    kpi: rows_('KPI_MIS').filter(inWin).map(function (r) { return withDate(r, ['logins', 'approved', 'rejected', 'pending', 'disbursed', 'disbursed_amount', 'not_interested']); }),
    calls: rows_('Calls_MIS').filter(inWin).map(function (r) { return withDate(r, ['calls', 'connected', 'talk_seconds']); }),
    config: rows_('Config').map(function (r) { return { key: str_(r.key), value: num_(r.value) }; }),
    efficiency_log: effRows_(me),
    team_daily: isAdmin ? [] : teamDays_(emps, from, to),
    access: []
  };
  var tg = targetsOut_(isAdmin, emps, codes, from);
  out.targets = tg.targets; out.team_targets = tg.team_targets;
  var cFrom = addDays_(to, -(CASE_WINDOW_DAYS - 1)), caseIds = {};
  out.cases = rows_('Cases').filter(function (r) { var d = dateStr_(r.date); return codes[str_(r.emp_code)] && d >= cFrom && d <= to; }).map(function (r) {
    caseIds[str_(r.case_id)] = 1;
    return { case_id: str_(r.case_id), date: dateStr_(r.date), emp_code: str_(r.emp_code), customer: str_(r.customer), bank: str_(r.bank), product: str_(r.product), amount: num_(r.amount), stage: str_(r.stage).toUpperCase(), stage_date: r.stage_date ? dateStr_(r.stage_date) : dateStr_(r.date), updated_by: str_(r.updated_by), source: str_(r.source), rm: str_(r.rm), location: str_(r.location), reason: str_(r.reason) };
  });
  out.case_notes = rows_('Case_Notes').filter(function (r) { return caseIds[str_(r.case_id)]; }).map(function (r) { return { case_id: str_(r.case_id), date: str_(r.date), by: str_(r.by), note: str_(r.note) }; });
  out.remarks = []; out.devices = []; out.sync = null; out.sync_on = false;
  if (isAdmin) {
    out.sync = lastSync_(); out.sync_on = backendConfigured_();
    out.remarks = rows_('Remarks').filter(function (r) { return str_(r.status).toUpperCase() !== 'VOID' && dateStr_(r.date) >= from; }).map(function (r) {
      return { remark_id: str_(r.remark_id), date: dateStr_(r.date), emp_code: str_(r.emp_code), category: str_(r.category), note: str_(r.note), given_by: str_(r.given_by), created_at: str_(r.created_at) };
    });
    out.devices = rows_('Devices').map(function (r) {
      return { email: str_(r.email), name: str_(r.name), role: str_(r.role), device: str_(r.device), mode: str_(r.mode), platform: str_(r.platform), first_seen: str_(r.first_seen), last_seen: str_(r.last_seen), sign_ins: num_(r.sign_ins) };
    }).sort(function (a, b) { return a.last_seen < b.last_seen ? 1 : -1; }).slice(0, 300);
    out.access = rows_('Access').map(function (r) {
      return { email: str_(r.email), name: str_(r.name), role: str_(r.role).toUpperCase(), team_id: str_(r.team_id), status: str_(r.status).toUpperCase() || 'ACTIVE' };
    });
  }
  return out;
}

/* ================================================================
 *  ADMIN WRITE ACTIONS
 * ================================================================ */
function appendObj_(name, obj) {
  var sh = ss_().getSheetByName(name), head = headers_(sh);
  var row = head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}
function setCell_(name, rowNo, col, val) {
  var sh = ss_().getSheetByName(name), ci = headers_(sh).indexOf(col) + 1;
  if (ci > 0) sh.getRange(rowNo, ci).setValue(val);
}
/** Row numbers are looked up fresh so we never edit the wrong line. */
function findRow_(name, pred) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return 0;
  var head = headers_(sh), v = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
  for (var i = 0; i < v.length; i++) {
    var o = {};
    head.forEach(function (h, c) { o[h] = v[i][c]; });
    if (pred(o)) return i + 2;
  }
  return 0;
}
function nextEmpCode_() {
  var max = 0;
  rows_('Employees').forEach(function (e) { var m = str_(e.emp_code).match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  return 'EMP' + ('000' + (max + 1)).slice(-3);
}

function writeAction_(action, b, me) {
  var emps = rows_('Employees'), teams = teamList_(emps), t, n;

  if (action === 'staff_add') {
    var code = str_(b.emp_code).toUpperCase(), name = safe_(b.name, 80);
    if (!name) throw err_('invalid', 'Enter the telecaller\'s name.');
    if (!/^[A-Z0-9_\-]{2,20}$/.test(code)) throw err_('invalid', 'Employee code can only use letters, numbers, - and _ (2 to 20 characters).');
    if (emps.some(function (e) { return str_(e.emp_code).toUpperCase() === code; })) throw err_('invalid', 'The employee code ' + code + ' is already used.');
    t = teams.filter(function (x) { return x.team_id === str_(b.team_id); })[0];
    if (!t) throw err_('invalid', 'Pick a team that exists.');
    var lead = emps.filter(function (e) { return str_(e.team_id) === t.team_id && str_(e.role).toUpperCase() === 'TL'; })[0];
    appendObj_('Employees', { emp_code: code, name: name, team_id: t.team_id, team_name: t.team_name, leader_code: lead ? str_(lead.emp_code) : '', role: 'TELECALLER', status: 'ACTIVE', join_date: today_() });
    return { ok: true, message: name + ' added to ' + t.team_name + '.' };
  }

  if (action === 'staff_remove') {
    var rc = str_(b.emp_code).toUpperCase();
    var who = emps.filter(function (e) { return str_(e.emp_code).toUpperCase() === rc; })[0];
    if (!who) throw err_('invalid', 'That employee was not found.');
    if (str_(who.role).toUpperCase() !== 'TELECALLER') throw err_('invalid', 'Only telecallers can be removed here. Team leaders are changed in the Employees tab.');
    var rowNo = findRow_('Employees', function (o) { return str_(o.emp_code).toUpperCase() === rc; });
    setCell_('Employees', rowNo, 'status', 'LEFT');
    setCell_('Employees', rowNo, 'exit_date', today_());
    return { ok: true, message: str_(who.name) + ' marked as left. Their history is kept.' };
  }

  if (action === 'team_add') {
    var tn = safe_(b.team_name, 40), ln = safe_(b.leader_name, 80);
    if (!tn || !ln) throw err_('invalid', 'Enter both the team name and the team leader\'s name.');
    if (teams.some(function (x) { return x.team_name.toLowerCase() === tn.toLowerCase(); })) throw err_('invalid', 'A team called ' + tn + ' already exists.');
    var maxT = 0;
    teams.forEach(function (x) { var m = x.team_id.match(/(\d+)$/); if (m) maxT = Math.max(maxT, +m[1]); });
    var tid = 'T' + (maxT + 1);
    appendObj_('Employees', { emp_code: nextEmpCode_(), name: ln, team_id: tid, team_name: tn, leader_code: '', role: 'TL', status: 'ACTIVE', join_date: today_() });
    return { ok: true, message: 'Team ' + tn + ' (' + tid + ') created with leader ' + ln + '. Now give the leader\'s Gmail access below.', team_id: tid };
  }

  if (action === 'access_set') {
    var em = str_(b.email).toLowerCase(), role = str_(b.role).toUpperCase(), tid2 = str_(b.team_id);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw err_('invalid', 'That does not look like an email address.');
    if (role !== 'ADMIN' && role !== 'TL') throw err_('invalid', 'Role must be Admin or Team leader.');
    if (role === 'TL' && !teams.some(function (x) { return x.team_id === tid2; })) throw err_('invalid', 'Pick the team this team leader will see.');
    if (normEmail_(em) === me.email && role !== 'ADMIN') throw err_('invalid', 'You cannot take admin rights away from yourself. Ask another admin.');
    var nm = safe_(b.name, 80), ex = findRow_('Access', function (o) { return normEmail_(o.email) === normEmail_(em); });
    if (ex) {
      setCell_('Access', ex, 'name', nm || '');
      setCell_('Access', ex, 'role', role);
      setCell_('Access', ex, 'team_id', role === 'TL' ? tid2 : '');
      setCell_('Access', ex, 'status', 'ACTIVE');
    } else {
      appendObj_('Access', { email: em, name: nm, role: role, team_id: role === 'TL' ? tid2 : '', status: 'ACTIVE', added_on: today_() });
    }
    return { ok: true, message: em + ' can now sign in as ' + (role === 'ADMIN' ? 'Admin' : 'Team leader of ' + (teams.filter(function (x) { return x.team_id === tid2; })[0] || {}).team_name) + '.' };
  }

  if (action === 'access_revoke') {
    var re = str_(b.email);
    if (normEmail_(re) === me.email) throw err_('invalid', 'You cannot remove your own access.');
    n = 0;
    var row;
    while ((row = findRow_('Access', function (o) { return normEmail_(o.email) === normEmail_(re) && str_(o.status).toUpperCase() === 'ACTIVE'; }))) {
      setCell_('Access', row, 'status', 'REVOKED'); n++;
      if (n > 20) break;
    }
    if (!n) throw err_('invalid', 'That email has no active access.');
    return { ok: true, message: re + ' no longer has access. If they are signed in, they are signed out on their next refresh.' };
  }
  return writeMore_(action, b, me);
}

/* ================================================================
 *  EMPLOYEE DIRECTORY, TARGETS, REMARKS, CASES, DEVICES
 * ================================================================ */
function stamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function stampMs_(s) { var m = str_(s).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/); return m ? new Date(m[1] + 'T' + m[2] + ':00+05:30').getTime() : 0; }
function monthOf_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM') : str_(v).slice(0, 7); }
function who_(me) { return me.name || me.email; }
function digits_(v) { return str_(v).replace(/\D/g, ''); }
function audit_(me, action, target) {
  try { appendObj_('Audit_Log', { when: stamp_(), email: me.email, action: action, target: target }); } catch (e) { /* the log must never block the work */ }
}
function phone_(v, label) {
  var d = digits_(v);
  if (!d) return '';
  if (d.length === 12 && d.slice(0, 2) === '91') d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw err_('invalid', label + ' must be a 10-digit Indian mobile number.');
  return d;
}
function dateOpt_(v, label) {
  var s = str_(v);
  if (!s) return '';
  var d = dateStr_(s), ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00+05:30').getTime());
  if (ok) ok = Utilities.formatDate(new Date(d + 'T00:00:00+05:30'), TZ, 'yyyy-MM-dd') === d;
  if (!ok) throw err_('invalid', label + ' must be a real date like 2026-10-27.');
  return d;
}
function pick_(v, list, label) {
  var s = str_(v);
  if (!s) return '';
  var hit = list.filter(function (x) { return x.toLowerCase() === s.toLowerCase(); })[0];
  if (!hit) throw err_('invalid', label + ' must be one of: ' + list.join(', ') + '.');
  return hit;
}
function cleanDir_(f) {
  var o = {}, v;
  o.full_name = safe_(f.full_name, 80);
  o.dob = dateOpt_(f.dob, 'Date of birth');
  if (o.dob && (o.dob >= today_() || o.dob < '1940-01-01')) throw err_('invalid', 'Date of birth looks wrong.');
  o.gender = pick_(f.gender, GENDERS, 'Gender');
  o.marital_status = pick_(f.marital_status, MARITAL, 'Marital status');
  o.blood_group = pick_(f.blood_group, BLOODS, 'Blood group');
  o.father_name = safe_(f.father_name, 80); o.mother_name = safe_(f.mother_name, 80);
  o.emergency_name = safe_(f.emergency_name, 80);
  o.emergency_phone = phone_(f.emergency_phone, 'Emergency contact number');
  o.address = safe_(f.address, 250);
  o.mobile = phone_(f.mobile, 'Personal mobile number');
  v = str_(f.email).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw err_('invalid', 'Personal email does not look right.');
  o.email = v.slice(0, 120);
  v = str_(f.pan).toUpperCase().replace(/\s/g, '');
  if (v && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) throw err_('invalid', 'PAN must look like ABCDE1234F.');
  o.pan = v;
  v = digits_(f.aadhaar);
  if (v && !/^[2-9]\d{11}$/.test(v)) throw err_('invalid', 'Aadhaar must be 12 digits.');
  o.aadhaar = v;
  o.bank_name = safe_(f.bank_name, 60); o.account_holder = safe_(f.account_holder, 80);
  v = digits_(f.account_no);
  if (v && (v.length < 6 || v.length > 20)) throw err_('invalid', 'Account number must be 6 to 20 digits.');
  o.account_no = v;
  v = str_(f.ifsc).toUpperCase().replace(/\s/g, '');
  if (v && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) throw err_('invalid', 'IFSC must look like HDFC0001234.');
  o.ifsc = v;
  o.bank_branch = safe_(f.bank_branch, 80); o.designation = safe_(f.designation, 60);
  if (str_(f.salary) === '') o.salary = '';
  else {
    v = num_(f.salary);
    if (v < 0 || v > 10000000) throw err_('invalid', 'Salary looks wrong.');
    o.salary = v;
  }
  return o;
}
function putObj_(name, rowNo, obj) {
  var sh = ss_().getSheetByName(name), head = headers_(sh), rng = sh.getRange(rowNo, 1, 1, head.length), v = rng.getValues()[0];
  head.forEach(function (h, i) { if (obj[h] !== undefined) v[i] = obj[h]; });
  rng.setValues([v]);
}

/** Every employee, with their sheet details merged in. Admin only. */
function directoryOut_() {
  var emps = rows_('Employees'), dir = {}, lead = {};
  rows_('Directory').forEach(function (r) { dir[str_(r.emp_code).toUpperCase()] = r; });
  emps.forEach(function (e) { if (str_(e.role).toUpperCase() === 'TL' && str_(e.status).toUpperCase() !== 'LEFT' && !lead[str_(e.team_id)]) lead[str_(e.team_id)] = str_(e.name); });
  return emps.map(function (e) {
    var o = empOut_(e), d = dir[str_(e.emp_code).toUpperCase()] || {};
    o.leader_name = o.role === 'TL' ? '' : (lead[o.team_id] || '');
    DIR_FIELDS.forEach(function (k) {
      var x = d[k];
      o[k] = k === 'dob' ? (x ? dateStr_(x) : '') : k === 'salary' ? (x === '' || x == null ? '' : num_(x)) : str_(x);
    });
    o.updated_on = d.updated_on ? str_(d.updated_on) : ''; o.updated_by = str_(d.updated_by);
    return o;
  });
}

/** Monthly rupee targets. Admin sees every person; a team leader only their own team. Team totals are for everyone. */
function targetsOut_(isAdmin, emps, codes, from) {
  var fm = from.slice(0, 7), all = [];
  rows_('Targets').forEach(function (r) {
    if (r.target_amount === '' || r.target_amount == null) return;
    var amt = num_(r.target_amount), m = monthOf_(r.month);
    if (amt > 0 && m >= fm) all.push({ scope: str_(r.scope).toUpperCase(), id: str_(r.id), month: m, amount: amt });
  });
  var byEmp = {}, over = {}, months = {};
  all.forEach(function (t) { months[t.month] = 1; if (t.scope === 'EMP') byEmp[t.id + '|' + t.month] = t.amount; else if (t.scope === 'TEAM') over[t.id + '|' + t.month] = t.amount; });
  var tele = emps.filter(function (e) { return str_(e.role).toUpperCase() === 'TELECALLER' && str_(e.status).toUpperCase() !== 'LEFT'; });
  var out = [];
  teamList_(emps).forEach(function (t) {
    Object.keys(months).forEach(function (m) {
      var set = over[t.team_id + '|' + m], sum = 0;
      tele.forEach(function (e) { if (str_(e.team_id) === t.team_id) sum += byEmp[str_(e.emp_code) + '|' + m] || 0; });
      if (set) out.push({ team_id: t.team_id, month: m, amount: set, source: 'set' });
      else if (sum) out.push({ team_id: t.team_id, month: m, amount: sum, source: 'sum' });
    });
  });
  return {
    targets: all.filter(function (t) { return isAdmin || (t.scope === 'EMP' && codes[t.id]); }),
    team_targets: out
  };
}

function canSee_(me, empCode) {
  if (me.role === 'ADMIN') return true;
  var e = rows_('Employees').filter(function (x) { return str_(x.emp_code).toUpperCase() === str_(empCode).toUpperCase(); })[0];
  return !!e && str_(e.team_id) === me.team_id;
}
function nextCaseId_() {
  var max = 0;
  rows_('Cases').forEach(function (c) { var m = str_(c.case_id).match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  return 'C' + ('00000' + (max + 1)).slice(-5);
}

function writeMore_(action, b, me) {
  var emps = rows_('Employees'), teams = teamList_(emps), code, e, rowNo, today = today_();

  if (action === 'sync_backend') {
    var sm = syncBackend_(SYNC_DAYS);
    return { ok: true, message: 'Synced. ' + sm.rows + ' rows read, ' + sm.imported + ' cases imported for ' + sm.people + ' people' + (sm.unmatched ? '. ' + sm.unmatched + ' rows could not be matched to a telecaller (see below)' : '') + '.' };
  }

  if (action === 'dir_save') {
    code = str_(b.emp_code).toUpperCase();
    e = emps.filter(function (x) { return str_(x.emp_code).toUpperCase() === code; })[0];
    if (!e) throw err_('invalid', 'That employee was not found.');
    var f = cleanDir_(b.fields || {});
    var isTL = str_(e.role).toUpperCase() === 'TL', upd = {};
    var nm = b.name === undefined ? str_(e.name) : safe_(b.name, 80);
    if (!nm) throw err_('invalid', 'Enter the name.');
    upd.name = nm;
    var status = str_(b.status).toUpperCase() || str_(e.status).toUpperCase() || 'ACTIVE';
    if (EMP_STATUSES.indexOf(status) < 0) throw err_('invalid', 'Employment status must be one of: ' + EMP_STATUSES.join(', ') + '.');
    var jd = b.join_date === undefined ? dateStr_(e.join_date) : dateOpt_(b.join_date, 'Date of joining');
    var xd = b.exit_date === undefined ? (e.exit_date ? dateStr_(e.exit_date) : '') : dateOpt_(b.exit_date, 'Exit date');
    if (status === 'LEFT') { if (!xd) xd = today; } else xd = '';
    if (jd && xd && xd < jd) throw err_('invalid', 'Exit date cannot be before the joining date.');
    upd.status = status; upd.join_date = jd; upd.exit_date = xd;
    if (b.team_id !== undefined && !isTL && str_(b.team_id) !== str_(e.team_id)) {
      var t = teams.filter(function (x) { return x.team_id === str_(b.team_id); })[0];
      if (!t) throw err_('invalid', 'Pick a team that exists.');
      var ld = emps.filter(function (x) { return str_(x.team_id) === t.team_id && str_(x.role).toUpperCase() === 'TL'; })[0];
      upd.team_id = t.team_id; upd.team_name = t.team_name; upd.leader_code = ld ? str_(ld.emp_code) : '';
    }
    rowNo = findRow_('Employees', function (o) { return str_(o.emp_code).toUpperCase() === code; });
    putObj_('Employees', rowNo, upd);
    f.emp_code = str_(e.emp_code); f.updated_on = today; f.updated_by = me.email;
    var dRow = findRow_('Directory', function (o) { return str_(o.emp_code).toUpperCase() === code; });
    if (dRow) putObj_('Directory', dRow, f); else appendObj_('Directory', f);
    audit_(me, 'directory_save', str_(e.emp_code));
    return { ok: true, message: nm + '’s details are saved.' };
  }

  if (action === 'target_set') {
    var month = str_(b.month), items = Array.isArray(b.items) ? b.items : [];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw err_('invalid', 'Pick a month.');
    if (!items.length || items.length > 400) throw err_('invalid', 'Nothing to save.');
    var sh = ss_().getSheetByName('Targets'), head = headers_(sh), at = {}, add = [], n = 0;
    if (sh.getLastRow() > 1) {
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
      v.forEach(function (row, i) {
        var o = {}; head.forEach(function (h, c) { o[h] = row[c]; });
        at[str_(o.scope).toUpperCase() + '|' + str_(o.id) + '|' + monthOf_(o.month)] = i + 2;
      });
    }
    var teleCodes = {}; emps.forEach(function (x) { if (str_(x.role).toUpperCase() === 'TELECALLER') teleCodes[str_(x.emp_code).toUpperCase()] = 1; });
    items.forEach(function (it) {
      var sc = str_(it.scope).toUpperCase(), id = str_(it.id);
      if (sc === 'EMP') { id = id.toUpperCase(); if (!teleCodes[id]) throw err_('invalid', 'Unknown telecaller ' + id + '.'); }
      else if (sc === 'TEAM') { if (!teams.some(function (x) { return x.team_id === id; })) throw err_('invalid', 'Unknown team ' + id + '.'); }
      else throw err_('invalid', 'Bad target row.');
      var amt = (it.amount === '' || it.amount == null) ? '' : num_(it.amount);
      if (amt !== '' && (amt < 0 || amt > 10000000000)) throw err_('invalid', 'A target amount looks wrong.');
      var key = sc + '|' + id + '|' + month, row = at[key], rec = { scope: sc, id: id, month: month, target_amount: amt, set_by: me.email, set_on: today };
      if (row) putObj_('Targets', row, rec); else if (amt !== '') add.push(head.map(function (h) { return rec[h] !== undefined ? rec[h] : ''; }));
      n++;
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, head.length).setValues(add);
    return { ok: true, message: 'Targets saved for ' + month + ' (' + n + ' rows).' };
  }

  if (action === 'remark_add') {
    code = str_(b.emp_code).toUpperCase();
    e = emps.filter(function (x) { return str_(x.emp_code).toUpperCase() === code; })[0];
    if (!e) throw err_('invalid', 'Pick an employee.');
    var cat = pick_(b.category, REMARK_CATS, 'Category');
    if (!cat) throw err_('invalid', 'Pick a category.');
    var note = safe_(b.note, 300);
    var day = b.date ? dateOpt_(b.date, 'Date') : today;
    if (day > today) throw err_('invalid', 'The date cannot be in the future.');
    var rid = 'R' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 36).toString(36).toUpperCase();
    appendObj_('Remarks', { remark_id: rid, date: day, emp_code: str_(e.emp_code), category: cat, note: note, given_by: who_(me), created_at: stamp_(), status: 'ACTIVE' });
    return { ok: true, message: 'Remark recorded for ' + str_(e.name) + '.', remark_id: rid };
  }

  if (action === 'remark_void') {
    var vid = str_(b.remark_id);
    rowNo = findRow_('Remarks', function (o) { return str_(o.remark_id) === vid; });
    if (!rowNo) throw err_('invalid', 'That remark was not found.');
    setCell_('Remarks', rowNo, 'status', 'VOID');
    return { ok: true, message: 'Remark withdrawn. It stays in the sheet marked VOID.' };
  }

  if (action === 'case_add') {
    code = str_(b.emp_code).toUpperCase();
    e = emps.filter(function (x) { return str_(x.emp_code).toUpperCase() === code && str_(x.role).toUpperCase() === 'TELECALLER'; })[0];
    if (!e || !canSee_(me, code)) throw err_('invalid', 'Pick one of your telecallers.');
    var cust = safe_(b.customer, 80), bank = safe_(b.bank, 60);
    if (!cust) throw err_('invalid', 'Enter the customer name.');
    if (!bank) throw err_('invalid', 'Enter the bank.');
    var st = str_(b.stage).toUpperCase() || 'LOGIN';
    if (STAGES.indexOf(st) < 0) throw err_('invalid', 'Stage must be one of: ' + STAGES.join(', ') + '.');
    var cd = b.date ? dateOpt_(b.date, 'Date') : today, amt2 = str_(b.amount) === '' ? '' : num_(b.amount);
    if (cd > today) throw err_('invalid', 'The date cannot be in the future.');
    if (amt2 !== '' && (amt2 < 0 || amt2 > 10000000000)) throw err_('invalid', 'The amount looks wrong.');
    var cid = nextCaseId_();
    appendObj_('Cases', { case_id: cid, date: cd, emp_code: str_(e.emp_code), customer: cust, bank: bank, product: safe_(b.product, 40), amount: amt2, stage: st, stage_date: cd, updated_by: who_(me) });
    return { ok: true, message: 'Case ' + cid + ' added for ' + str_(e.name) + '.', case_id: cid };
  }

  if (action === 'case_stage' || action === 'case_note') {
    var cs = str_(b.case_id);
    rowNo = findRow_('Cases', function (o) { return str_(o.case_id) === cs; });
    if (!rowNo) throw err_('invalid', 'That case was not found.');
    var c = rows_('Cases').filter(function (x) { return str_(x.case_id) === cs; })[0];
    if (!canSee_(me, str_(c.emp_code))) throw err_('forbidden', 'That case belongs to another team.');
    var nt = safe_(b.note, 300);
    if (action === 'case_note' && !nt) throw err_('invalid', 'Write the note first.');
    if (action === 'case_stage') {
      var ns = str_(b.stage).toUpperCase();
      if (STAGES.indexOf(ns) < 0) throw err_('invalid', 'Stage must be one of: ' + STAGES.join(', ') + '.');
      putObj_('Cases', rowNo, { stage: ns, stage_date: today, updated_by: who_(me) });
    }
    if (nt) appendObj_('Case_Notes', { case_id: cs, date: stamp_(), by: who_(me), note: nt });
    return { ok: true, message: action === 'case_stage' ? 'Case moved to ' + str_(b.stage).toUpperCase() + '.' : 'Note added.' };
  }
  throw err_('bad_request', 'Unknown request.');
}

/** Remember which device and app each signed-in person uses. Never allowed to break sign-in or data loading. */
function touchDevice_(me, dev, isLogin) {
  try {
    if (!dev || !/^[A-Za-z0-9_\-]{8,64}$/.test(str_(dev.id))) return;
    var lock = LockService.getScriptLock();
    try { lock.waitLock(3000); } catch (e) { return; }
    try {
      var id = str_(dev.id), sh = ss_().getSheetByName('Devices');
      if (!sh) return;
      var rowNo = findRow_('Devices', function (o) { return str_(o.device_id) === id && normEmail_(o.email) === me.email; });
      var now = stamp_(), info = { name: safe_(me.name, 80), role: me.role, device: safe_(dev.label, 60), mode: safe_(dev.mode, 30), platform: safe_(dev.platform, 30), last_seen: now };
      if (rowNo) {
        var ci = headers_(sh).indexOf('last_seen') + 1, si = headers_(sh).indexOf('sign_ins') + 1;
        var last = str_(sh.getRange(rowNo, ci).getDisplayValues()[0][0]);
        if (!isLogin && Date.now() - stampMs_(last) < 120000) return;   // one write every 2 minutes is plenty
        if (isLogin) info.sign_ins = num_(sh.getRange(rowNo, si).getValues()[0][0]) + 1;
        putObj_('Devices', rowNo, info);
      } else {
        info.device_id = id; info.email = me.email; info.first_seen = now; info.sign_ins = 1;
        appendObj_('Devices', info);
      }
    } finally { lock.releaseLock(); }
  } catch (e) { /* device tracking is a bonus, not a gate */ }
}

/* ================================================================
 *  3. TIMERS
 * ================================================================ */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'logEfficiency' || h === 'dailyCleanup' || h === 'syncBackend') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('logEfficiency').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyCleanup').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('syncBackend').timeBased().everyMinutes(10).create();   // reads the backend team's sheet (see BackendSync.gs)
}

function score_(logins, tL, calls, tC, conn, disb, k) {
  if (!tL) return 0;
  var c = function (x) { return Math.min(1, x); };
  var rN = calls ? (conn / calls) / k.connBm : 0;
  var rD = logins ? (disb / logins) / k.disbBm : 0;
  return 100 * (0.45 * c(logins / tL) + 0.30 * c(tC ? calls / tC : 0) + 0.15 * c(rN) + 0.10 * c(rD));
}

/** Every 10 minutes during the shift: one row for the whole branch and one per team. */
function logEfficiency() {
  DB_ = {}; SS_ = null;
  var k = cfg_(), mins = minsNow_(), today = today_();
  if (mins < k.start || mins > k.end + 10 || isSunday_(today)) return;
  var emps = rows_('Employees');
  var frac = Math.min(1, (mins - k.start) / (k.end - k.start));
  var ts = today + ' ' + pad_(Math.floor(mins / 60)) + ':' + pad_(mins % 60);
  var perTeam = {}, branch = { present: 0, logins: 0, calls: 0, conn: 0, disb: 0 };
  teamDays_(emps, today, today).forEach(function (r) {
    perTeam[r.team_id] = { present: r.present, logins: r.logins, calls: r.calls, conn: r.connected, disb: r.disbursed };
    branch.present += r.present; branch.logins += r.logins; branch.calls += r.calls; branch.conn += r.connected; branch.disb += r.disbursed;
  });
  var scopes = [['BRANCH', branch]];
  Object.keys(perTeam).forEach(function (id) { scopes.push([id, perTeam[id]]); });
  var out = scopes.map(function (s) {
    var a = s[1], tL = a.present * k.perLogin, tC = a.present * k.perCalls;
    var sc = score_(a.logins, tL * frac, a.calls, tC * frac, a.conn, a.disb, k);
    return [ts, s[0], a.present, tL, a.logins, tC, a.calls, Math.round(sc * 10) / 10];
  });
  var log = ss_().getSheetByName('Efficiency_Log');
  log.getRange(log.getLastRow() + 1, 1, out.length, 8).setValues(out);
}

/** Nightly: keeps Efficiency_Log small so the sheet stays fast. */
function dailyCleanup() {
  SS_ = null;
  var sh = ss_().getSheetByName('Efficiency_Log');
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = addDays_(today_(), -LOG_KEEP_DAYS);
  var col = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues(), n = 0;
  while (n < col.length && str_(col[n][0]).slice(0, 10) < cutoff) n++;
  if (n > 0) sh.deleteRows(2, n);
}

/* ================================================================
 *  OPTIONAL: demo data so you can try the dashboard before real data arrives
 *    loadDemoData()   adds 16 sample telecallers in 4 sample teams and 7 days of numbers
 *    clearDemoData()  removes exactly those rows again (everything starting with DEMO)
 * ================================================================ */
function loadDemoData() {
  DB_ = {};
  var ss = ss_();
  if (rows_('Employees').some(function (e) { return str_(e.emp_code).indexOf('DEMO') === 0; })) throw new Error('Demo data is already loaded. Run clearDemoData first.');
  var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  var teams = [['DT1', 'Alpha', 'Asha Rao'], ['DT2', 'Bravo', 'Bharat Shah'], ['DT3', 'Charlie', 'Chitra Nair'], ['DT4', 'Delta', 'Dev Malhotra']];
  var names = ['Rahul Verma', 'Sana Khan', 'Karan Mehta', 'Divya Iyer', 'Amit Patil', 'Riya Shah', 'Tanvi Desai', 'Mohit Gupta', 'Farah Ansari', 'Suresh Yadav', 'Kavya Menon', 'Nikhil Pawar', 'Aarav Singh', 'Zoya Qureshi', 'Rohan Kale', 'Meera Reddy'];
  var emp = [], att = [], kpi = [], calls = [], people = [];
  var today = today_();
  teams.forEach(function (t, i) { emp.push(['DEMOTL' + (i + 1), t[2], t[0], t[1], '', 'TL', 'ACTIVE', '2025-02-01', '']); });
  names.forEach(function (n, k) {
    var ti = Math.floor(k / 4), code = 'DEMO' + ('0' + (k + 1)).slice(-2);
    emp.push([code, n, teams[ti][0], teams[ti][1], 'DEMOTL' + (ti + 1), 'TELECALLER', 'ACTIVE', '2025-03-01', '']);
    people.push({ code: code, skill: 0.7 + rnd() * 0.6 });
  });
  var dates = [], d = today;
  while (dates.length < 7) { if (!isSunday_(d)) dates.unshift(d); d = addDays_(d, -1); }
  var cfg = cfg_(), frac = Math.max(0.1, Math.min(1, (minsNow_() - cfg.start) / (cfg.end - cfg.start)));
  dates.forEach(function (day) {
    var f = day === today ? frac : 1;
    people.forEach(function (p) {
      var u = rnd();
      if (u > 0.9) { att.push([day, p.code, u > 0.95 ? 'L' : 'A', '']); return; }
      att.push([day, p.code, 'P', '10:' + pad_(Math.floor(rnd() * 30))]);
      var cl = Math.round(250 * p.skill * (0.8 + 0.4 * rnd()) * f), cn = Math.round(cl * (0.3 + 0.15 * rnd()));
      var lg = Math.round(2 * p.skill * (0.7 + 0.6 * rnd()) * f), pn = Math.min(lg, Math.round(lg * 0.3));
      var ap = Math.round((lg - pn) * 0.6), rj = lg - pn - ap, ds = Math.round(ap * 0.6), amt = 0;
      for (var q = 0; q < ds; q++) amt += Math.round((90000 + rnd() * 460000) / 1000) * 1000;
      kpi.push([day, p.code, lg, ap, rj, pn, ds, amt, Math.round(cn * 0.4)]);
      calls.push([day, p.code, cl, cn, Math.round(cn * 170)]);
    });
  });
  function put(name, rows) { var sh = ss.getSheetByName(name); if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows); }
  put('Employees', emp); put('Attendance', att); put('KPI_MIS', kpi); put('Calls_MIS', calls);
  var month = today.slice(0, 7), tg = [], cases = [], custs = ['Sunil Jadhav', 'Pooja Kamble', 'Imtiyaz Shaikh', 'Neelam Rane', 'Vikram Sawant', 'Geeta Naik', 'Arjun Bhosale', 'Fatima Sheikh'], banks = ['HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Bajaj Finserv', 'SBI'], stg = ['LOGIN', 'PENDING', 'QUERY', 'APPROVED', 'REJECTED', 'DISBURSED'];
  people.forEach(function (p, k) {
    tg.push(['EMP', p.code, month, (12 + (k % 5) * 2) * 100000, 'demo', today]);
    for (var q = 0; q < 3; q++) {
      var dd = dates[Math.floor(rnd() * dates.length)], s = stg[Math.floor(rnd() * stg.length)];
      cases.push(['C' + ('00000' + (cases.length + 1)).slice(-5), dd, p.code, custs[Math.floor(rnd() * custs.length)], banks[Math.floor(rnd() * banks.length)], 'Personal loan', (1 + Math.floor(rnd() * 9)) * 100000, s, dd, 'demo']);
    }
  });
  put('Targets', tg); put('Cases', cases);
  Logger.log('Demo data loaded: %s people, %s days. Add yourself as TL of DT1 on the Access tab to try the team leader view. Run clearDemoData when done.', emp.length, dates.length);
}

function clearDemoData() {
  DB_ = {};
  var ss = ss_(), total = 0;
  ['Employees', 'Attendance', 'KPI_MIS', 'Calls_MIS', 'Targets', 'Cases', 'Directory', 'Remarks'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var ci = headers_(sh).indexOf(name === 'Targets' ? 'id' : 'emp_code');
    if (ci < 0) return;
    var v = sh.getRange(2, ci + 1, sh.getLastRow() - 1, 1).getValues();
    for (var i = v.length - 1; i >= 0; i--) {
      if (str_(v[i][0]).toUpperCase().indexOf('DEMO') === 0) { sh.deleteRow(i + 2); total++; }
    }
  });
  Logger.log('Removed %s demo rows.', total);
}
