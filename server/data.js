'use strict';
/*
 * The one payload the dashboard reads ("data" action). This is where "who sees what" is enforced:
 *   ADMIN: everything, up to 180 days back.
 *   TL:    their own team in full (60 days back). For other teams only team TOTALS and leader names.
 */
const { str, num, dateStr, todayIST, addDays } = require('./util');
const { teamList, empOut, teamDays, efficiencyForUser, targetsOut } = require('./metrics');

const KPI_KEYS = ['logins', 'approved', 'rejected', 'pending', 'disbursed', 'disbursed_amount', 'not_interested'];
const CALL_KEYS = ['calls', 'connected', 'talk_seconds'];

async function buildData(ctx, me) {
  const { cfg, repo, db, store } = ctx;
  const isAdmin = me.role === 'ADMIN';
  const days = isAdmin ? cfg.adminHistoryDays : cfg.tlHistoryDays;
  const nowDate = ctx.now();
  const to = todayIST(nowDate), from = addDays(to, -(days - 1));
  const cFrom = addDays(to, -(cfg.caseWindowDays - 1));

  const [emps, snap, configRows, targetRows, caseRows, noteRows, remarkRows, deviceRows, accessRows, lastSync] = await Promise.all([
    repo.employees(db),
    store.snapshot(),
    repo.config(db),
    repo.targets(db),
    repo.cases(db, cFrom, to),
    repo.caseNotes(db, cFrom),
    isAdmin ? repo.remarks(db, from) : Promise.resolve([]),
    isAdmin ? repo.devices(db) : Promise.resolve([]),
    isAdmin ? repo.access(db) : Promise.resolve([]),
    isAdmin ? repo.getState(db, 'LAST_SYNC') : Promise.resolve('')
  ]);

  const visible = isAdmin ? emps : emps.filter(e => str(e.team_id) === me.team_id);
  const codes = {};
  visible.forEach(e => { codes[str(e.emp_code)] = true; });
  const inWin = (r) => { const d = dateStr(r.date); return !!codes[str(r.emp_code)] && d >= from && d <= to; };
  const withDate = (r, keys, numeric) => {
    const o = { date: dateStr(r.date), emp_code: str(r.emp_code) };
    keys.forEach(k => { o[k] = numeric ? num(r[k]) : (r[k] === undefined ? '' : r[k]); });
    return o;
  };

  const cases = caseRows.filter(c => codes[c.emp_code]);   // repo.cases already returns app-shaped rows
  const caseIds = {};
  cases.forEach(c => { caseIds[c.case_id] = true; });

  const out = {
    role: me.role,
    team_id: me.team_id,
    user: { email: me.email, name: me.name },
    meta: { asof: nowDate.toISOString(), branch: cfg.branch, history_days: days, today: to },
    teams: teamList(emps),
    employees: visible.map(empOut),
    attendance: snap.attendance.filter(inWin).map((r) => {
      const o = withDate(r, ['status', 'in_time'], false);
      o.status = str(o.status).toUpperCase();
      o.in_time = str(o.in_time);
      return o;
    }),
    kpi: snap.kpi.filter(inWin).map(r => withDate(r, KPI_KEYS, true)),
    calls: snap.calls.filter(inWin).map(r => withDate(r, CALL_KEYS, true)),
    config: configRows.map(r => ({ key: str(r.key), value: num(r.value) })),
    efficiency_log: efficiencyForUser(snap.efficiency, me, to),
    team_daily: isAdmin ? [] : teamDays(emps, snap.attendance, snap.kpi, snap.calls, from, to),
    access: [],
    cases,
    case_notes: noteRows.filter(n => caseIds[n.case_id]).map(n => ({ case_id: n.case_id, date: n.date, by: n.by, note: n.note })),
    remarks: [],
    devices: [],
    sync: null,
    sync_on: false
  };

  const tg = targetsOut(isAdmin, emps, codes, from, targetRows);
  out.targets = tg.targets;
  out.team_targets = tg.team_targets;

  if (isAdmin) {
    out.sync = parseSync(lastSync);
    out.sync_on = !!cfg.backendSheetId;
    out.remarks = remarkRows
      .filter(r => r.status !== 'VOID' && r.date >= from)
      .map(r => ({ remark_id: r.remark_id, date: r.date, emp_code: r.emp_code, category: r.category, note: r.note, given_by: r.given_by, created_at: r.created_at }));
    out.devices = deviceRows.map(r => ({ email: r.email, name: r.name, role: r.role, device: r.device, mode: r.mode, platform: r.platform, first_seen: r.first_seen, last_seen: r.last_seen, sign_ins: r.sign_ins }));
    out.access = accessRows.map(r => ({ email: r.email, name: r.name, role: r.role, team_id: r.team_id, status: r.status || 'ACTIVE' }));
  }
  return out;
}

function parseSync(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = { buildData };
