'use strict';
/*
 * The TV display. A big screen in the branch shows each team and telecaller's logins, calls and score.
 *
 * Privacy rules for this view (on purpose, unlike the dashboard):
 *   - only names, team, logins, calls, present days and the efficiency score are sent
 *   - no rupee amounts, no disbursal counts, no customer cases, remarks, directory or devices
 *   - no attendance detail beyond "present days" in the period
 * Access is by a secret link key stored in app_state. Anyone with the link can see the board,
 * so admins can switch it off or make a new link (which makes the old one stop working at once).
 */
const crypto = require('crypto');
const { str, num, dateStr, todayIST, addDays, isSunday, minutesIST, hhmm, fail } = require('./util');
const { score, teamList } = require('./metrics');

const KEY_STATE = 'TV_KEY';

/** Shift settings from the Config table, same defaults as the dashboard. */
async function shiftSettings(ctx) {
  const rows = await ctx.repo.config(ctx.db);
  const c = {};
  rows.forEach((r) => { c[str(r.key)] = num(r.value); });
  return {
    perLogin: c.per_head_logins || 2, perCalls: c.per_head_calls || 250,
    connBm: c.connect_benchmark || 0.4, disbBm: c.disb_benchmark || 0.3,
    start: c.shift_start_min || 600, end: c.shift_end_min || 1140
  };
}

/** Working days (Sundays skipped), newest first, starting from today. */
function workingDays(today, count) {
  const out = [];
  for (let i = 0; out.length < count && i < 60; i++) {
    const d = addDays(today, -i);
    if (!isSunday(d)) out.push(d);
  }
  return out;
}

/** Builds the board for one period. Targets follow the time of day for today, like the dashboard. */
function periodBoard(people, days, snap, k, today, frac) {
  const att = new Map(), kpi = new Map(), calls = new Map();
  const key = (d, c) => d + '|' + c;
  snap.attendance.forEach((r) => { att.set(key(dateStr(r.date), str(r.emp_code)), str(r.status).toUpperCase()); });
  snap.kpi.forEach((r) => {
    const k2 = key(dateStr(r.date), str(r.emp_code)), o = kpi.get(k2) || { logins: 0, disb: 0 };
    o.logins += num(r.logins); o.disb += num(r.disbursed); kpi.set(k2, o);
  });
  snap.calls.forEach((r) => {
    const k2 = key(dateStr(r.date), str(r.emp_code)), o = calls.get(k2) || { calls: 0, connected: 0 };
    o.calls += num(r.calls); o.connected += num(r.connected); calls.set(k2, o);
  });
  const rows = people.map((p) => {
    const a = { present: 0, logins: 0, calls: 0, connected: 0, disb: 0, tL: 0, tC: 0 };
    days.forEach((d) => {
      const st = att.get(key(d, p.emp_code)) || 'P';   // no record = present, as on the dashboard
      if (st !== 'P') return;
      a.present++;
      const kp = kpi.get(key(d, p.emp_code)), cl = calls.get(key(d, p.emp_code));
      if (kp) { a.logins += kp.logins; a.disb += kp.disb; }
      if (cl) { a.calls += cl.calls; a.connected += cl.connected; }
      const w = d === today ? frac : 1;
      a.tL += k.perLogin * w; a.tC += k.perCalls * w;
    });
    return Object.assign(p, a, { score: score(a.logins, a.tL, a.calls, a.tC, a.connected, a.disb, k) });
  });
  return rows;
}

function summarise(rows, teams, k) {
  const people = rows.slice().sort((x, y) => (y.score - x.score) || (y.logins - x.logins) || x.name.localeCompare(y.name));
  people.forEach((p, i) => { p.rank = i + 1; });
  const teamOut = teams.map((t, ti) => {
    const mine = rows.filter(r => r.team_id === t.team_id);
    const s = mine.reduce((acc, r) => {
      acc.present += r.present; acc.logins += r.logins; acc.calls += r.calls; acc.connected += r.connected;
      acc.disb += r.disb; acc.tL += r.tL; acc.tC += r.tC; return acc;
    }, { present: 0, logins: 0, calls: 0, connected: 0, disb: 0, tL: 0, tC: 0 });
    return { team_id: t.team_id, team_name: t.team_name, leader: t.leader, index: ti, members: mine.length,
      present: s.present, logins: s.logins, calls: s.calls, score: score(s.logins, s.tL, s.calls, s.tC, s.connected, s.disb, k) };
  }).sort((x, y) => (y.score - x.score) || (y.logins - x.logins));
  teamOut.forEach((t, i) => { t.rank = i + 1; });
  const tot = rows.reduce((acc, r) => {
    acc.present += r.present; acc.logins += r.logins; acc.calls += r.calls; acc.connected += r.connected;
    acc.disb += r.disb; acc.tL += r.tL; acc.tC += r.tC; acc.members += 1; return acc;
  }, { present: 0, logins: 0, calls: 0, connected: 0, disb: 0, tL: 0, tC: 0, members: 0 });
  const totals = { present: tot.present, members: tot.members, logins: tot.logins, calls: tot.calls, connected: tot.connected,
    score: Math.round(score(tot.logins, tot.tL, tot.calls, tot.tC, tot.connected, tot.disb, k) * 10) / 10 };
  return {
    totals,
    teams: teamOut,
    people: people.map(p => ({ name: p.name, team_id: p.team_id, team_index: (teams.findIndex(t => t.team_id === p.team_id)), present: p.present, logins: p.logins, calls: p.calls, score: Math.round(p.score * 10) / 10, rank: p.rank }))
  };
}

/** The whole TV payload. Public data only: see the privacy rules at the top of this file. */
async function buildTv(ctx) {
  const { repo, db, store, cfg } = ctx;
  const now = ctx.now();
  const k = await shiftSettings(ctx);
  const mins = minutesIST(now), today = todayIST(now);
  const frac = Math.max(0, Math.min(1, (mins - k.start) / (k.end - k.start)));
  const emps = await repo.employees(db);
  const teams = teamList(emps);
  const telecallers = emps.filter(e => str(e.role).toUpperCase() === 'TELECALLER' && str(e.status).toUpperCase() !== 'LEFT' && str(e.team_id))
    .map(e => ({ emp_code: str(e.emp_code), name: str(e.name), team_id: str(e.team_id) }));
  const snap = await store.snapshot();
  const todayDays = workingDays(today, 1), weekDays = workingDays(today, 7);
  const board = (days) => summarise(periodBoard(telecallers, days, snap, k, today, frac), teams, k);
  // one board per working day, oldest first, for the charts on the TV
  const series = weekDays.slice().reverse().map((d) => {
    const b = board([d]);
    return { date: d, totals: b.totals, teams: b.teams.map(t => ({ team_id: t.team_id, index: t.index, score: t.score, logins: t.logins, calls: t.calls, present: t.present })) };
  });
  return {
    series,
    ok: true,
    asof: now.toISOString(),
    branch: cfg.branch,
    today,
    working_today: todayDays.length > 0 && todayDays[0] === today,
    shift: { start: hhmm(k.start), end: hhmm(k.end), early: frac < 0.02 },
    periods: { today: board(todayDays), week: board(weekDays) }
  };
}

/** The public TV read. Checks the link key in constant time. */
async function tvBoard(ctx, key) {
  const want = await ctx.repo.getState(ctx.db, KEY_STATE);
  if (!want) throw fail('tv_off', 'The TV display is switched off. Ask your admin for a new link.');
  const a = Buffer.from(want), b = Buffer.from(str(key));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail('tv_key', 'This TV link is no longer valid. Ask your admin for a new one.');
  return buildTv(ctx);
}

/** Admin: make a new link (the old one stops working) or switch the display off. */
async function tvKeyAdmin(ctx, me, action) {
  const { audit } = require('./context');
  if (action === 'tv_key_off') {
    await ctx.repo.setState(ctx.db, KEY_STATE, '');
    await audit(ctx, me, 'tv_off', '');
    return { ok: true, message: 'The TV display is switched off. Old links stop working.' };
  }
  const key = crypto.randomBytes(24).toString('base64url');
  await ctx.repo.setState(ctx.db, KEY_STATE, key);
  await audit(ctx, me, 'tv_key_new', '');
  return { ok: true, key, message: 'New TV link made. Any older TV link has stopped working.' };
}

module.exports = { buildTv, tvBoard, tvKeyAdmin, KEY_STATE, workingDays };
