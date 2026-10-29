'use strict';
/*
 * BACKEND SHEET SYNC
 *
 * The backend team types in THEIR OWN Google Sheet (Date, TL Name, TC Name / TC Emp ID, Customer Name,
 * Stage, Amount, Bank Name, Location). This reads it and fills:
 *   cases (database)      one row per customer (bank, stage, amount, rejection reason)
 *   KPI_MIS (sheet)       logins, approved, rejected, pending, disbursed per person per day
 * It never writes to the backend sheet. The backend team only ever gets Viewer or Editor on THEIR sheet.
 */
const { str, fail, clean, dateStr, pad, todayIST, addDays, stampIST, sheetSafe } = require('./util');

const STAGE_RULES = [
  ['DISBURSED', /disbursed/i],          // first match wins; "Approved For Disbursal" must not count as disbursed
  ['APPROVED', /approv/i],
  ['REJECTED', /reject|declin/i],
  ['NOT_INTERESTED', /\bni\b|not interested/i],
  ['QUERY', /query|document|docs? pending/i],
  ['PENDING', /pend|process|login|under|wip|hold/i]
];
const DEFAULT_STAGE = 'PENDING';

const BACKEND_HEADERS = {
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

function norm(s) { return str(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function firstWord(s) { return norm(s).split(' ')[0] || ''; }

/** A small, stable fingerprint of a text (cyrb53). Case IDs depend on it, so it must never change. */
function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function stageOf(text) {
  const t = str(text);
  if (!t) return DEFAULT_STAGE;
  for (const [name, re] of STAGE_RULES) if (re.test(t)) return name;
  return DEFAULT_STAGE;
}

/** A real date (serial number from the sheet) is always right. Typed text is read as textDateOrder. '' if not a date. */
function backendDate(v, order) {
  if (typeof v === 'number') return dateStr(v);
  const s = str(v);
  if (!s) return '';
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) {
    const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + (+m[3]) : +m[3];
    const d = order === 'DMY' ? a : b, mo = order === 'DMY' ? b : a;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + pad(mo) + '-' + pad(d);
  }
  return '';
}

/** In the Amount column a number is a loan amount; words (a rejection reason) are kept as the reason. */
function amountOrReason(v) {
  if (typeof v === 'number') return { amount: v, reason: '' };
  const s = str(v);
  if (!s) return { amount: 0, reason: '' };
  const n = Number(s.replace(/[₹,\s]/g, ''));
  if (isFinite(n)) return { amount: n, reason: '' };
  return { amount: 0, reason: s };
}

function mapHeaders(cells) {
  const col = {};
  cells.forEach((c, i) => {
    const h = norm(c);
    Object.keys(BACKEND_HEADERS).forEach((k) => {
      if (col[k] == null && BACKEND_HEADERS[k].some(a => norm(a) === h)) col[k] = i;
    });
  });
  return col;
}

/**
 * Works out which telecaller a row of the backend sheet is.
 * 1. An employee ID is always right.  2. Otherwise match by name; the TL name settles two people who share a first name.
 */
function buildMatcher(emps, nameMapRows) {
  const tele = [], byCode = {}, leaders = {}, map = {};
  emps.forEach((e) => {
    if (str(e.role).toUpperCase() === 'TL' && str(e.status).toUpperCase() !== 'LEFT') leaders[str(e.team_id)] = str(e.name);
  });
  emps.forEach((e) => {
    if (str(e.role).toUpperCase() !== 'TELECALLER') return;
    const t = { code: str(e.emp_code), name: norm(e.name), first: firstWord(e.name), team: str(e.team_id), left: str(e.status).toUpperCase() === 'LEFT' };
    tele.push(t);
    byCode[t.code.toUpperCase()] = t;
  });
  nameMapRows.forEach((r) => {
    if (str(r.tc_name) && str(r.emp_code)) map[norm(r.tc_name) + '|' + norm(r.tl_name)] = str(r.emp_code).toUpperCase();
  });
  function tlOk(team, tkey) {
    const ln = norm(leaders[team] || '');
    return !!tkey && (ln === tkey || ln.indexOf(tkey + ' ') === 0 || (tkey.indexOf(' ') < 0 && firstWord(ln) === tkey));
  }
  return function match(tc, tl, id) {
    const idk = str(id).toUpperCase();
    if (idk) {
      const byId = byCode[idk];
      if (!byId) return { error: 'The Emp ID "' + id + '" is not a telecaller in Employees. Check the ID.' };
      const res = { emp: byId }, nk = norm(tc);
      if (nk && !(byId.name === nk || byId.name.indexOf(nk + ' ') === 0 || (nk.indexOf(' ') < 0 && byId.first === nk))) {
        res.warn = 'The ID ' + idk + ' is ' + byId.name + ' in the app but the sheet says "' + tc + '". Counted under the ID.';
      }
      return res;
    }
    const key = norm(tc), tkey = norm(tl);
    const hit = map[key + '|' + tkey] || map[key + '|'];
    if (hit) {
      const m = byCode[hit];
      if (!m) return { error: 'Name_Map sends "' + tc + '" to ' + hit + ', which is not a telecaller in Employees.' };
      return { emp: m };
    }
    let c = tele.filter(t => t.name === key);
    if (!c.length) c = tele.filter(t => t.name.indexOf(key + ' ') === 0 || (key.indexOf(' ') < 0 && t.first === key));
    if (c.length > 1 && tkey) { const n = c.filter(t => tlOk(t.team, tkey)); if (n.length) c = n; }
    if (c.length > 1) { const live = c.filter(t => !t.left); if (live.length) c = live; }
    if (!c.length) return { error: 'No telecaller called "' + tc + '" in Employees. Add them to Employees, or add a row in Name_Map.' };
    if (c.length > 1) return { error: 'More than one telecaller matches "' + tc + '". Fill the TC Emp ID on this row, or add a row in Name_Map.' };
    const out = { emp: c[0] };
    if (tkey && !tlOk(c[0].team, tkey)) out.warn = 'The sheet says TL "' + tl + '" but ' + tc + ' is in team ' + c[0].team + ' (leader ' + (leaders[c[0].team] || 'none') + ') in the app. Counted under the app team.';
    return out;
  };
}

function backendSheetId(cfg) { return str(cfg.backendSheetId); }

/** Reads the backend sheet, rewrites its cases and the backend part of KPI_MIS, and returns a summary. */
async function syncBackend(ctx, days) {
  const { cfg, api, repo, db, store } = ctx;
  const bsid = backendSheetId(cfg);
  if (!bsid) throw fail('backend', 'The backend sheet is not connected yet. Run npm run setup:backend, or set BACKEND_SHEET_ID.');
  let titles;
  try {
    titles = (await api.titles(bsid)).map(t => t.title);
  } catch (e) {
    const who = cfg.serviceAccount ? cfg.serviceAccount.client_email : 'the service account';
    throw fail('backend', 'Could not open the backend sheet. Check the ID, and ask the backend team to share it with ' + who + ' as Viewer.');
  }

  const now = ctx.now(), today = todayIST(now), from = addDays(today, -(days - 1));
  const tabs = cfg.backendTabs.length ? cfg.backendTabs.filter(n => titles.indexOf(n) >= 0) : titles;
  const issues = [], raw = [];
  let tabsRead = 0;
  const issue = (type, r, detail) => issues.push({ type, date: r.date || '', tc: r.tc || r.empid || '', tl: r.tl || '', customer: r.customer || '', detail, at: r.at || '' });

  // 1. read the rows (unformatted, so dates and amounts come back as real values)
  for (const tab of tabs) {
    const grid = await api.grid(bsid, tab, { unformatted: true });
    if (grid.length < 2) continue;
    let hr = -1, col = {};
    for (let r = 0; r < Math.min(10, grid.length) && hr < 0; r++) {
      const c = mapHeaders(grid[r]);
      if (c.date != null && (c.tc != null || c.empid != null) && c.stage != null) { hr = r; col = c; }
    }
    if (hr < 0) continue;
    tabsRead++;
    for (let r = hr + 1; r < grid.length; r++) {
      const row = grid[r];
      const g = (k) => (col[k] == null || row[col[k]] === undefined ? '' : row[col[k]]);
      const o = { empid: str(g('empid')), tc: str(g('tc')), tl: str(g('tl')), customer: str(g('customer')), rm: str(g('rm')), stageText: str(g('stage')), bank: str(g('bank')), location: str(g('location')), amountRaw: g('amount'), at: tab + ' row ' + (r + 1) };
      if (!o.tc && !o.empid && !o.customer && !str(g('date'))) continue;   // blank line
      o.date = backendDate(g('date'), cfg.textDateOrder);
      if (!o.date) { issue('Bad date', o, 'The Date cell is empty or not a date: "' + str(g('date')) + '".'); continue; }
      if (o.date < from) continue;
      if (o.date > today) { issue('Future date', o, 'The date is after today, so the row was skipped.'); continue; }
      if (!o.tc && !o.empid) { issue('Missing TC', o, 'This row has neither a TC Emp ID nor a TC name.'); continue; }
      if (!o.customer) { issue('Missing customer', o, 'No customer name on this row.'); continue; }
      raw.push(o);
    }
  }
  if (!tabsRead) throw fail('backend', 'None of the tabs in the backend sheet has the columns Date, TC Emp ID (or TC Name) and Stage in its first rows. Check the headings, or BACKEND_TABS.');

  // 2. match names, build cases and daily counts
  const emps = await repo.employees(db);
  const match = buildMatcher(emps, await repo.nameMap(db));
  const prev = {};
  (await repo.cases(db, from, today)).forEach((c) => { if (c.source === 'BACKEND') prev[c.case_id] = { stage: c.stage, stage_date: c.stage_date }; });
  const cases = [], kpi = {}, seen = {};
  let unmatched = 0, warnings = 0;

  raw.forEach((r) => {
    const m = match(r.tc, r.tl, r.empid);
    if (m.error) { unmatched++; issue('Name not matched', r, m.error); return; }
    if (m.warn && warnings < 50) { warnings++; issue('Check TL', r, m.warn); }
    const stage = stageOf(r.stageText), ar = amountOrReason(r.amountRaw);
    let reason = ar.reason;
    if (!reason && (stage === 'REJECTED' || stage === 'NOT_INTERESTED') && r.stageText && !/^(rejected|declined|customer ni)$/i.test(r.stageText)) reason = r.stageText;
    const base = [r.date, m.emp.code, norm(r.customer), norm(r.bank)].join('|');
    const n = (seen[base] = (seen[base] || 0) + 1);
    const id = 'B' + hash(base + '#' + n);
    const p = prev[id];
    cases.push({
      case_id: id, date: r.date, emp_code: m.emp.code, customer: clean(r.customer, 80), bank: clean(r.bank, 60), product: '', amount: ar.amount, stage,
      stage_date: p && p.stage === stage && p.stage_date ? p.stage_date : (p ? today : r.date),
      updated_by: 'Backend sheet', source: 'BACKEND', rm: clean(r.rm, 40), location: clean(r.location, 60), reason: clean(reason, 200)
    });
    if (stage === 'NOT_INTERESTED' && !cfg.countNiAsLogin) return;
    const k = m.emp.code + '|' + r.date;
    const a = kpi[k] || (kpi[k] = { date: r.date, emp_code: m.emp.code, logins: 0, approved: 0, rejected: 0, pending: 0, disbursed: 0, disbursed_amount: 0, not_interested: 0, source: 'BACKEND' });
    a.logins++;
    if (stage === 'DISBURSED') { a.approved++; a.disbursed++; a.disbursed_amount += ar.amount; }
    else if (stage === 'APPROVED') a.approved++;
    else if (stage === 'REJECTED') a.rejected++;
    else if (stage === 'NOT_INTERESTED') { a.rejected++; a.not_interested++; }
    else a.pending++;
  });

  // 3. write: cases and problems in one transaction; KPI_MIS in the sheet (other rows are kept)
  const issuesOut = issues.slice(0, 500);
  await db.tx(async (t) => {
    await repo.deleteBackendCases(t, from);
    await repo.insertCases(t, cases);
    await repo.replaceImportIssues(t, issuesOut.map(x => ({ when: stampIST(now), type: x.type, date: x.date, tc_name: x.tc, tl_name: x.tl, customer: x.customer, detail: x.detail, sheet_row: x.at })));
  });

  const kpiRows = await store.objects('KPI_MIS', { unformatted: true });
  const keepK = kpiRows.filter((o) => {
    const d = dateStr(o.date);
    if (d < from) return true;
    return !(str(o.source) === 'BACKEND' || kpi[str(o.emp_code) + '|' + d]);
  });
  const newK = Object.keys(kpi).sort().map(k => kpi[k]);
  await store.replaceObjects('KPI_MIS', keepK.concat(newK));

  const people = {};
  cases.forEach((c) => { people[c.emp_code] = 1; });
  const summary = {
    at: stampIST(now), days, tabs: tabsRead, rows: raw.length, imported: cases.length, people: Object.keys(people).length,
    kpi_rows: newK.length, unmatched, warnings,
    issues: issuesOut.slice(0, 8).map(x => ({ type: x.type, tc: x.tc, customer: x.customer, detail: x.detail })),
    issue_count: issues.length, error: ''
  };
  await repo.setState(db, 'LAST_SYNC', JSON.stringify(summary));
  store.invalidate();
  try {
    const template = await repo.getState(db, 'TEMPLATE_ID');
    if (template && template === bsid) await refreshTelecallerList(ctx);
  } catch (e) { /* the list is a convenience */ }
  return summary;
}

/** The "Telecallers" helper tab in the backend sheet: Emp ID, name, TL and team of everyone still working. */
async function refreshTelecallerList(ctx) {
  const { api, repo, db } = ctx;
  const emps = await repo.employees(db);
  const leaders = {};
  emps.forEach((e) => { if (str(e.role).toUpperCase() === 'TL' && str(e.status).toUpperCase() !== 'LEFT') leaders[str(e.team_id)] = str(e.name); });
  const list = emps.filter(e => str(e.role).toUpperCase() === 'TELECALLER' && str(e.status).toUpperCase() !== 'LEFT')
    .map(e => [str(e.emp_code), str(e.name), leaders[str(e.team_id)] || '', str(e.team_name) || str(e.team_id)])
    .sort((a, b) => (a[1].toLowerCase() < b[1].toLowerCase() ? -1 : 1));
  const bsid = backendSheetId(ctx.cfg);
  const g = await api.grid(bsid, 'Telecallers');
  await api.overwrite(bsid, 'Telecallers', list, Math.max(0, g.length - 1), 4);
}

/** Runs the sync and never throws: a failure is stored and shown on the Staff and access page. */
async function runSyncSafely(ctx) {
  return ctx.lock.run(async () => {
    try {
      return await syncBackend(ctx, ctx.cfg.syncDays);
    } catch (err) {
      const text = JSON.stringify({ at: stampIST(ctx.now()), error: err.message || String(err) });
      try { await ctx.repo.setState(ctx.db, 'LAST_SYNC', text); } catch (e) { /* nothing more to do */ }
      ctx.log('backend sync failed: ' + (err.message || err));
      return null;
    }
  });
}

module.exports = { syncBackend, runSyncSafely, stageOf, backendDate, amountOrReason, buildMatcher, hash, norm, mapHeaders, refreshTelecallerList };
