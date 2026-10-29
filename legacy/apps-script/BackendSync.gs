/* ================================================================
 *  BACKEND SHEET SYNC
 *
 *  The backend team keeps typing in THEIR OWN Google Sheet (Date, TL Name,
 *  TC Name, Customer Name, Rm/code, Stage, Amount, Bank Name, Location).
 *  This file reads that sheet and fills two tabs of YOUR app sheet:
 *    Cases     one row per customer (bank, stage, amount, rejection reason)
 *    KPI_MIS   logins, approved, rejected, pending, disbursed per person per day
 *  so the Cases page, targets and efficiency score all move on their own.
 *
 *  Security: the backend team never gets access to your app sheet. They share
 *  THEIR sheet with you as "Viewer" only. This script runs as you, so it can
 *  read it. It never writes to their sheet.
 *
 *  Everything you may need to change is in the SETTINGS block below.
 * ================================================================ */

/* -------------------------- SETTINGS -------------------------- */

// The ID of the BACKEND sheet: the long text in its address between /d/ and /edit.
// Leave it as it is if you use createBackendTemplate (below): that function connects its sheet for you.
var BACKEND_SHEET_ID = 'PASTE_THE_BACKEND_SHEET_ID_HERE';

// Which tabs of the backend sheet to read. [] = every tab that has the right column headings.
var BACKEND_TABS = [];

// Every sync re-reads the last SYNC_DAYS days. (syncBackfill reads 180 days once.)
var SYNC_DAYS = 60;

// Only used if the Date column holds typed TEXT instead of real dates. 'MDY' = 9/2/2025 is 2 September. 'DMY' = 9 February.
var TEXT_DATE_ORDER = 'MDY';

// true = a "Customer NI" row also counts as a login (and as rejected). false = ignore those rows in the counts.
var COUNT_NI_AS_LOGIN = true;

// How the Stage text becomes an app stage. First match wins, so keep the order.
// "Approved For Disbursal" must NOT count as disbursed, so the disbursed rule needs the word "disbursed".
var STAGE_RULES = [
  ['DISBURSED', /disbursed/i],
  ['APPROVED', /approv/i],
  ['REJECTED', /reject|declin/i],
  ['NOT_INTERESTED', /\bni\b|not interested/i],
  ['QUERY', /query|document|docs? pending/i],
  ['PENDING', /pend|process|login|under|wip|hold/i]
];
var DEFAULT_STAGE = 'PENDING';   // anything the rules above do not recognise

// The backend column headings we look for (any of these spellings, any capitals).
var BACKEND_HEADERS = {
  date: ['date'],
  tl: ['tl name', 'tl', 'team leader'],
  empid: ['tc emp id', 'tc emp code', 'tc code', 'tc id', 'emp id', 'emp code', 'employee id', 'employee code', 'caller id'],
  tc: ['tc name', 'tc', 'telecaller', 'tele caller'],
  customer: ['customer name', 'customer'],
  rm: ['rm/code', 'rm code', 'rm', 'rm name'],
  stage: ['stage', 'status'],
  amount: ['amount'],
  bank: ['bank name', 'bank'],
  location: ['location', 'city']
};

/* -------------------------- HELPERS -------------------------- */

function norm_(s) { return str_(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function first_(s) { return norm_(s).split(' ')[0] || ''; }
function hash_(s) {   // small, stable text fingerprint (cyrb53)
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57, i, c;
  for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** The constant above if you filled it in, otherwise the sheet that createBackendTemplate made. */
function backendSheetId_() {
  if (BACKEND_SHEET_ID && !/PASTE/i.test(BACKEND_SHEET_ID)) return BACKEND_SHEET_ID;
  return str_(PropertiesService.getScriptProperties().getProperty('BACKEND_SHEET_ID'));
}
function backendConfigured_() { return !!backendSheetId_(); }

function stageOf_(text) {
  var t = str_(text);
  if (!t) return DEFAULT_STAGE;
  for (var i = 0; i < STAGE_RULES.length; i++) if (STAGE_RULES[i][1].test(t)) return STAGE_RULES[i][0];
  return DEFAULT_STAGE;
}

/** A real date cell is always right. Typed text is read as TEXT_DATE_ORDER. Returns '' if it is not a date. */
function backendDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = str_(v), m;
  if (!s) return '';
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) {
    var a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + (+m[3]) : +m[3];
    var d = TEXT_DATE_ORDER === 'DMY' ? a : b, mo = TEXT_DATE_ORDER === 'DMY' ? b : a;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + pad_(mo) + '-' + pad_(d);
  }
  return '';
}

/** In the backend's Amount column a number is a loan amount; words (for example a rejection reason) are kept as the reason. */
function amountOrReason_(v) {
  if (typeof v === 'number') return { amount: v, reason: '' };
  var s = str_(v);
  if (!s) return { amount: 0, reason: '' };
  var n = Number(s.replace(/[₹,\s]/g, ''));
  if (isFinite(n)) return { amount: n, reason: '' };
  return { amount: 0, reason: s };
}

function mapHeaders_(cells) {
  var col = {};
  cells.forEach(function (c, i) {
    var h = norm_(c);
    Object.keys(BACKEND_HEADERS).forEach(function (k) {
      if (col[k] == null && BACKEND_HEADERS[k].some(function (a) { return norm_(a) === h; })) col[k] = i;
    });
  });
  return col;
}

/** Work out which telecaller a name in the backend sheet is. The TL name settles two people who share a first name. */
function buildMatcher_() {
  var emps = rows_('Employees'), tele = [], byCode = {}, leaders = {}, map = {};
  emps.forEach(function (e) {
    var role = str_(e.role).toUpperCase(), st = str_(e.status).toUpperCase();
    if (role === 'TL' && st !== 'LEFT') leaders[str_(e.team_id)] = str_(e.name);
  });
  emps.forEach(function (e) {
    if (str_(e.role).toUpperCase() !== 'TELECALLER') return;
    var t = { code: str_(e.emp_code), name: norm_(e.name), first: first_(e.name), team: str_(e.team_id), left: str_(e.status).toUpperCase() === 'LEFT' };
    tele.push(t); byCode[t.code.toUpperCase()] = t;
  });
  rows_('Name_Map').forEach(function (r) {
    if (str_(r.tc_name) && str_(r.emp_code)) map[norm_(r.tc_name) + '|' + norm_(r.tl_name)] = str_(r.emp_code).toUpperCase();
  });
  function tlOk(team, tkey) {
    var ln = norm_(leaders[team] || '');
    return !!tkey && (ln === tkey || ln.indexOf(tkey + ' ') === 0 || (tkey.indexOf(' ') < 0 && first_(ln) === tkey));
  }
  return function (tc, tl, id) {
    // 1. An employee ID is always right: it is what the whole app is built on.
    var idk = str_(id).toUpperCase();
    if (idk) {
      var byId = byCode[idk];
      if (!byId) return { error: 'The Emp ID "' + id + '" is not a telecaller in Employees. Check the ID.' };
      var res = { emp: byId }, nk = norm_(tc);
      if (nk && !(byId.name === nk || byId.name.indexOf(nk + ' ') === 0 || (nk.indexOf(' ') < 0 && byId.first === nk))) res.warn = 'The ID ' + idk + ' is ' + byId.name + ' in the app but the sheet says "' + tc + '". Counted under the ID.';
      return res;
    }
    // 2. No ID on the row: match by name (the TL name settles two people who share a first name).
    var key = norm_(tc), tkey = norm_(tl), hit = map[key + '|' + tkey] || map[key + '|'];
    if (hit) {
      var m = byCode[hit];
      if (!m) return { error: 'Name_Map sends "' + tc + '" to ' + hit + ', which is not a telecaller in Employees.' };
      return { emp: m };
    }
    var c = tele.filter(function (t) { return t.name === key; });
    if (!c.length) c = tele.filter(function (t) { return t.name.indexOf(key + ' ') === 0 || (key.indexOf(' ') < 0 && t.first === key); });
    if (c.length > 1 && tkey) { var n = c.filter(function (t) { return tlOk(t.team, tkey); }); if (n.length) c = n; }
    if (c.length > 1) { var live = c.filter(function (t) { return !t.left; }); if (live.length) c = live; }
    if (!c.length) return { error: 'No telecaller called "' + tc + '" in Employees. Add them to Employees, or add a row in Name_Map.' };
    if (c.length > 1) return { error: 'More than one telecaller matches "' + tc + '". Fill the TC Emp ID on this row, or add a row in Name_Map.' };
    var out = { emp: c[0] };
    if (tkey && !tlOk(c[0].team, tkey)) out.warn = 'The sheet says TL "' + tl + '" but ' + tc + ' is in team ' + c[0].team + ' (leader ' + (leaders[c[0].team] || 'none') + ') in the app. Counted under the app team.';
    return out;
  };
}

/* -------------------------- THE SYNC -------------------------- */

/** Reads the backend sheet and rewrites the backend-sourced rows of Cases and KPI_MIS. Returns a summary. */
function syncBackend_(days) {
  if (!backendConfigured_()) throw err_('backend', 'The backend sheet is not connected yet. Run createBackendTemplate in the Apps Script editor, or paste a sheet ID into BACKEND_SHEET_ID at the top of BackendSync.gs.');
  var bss;
  try { bss = SpreadsheetApp.openById(backendSheetId_()); }
  catch (e) {
    var who = ''; try { who = Session.getEffectiveUser().getEmail(); } catch (x) { who = ''; }
    throw err_('backend', 'Could not open the backend sheet. Check the ID, and ask the backend team to share it with ' + (who || 'the Google account that owns this script') + ' as Viewer.');
  }
  DB_ = {};
  var tz = TZ; try { tz = bss.getSpreadsheetTimeZone() || TZ; } catch (e2) { tz = TZ; }
  var today = today_(), from = addDays_(today, -(days - 1));
  var sheets = BACKEND_TABS.length ? BACKEND_TABS.map(function (n) { return bss.getSheetByName(n); }).filter(Boolean) : bss.getSheets();
  var issues = [], raw = [], tabsRead = 0;
  function issue(type, r, detail) { issues.push({ type: type, date: r.date || '', tc: r.tc || r.empid || '', tl: r.tl || '', customer: r.customer || '', detail: detail, at: r.at || '' }); }

  // 1. read the rows
  sheets.forEach(function (sh) {
    var last = sh.getLastRow(), lc = sh.getLastColumn();
    if (last < 2 || lc < 1) return;
    var v = sh.getRange(1, 1, last, lc).getValues(), hr = -1, col = {}, r, c;
    for (r = 0; r < Math.min(10, v.length) && hr < 0; r++) { c = mapHeaders_(v[r]); if (c.date != null && (c.tc != null || c.empid != null) && c.stage != null) { hr = r; col = c; } }
    if (hr < 0) return;
    tabsRead++;
    for (r = hr + 1; r < v.length; r++) {
      var g = function (k) { return col[k] == null ? '' : v[r][col[k]]; };
      var o = { empid: str_(g('empid')), tc: str_(g('tc')), tl: str_(g('tl')), customer: str_(g('customer')), rm: str_(g('rm')), stageText: str_(g('stage')), bank: str_(g('bank')), location: str_(g('location')), amountRaw: g('amount'), at: sh.getName() + ' row ' + (r + 1) };
      if (!o.tc && !o.empid && !o.customer && !str_(g('date'))) continue;                  // blank line
      o.date = backendDate_(g('date'), tz);
      if (!o.date) { issue('Bad date', o, 'The Date cell is empty or not a date: "' + str_(g('date')) + '".'); continue; }
      if (o.date < from) continue;                                              // older than the window
      if (o.date > today) { issue('Future date', o, 'The date is after today, so the row was skipped.'); continue; }
      if (!o.tc && !o.empid) { issue('Missing TC', o, 'This row has neither a TC Emp ID nor a TC name.'); continue; }
      if (!o.customer) { issue('Missing customer', o, 'No customer name on this row.'); continue; }
      raw.push(o);
    }
  });
  if (!tabsRead) throw err_('backend', 'None of the tabs in the backend sheet has the columns Date, TC Emp ID (or TC Name) and Stage in its first rows. Check the headings, or BACKEND_TABS.');

  // 2. match names, build cases and daily counts
  var match = buildMatcher_(), cases = [], kpi = {}, seen = {}, unmatched = 0, warnings = 0, prevCases = {};
  var csh = ss_().getSheetByName('Cases'), chead = headers_(csh);
  var cExisting = csh.getLastRow() > 1 ? csh.getRange(2, 1, csh.getLastRow() - 1, chead.length).getValues() : [];
  var cObjs = cExisting.map(function (row) { var o = {}; chead.forEach(function (h, i) { o[h] = row[i]; }); return o; });
  cObjs.forEach(function (o) { if (str_(o.source) === 'BACKEND') prevCases[str_(o.case_id)] = { stage: str_(o.stage).toUpperCase(), stage_date: o.stage_date ? dateStr_(o.stage_date) : '' }; });

  raw.forEach(function (r) {
    var m = match(r.tc, r.tl, r.empid);
    if (m.error) { unmatched++; issue('Name not matched', r, m.error); return; }
    if (m.warn && warnings < 50) { warnings++; issue('Check TL', r, m.warn); }
    var stage = stageOf_(r.stageText), ar = amountOrReason_(r.amountRaw), reason = ar.reason;
    if (!reason && (stage === 'REJECTED' || stage === 'NOT_INTERESTED') && r.stageText && !/^(rejected|declined|customer ni)$/i.test(r.stageText)) reason = r.stageText;
    var base = [r.date, m.emp.code, norm_(r.customer), norm_(r.bank)].join('|'), n = (seen[base] = (seen[base] || 0) + 1);
    var id = 'B' + hash_(base + '#' + n), prev = prevCases[id];
    cases.push({
      case_id: id, date: r.date, emp_code: m.emp.code, customer: safe_(r.customer, 80), bank: safe_(r.bank, 60), product: '', amount: ar.amount, stage: stage,
      stage_date: prev && prev.stage === stage && prev.stage_date ? prev.stage_date : (prev ? today : r.date),
      updated_by: 'Backend sheet', source: 'BACKEND', rm: safe_(r.rm, 40), location: safe_(r.location, 60), reason: safe_(reason, 200)
    });
    if (stage === 'NOT_INTERESTED' && !COUNT_NI_AS_LOGIN) return;
    var k = m.emp.code + '|' + r.date, a = kpi[k] || (kpi[k] = { date: r.date, emp_code: m.emp.code, logins: 0, approved: 0, rejected: 0, pending: 0, disbursed: 0, disbursed_amount: 0, not_interested: 0, source: 'BACKEND' });
    a.logins++;
    if (stage === 'DISBURSED') { a.approved++; a.disbursed++; a.disbursed_amount += ar.amount; }
    else if (stage === 'APPROVED') a.approved++;
    else if (stage === 'REJECTED') a.rejected++;
    else if (stage === 'NOT_INTERESTED') { a.rejected++; a.not_interested++; }
    else a.pending++;
  });

  // 3. rewrite the backend-sourced part of Cases (rows added by hand in the app stay)
  function room(sh, rows) { if (sh.getMaxRows() < rows + 2) sh.insertRowsAfter(sh.getMaxRows(), rows + 2 - sh.getMaxRows()); }
  var keepC = cExisting.filter(function (row, i) { var o = cObjs[i]; return !(str_(o.source) === 'BACKEND' && dateStr_(o.date) >= from); });
  var newC = cases.map(function (o) { return chead.map(function (h) { return o[h] === undefined ? '' : o[h]; }); });
  var allC = keepC.concat(newC);
  room(csh, Math.max(allC.length, cExisting.length));
  var padC = allC.slice(); while (padC.length < cExisting.length) padC.push(chead.map(function () { return ''; }));
  if (padC.length) csh.getRange(2, 1, padC.length, chead.length).setValues(padC);

  // 4. rewrite the backend-sourced part of KPI_MIS (other rows for other days or people stay)
  var ksh = ss_().getSheetByName('KPI_MIS'), khead = headers_(ksh);
  var kExisting = ksh.getLastRow() > 1 ? ksh.getRange(2, 1, ksh.getLastRow() - 1, khead.length).getValues() : [];
  var keepK = kExisting.filter(function (row) {
    var o = {}; khead.forEach(function (h, i) { o[h] = row[i]; });
    var d = dateStr_(o.date); if (d < from) return true;
    return !(str_(o.source) === 'BACKEND' || kpi[str_(o.emp_code) + '|' + d]);
  });
  var newK = Object.keys(kpi).sort().map(function (k) { var o = kpi[k]; return khead.map(function (h) { return o[h] === undefined ? '' : o[h]; }); });
  var allK = keepK.concat(newK);
  room(ksh, Math.max(allK.length, kExisting.length));
  var padK = allK.slice(); while (padK.length < kExisting.length) padK.push(khead.map(function () { return ''; }));
  if (padK.length) ksh.getRange(2, 1, padK.length, khead.length).setValues(padK);

  // 5. the problems list
  var ish = ss_().getSheetByName('Import_Issues'), ihead = headers_(ish), shown = issues.slice(0, 500);
  var iOld = Math.max(0, ish.getLastRow() - 1);
  room(ish, Math.max(shown.length, iOld));
  var iRows = shown.map(function (x) { var o = { when: stamp_(), type: x.type, date: x.date, tc_name: x.tc, tl_name: x.tl, customer: x.customer, detail: x.detail, sheet_row: x.at }; return ihead.map(function (h) { return o[h] === undefined ? '' : o[h]; }); });
  while (iRows.length < iOld) iRows.push(ihead.map(function () { return ''; }));
  if (iRows.length) ish.getRange(2, 1, iRows.length, ihead.length).setValues(iRows);

  var people = {}; cases.forEach(function (c) { people[c.emp_code] = 1; });
  var summary = { at: stamp_(), days: days, tabs: tabsRead, rows: raw.length, imported: cases.length, people: Object.keys(people).length, kpi_rows: newK.length, unmatched: unmatched, warnings: warnings, issues: issues.slice(0, 8).map(function (x) { return { type: x.type, tc: x.tc, customer: x.customer, detail: x.detail }; }), issue_count: issues.length, error: '' };
  saveSync_(summary);
  try { if (str_(PropertiesService.getScriptProperties().getProperty('TEMPLATE_ID')) === backendSheetId_()) fillTelecallers_(bss); } catch (e3) { /* the list is a convenience */ }
  DB_ = {};
  return summary;
}

function saveSync_(o) { PropertiesService.getScriptProperties().setProperty('LAST_SYNC', JSON.stringify(o)); }
function lastSync_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('LAST_SYNC') || 'null'); } catch (e) { return null; } }

/** The timer calls this every 10 minutes. It never throws: a failure is stored and shown on the Staff and access page. */
function syncBackend() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return; }
  try { SS_ = null; syncBackend_(SYNC_DAYS); }
  catch (err) { saveSync_({ at: stamp_(), error: err.message || String(err) }); }
  finally { lock.releaseLock(); }
}

/** Run this ONCE by hand after connecting: reads the last 180 days. Shows the problem if there is one. */
function syncBackfill() {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { var s = syncBackend_(180); Logger.log(JSON.stringify(s, null, 1)); return s; }
  finally { lock.releaseLock(); }
}


/* ================================================================
 *  MAKE THE BACKEND SHEET FOR THEM (run once, by hand)
 *
 *  createBackendTemplate builds a new Google Sheet in YOUR Drive with the right
 *  headings, a drop-down of your telecallers (by Emp ID) and a drop-down of stages.
 *  When the backend picks the Emp ID, the TC name and TL name fill in by themselves,
 *  so nobody can mistype a name. It connects itself, so you do not need to paste an ID.
 *  Then share that sheet with the backend team (Editor). It holds only telecaller
 *  names, IDs and TL names. Your app sheet stays private.
 *  Every sync also refreshes its Telecallers tab, so new joiners appear within 10 minutes.
 * ================================================================ */
var TEMPLATE_HEADERS = ['Date', 'TC Emp ID', 'TC Name', 'TL Name', 'Customer Name', 'Number', 'Rm/code', 'Stage', 'Amount', 'Bank Name', 'Location'];
var STAGE_CHOICES = ['Approved For Disbursal', 'Disbursed', 'Rejected', 'Customer NI', 'Pending', 'Query'];
var TEMPLATE_ROWS = 5000;

function ensureRows_(sh, rows) { if (sh.getMaxRows() < rows + 2) sh.insertRowsAfter(sh.getMaxRows(), rows + 2 - sh.getMaxRows()); }

/** Telecallers still working: [emp id, name, TL name, team]. */
function templateList_() {
  var emps = rows_('Employees'), leaders = {};
  emps.forEach(function (e) { if (str_(e.role).toUpperCase() === 'TL' && str_(e.status).toUpperCase() !== 'LEFT') leaders[str_(e.team_id)] = str_(e.name); });
  return emps.filter(function (e) { return str_(e.role).toUpperCase() === 'TELECALLER' && str_(e.status).toUpperCase() !== 'LEFT'; })
    .map(function (e) { return [str_(e.emp_code), str_(e.name), leaders[str_(e.team_id)] || '', str_(e.team_name) || str_(e.team_id)]; })
    .sort(function (a, b) { return a[1].toLowerCase() < b[1].toLowerCase() ? -1 : 1; });
}

function fillTelecallers_(tss) {
  var sh = tss.getSheetByName('Telecallers') || tss.insertSheet('Telecallers');
  var list = templateList_(), old = Math.max(0, sh.getLastRow() - 1);
  ensureRows_(sh, Math.max(list.length, old, 2000));
  sh.getRange(1, 1, 1, 4).setValues([['Emp ID', 'Name', 'TL Name', 'Team']]).setFontWeight('bold').setBackground('#1F2D3A').setFontColor('#FFFFFF');
  sh.getRange(2, 1, Math.max(list.length, old, 1), 1).setNumberFormat('@');
  var rows = list.slice(); while (rows.length < old) rows.push(['', '', '', '']);
  if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
  sh.setFrozenRows(1); sh.setColumnWidth(1, 90); sh.setColumnWidth(2, 180); sh.setColumnWidth(3, 180);
}

function createBackendTemplate() {
  var props = PropertiesService.getScriptProperties(), oldId = props.getProperty('TEMPLATE_ID');
  if (oldId) {   // already made: just refresh its list of telecallers and show where it is
    try { var ex = SpreadsheetApp.openById(oldId); fillTelecallers_(ex); Logger.log('The backend sheet already exists: ' + ex.getUrl()); return { created: false, id: oldId, url: ex.getUrl() }; } catch (e) { /* it was deleted: make a new one below */ }
  }
  DB_ = {};
  var tss = SpreadsheetApp.create('Floor Pulse - Backend entries'), sh = tss.getSheets()[0];
  sh.setName('Entries');
  fillTelecallers_(tss);
  ensureRows_(sh, TEMPLATE_ROWS);
  var H = {}; TEMPLATE_HEADERS.forEach(function (h, i) { H[h] = i + 1; });
  sh.getRange(1, 1, 1, TEMPLATE_HEADERS.length).setValues([TEMPLATE_HEADERS]).setFontWeight('bold').setBackground('#7B1E4B').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  [100, 100, 150, 150, 200, 90, 110, 170, 110, 130, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(2, H['Date'], TEMPLATE_ROWS, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, H['TC Emp ID'], TEMPLATE_ROWS, 1).setNumberFormat('@');
  // pick the Emp ID from the list: the name and the TL fill in by themselves
  var idRule = SpreadsheetApp.newDataValidation().requireValueInRange(tss.getSheetByName('Telecallers').getRange(2, 1, 2000, 1), true).setAllowInvalid(false).build();
  sh.getRange(2, H['TC Emp ID'], TEMPLATE_ROWS, 1).setDataValidation(idRule);
  var stageRule = SpreadsheetApp.newDataValidation().requireValueInList(STAGE_CHOICES, true).setAllowInvalid(true).build();
  sh.getRange(2, H['Stage'], TEMPLATE_ROWS, 1).setDataValidation(stageRule);
  var idCol = 'B2:B';
  sh.getRange(2, H['TC Name']).setFormula('=ARRAYFORMULA(IF(' + idCol + '="","",IFERROR(VLOOKUP(' + idCol + ',Telecallers!A:C,2,FALSE),"Unknown ID")))');
  sh.getRange(2, H['TL Name']).setFormula('=ARRAYFORMULA(IF(' + idCol + '="","",IFERROR(VLOOKUP(' + idCol + ',Telecallers!A:C,3,FALSE),"")))');
  if (typeof sh.getRange(1, 1).setNote === 'function') {
    sh.getRange(1, H['TC Emp ID']).setNote('Pick the telecaller\'s Emp ID from the list. TC Name and TL Name fill in by themselves. Do not type in those two columns.');
    sh.getRange(1, H['Amount']).setNote('The loan amount in rupees. If the case is rejected, you may type the bank\'s reason here instead.');
  }
  props.setProperty('TEMPLATE_ID', tss.getId());
  props.setProperty('BACKEND_SHEET_ID', tss.getId());
  Logger.log('Backend sheet created and connected: ' + tss.getUrl() + '  Now share it with the backend team (Editor). Do NOT share your app sheet.');
  return { created: true, id: tss.getId(), url: tss.getUrl() };
}
