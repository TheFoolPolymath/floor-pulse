'use strict';
/*
 * The numbers. Pure functions on plain arrays, so they are easy to test and identical for everyone.
 * These rules are the same as the Apps Script version (Code.gs), so scores do not change when the app moves.
 */
const { str, num, dateStr, hhmm, minutesIST, todayIST, addDays, isSunday } = require('./util');

/** Efficiency score out of 100: 45% logins vs target, 30% calls vs target, 15% connect rate, 10% disbursal rate. */
function score(logins, targetLogins, calls, targetCalls, connected, disbursed, k) {
  if (!targetLogins) return 0;
  const cap = (x) => Math.min(1, x);
  const rN = calls ? (connected / calls) / k.connBm : 0;
  const rD = logins ? (disbursed / logins) / k.disbBm : 0;
  return 100 * (0.45 * cap(logins / targetLogins) + 0.30 * cap(targetCalls ? calls / targetCalls : 0) + 0.15 * cap(rN) + 0.10 * cap(rD));
}

/** Teams in the order they first appear among the employees. */
function teamList(emps) {
  const out = [], seen = {};
  emps.forEach((e) => {
    const id = str(e.team_id);
    if (!id) return;
    let t = seen[id];
    if (!t) { t = seen[id] = { team_id: id, team_name: '', leader: '', size: 0 }; out.push(t); }
    if (!t.team_name && str(e.team_name)) t.team_name = str(e.team_name);
    const role = str(e.role).toUpperCase(), left = str(e.status).toUpperCase() === 'LEFT';
    if (role === 'TL' && !left && !t.leader) t.leader = str(e.name);
    if (role === 'TELECALLER' && !left) t.size++;
  });
  out.forEach((t) => { if (!t.team_name) t.team_name = t.team_id; });
  return out;
}

/** An employee as the app sees them (no personal details). */
function empOut(e) {
  return {
    emp_code: str(e.emp_code), name: str(e.name), team_id: str(e.team_id), team_name: str(e.team_name),
    leader_code: str(e.leader_code), role: str(e.role).toUpperCase(), status: str(e.status).toUpperCase() || 'ACTIVE',
    join_date: dateStr(e.join_date || ''), exit_date: e.exit_date ? dateStr(e.exit_date) : ''
  };
}

/**
 * One row per team per day, using the same rules as the dashboard, so rankings always agree.
 * Numbers for a person with no attendance row for the day count as present.
 */
function teamDays(emps, attendance, kpi, calls, from, to) {
  const team = {};
  emps.forEach((e) => {
    if (str(e.role).toUpperCase() === 'TELECALLER' && str(e.team_id)) team[str(e.emp_code)] = str(e.team_id);
  });
  const st = {}, acc = {};
  const cell = (d, c) => {
    const k = d + '|' + team[c];
    return acc[k] || (acc[k] = { date: d, team_id: team[c], present: 0, absent: 0, leave: 0, calls: 0, connected: 0, talk_seconds: 0, logins: 0, approved: 0, rejected: 0, pending: 0, disbursed: 0, disbursed_amount: 0 });
  };
  attendance.forEach((r) => {
    const d = dateStr(r.date), c = str(r.emp_code);
    if (!team[c] || d < from || d > to) return;
    const s = str(r.status).toUpperCase();
    st[d + '|' + c] = s === 'P' ? 'P' : s === 'L' ? 'L' : 'A';
  });
  const present = (d, c) => { const k = d + '|' + c; if (!st[k]) st[k] = 'P'; return st[k] === 'P'; };
  kpi.forEach((r) => {
    const d = dateStr(r.date), c = str(r.emp_code);
    if (!team[c] || d < from || d > to || !present(d, c)) return;
    const a = cell(d, c);
    a.logins += num(r.logins); a.approved += num(r.approved); a.rejected += num(r.rejected); a.pending += num(r.pending);
    a.disbursed += num(r.disbursed); a.disbursed_amount += num(r.disbursed_amount);
  });
  calls.forEach((r) => {
    const d = dateStr(r.date), c = str(r.emp_code);
    if (!team[c] || d < from || d > to || !present(d, c)) return;
    const a = cell(d, c);
    a.calls += num(r.calls); a.connected += num(r.connected); a.talk_seconds += num(r.talk_seconds);
  });
  Object.keys(st).forEach((k) => {
    const p = k.split('|'), a = cell(p[0], p[1]);
    if (st[k] === 'P') a.present++; else if (st[k] === 'L') a.leave++; else a.absent++;
  });
  return Object.keys(acc).map((k) => acc[k]);
}

/**
 * The row(s) the efficiency timer writes every 10 minutes: one for the branch, one per team.
 * Returns null outside the shift and on Sundays.
 */
function efficiencyRows(now, k, emps, snap) {
  const mins = minutesIST(now), today = todayIST(now);
  if (mins < k.start || mins > k.end + 10 || isSunday(today)) return null;
  const frac = Math.min(1, (mins - k.start) / (k.end - k.start));
  const ts = today + ' ' + hhmm(mins);
  const perTeam = {}, branch = { present: 0, logins: 0, calls: 0, conn: 0, disb: 0 };
  teamDays(emps, snap.attendance, snap.kpi, snap.calls, today, today).forEach((r) => {
    perTeam[r.team_id] = { present: r.present, logins: r.logins, calls: r.calls, conn: r.connected, disb: r.disbursed };
    branch.present += r.present; branch.logins += r.logins; branch.calls += r.calls; branch.conn += r.connected; branch.disb += r.disbursed;
  });
  const scopes = [['BRANCH', branch]].concat(Object.keys(perTeam).map(id => [id, perTeam[id]]));
  return scopes.map(([scope, a]) => {
    const tL = a.present * k.perLogin, tC = a.present * k.perCalls;
    const sc = score(a.logins, tL * frac, a.calls, tC * frac, a.conn, a.disb, k);
    return [ts, scope, a.present, tL, a.logins, tC, a.calls, Math.round(sc * 10) / 10];
  });
}

/** Efficiency_Log rows the dashboard shows: the last day and a bit, team leaders only see their own team. */
function efficiencyForUser(log, me, today) {
  const cutoff = addDays(today, -1), out = [];
  log.slice(-1500).forEach((r) => {
    const m = str(r.timestamp).match(/^(\S+)\s+(\d{1,2}):(\d{2})/);
    if (!m) return;
    const d = dateStr(m[1]);
    if (d < cutoff) return;
    if (me.role === 'TL' && str(r.scope) !== me.team_id) return;
    out.push({ timestamp: d + ' ' + pad2(m[2]) + ':' + m[3], scope: str(r.scope), present: num(r.present), target_logins: num(r.target_logins), logins: num(r.logins), target_calls: num(r.target_calls), calls: num(r.calls), score: num(r.score) });
  });
  return out;
}
function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** Monthly rupee targets: per person, and per team (set, or the sum of its members). Team leaders only see their own team's people. */
function targetsOut(isAdmin, emps, codes, from, targetRows) {
  const fm = from.slice(0, 7), all = [];
  targetRows.forEach((r) => {
    if (r.target_amount === '' || r.target_amount == null) return;
    const amt = num(r.target_amount), m = str(r.month).slice(0, 7);
    if (amt > 0 && m >= fm) all.push({ scope: str(r.scope).toUpperCase(), id: str(r.id), month: m, amount: amt });
  });
  const byEmp = {}, over = {}, months = {};
  all.forEach((t) => {
    months[t.month] = 1;
    if (t.scope === 'EMP') byEmp[t.id + '|' + t.month] = t.amount;
    else if (t.scope === 'TEAM') over[t.id + '|' + t.month] = t.amount;
  });
  const tele = emps.filter(e => str(e.role).toUpperCase() === 'TELECALLER' && str(e.status).toUpperCase() !== 'LEFT');
  const out = [];
  teamList(emps).forEach((t) => {
    Object.keys(months).forEach((m) => {
      const set = over[t.team_id + '|' + m];
      let sum = 0;
      tele.forEach((e) => { if (str(e.team_id) === t.team_id) sum += byEmp[str(e.emp_code) + '|' + m] || 0; });
      if (set) out.push({ team_id: t.team_id, month: m, amount: set, source: 'set' });
      else if (sum) out.push({ team_id: t.team_id, month: m, amount: sum, source: 'sum' });
    });
  });
  return {
    targets: all.filter(t => isAdmin || (t.scope === 'EMP' && codes[t.id])),
    team_targets: out
  };
}

module.exports = { score, teamList, empOut, teamDays, efficiencyRows, efficiencyForUser, targetsOut };
