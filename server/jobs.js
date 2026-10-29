'use strict';
/* Background work: the efficiency log every 10 minutes, the backend sync, and a nightly tidy-up of Efficiency_Log. */
const { str, num, dateStr, addDays, todayIST, minutesIST } = require('./util');
const { efficiencyRows } = require('./metrics');
const { runSyncSafely } = require('./backend-sync');

/** Shift settings from the Config table, with the same defaults as before. */
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

/** Appends one efficiency row per team and one for the branch. Returns how many rows were written (0 outside the shift). */
async function logEfficiency(ctx) {
  const k = await shiftSettings(ctx);
  const emps = await ctx.repo.employees(ctx.db);
  const snap = await ctx.store.snapshot(true);
  const rows = efficiencyRows(ctx.now(), k, emps, snap);
  if (!rows) return 0;
  await ctx.store.appendObjects('Efficiency_Log', rows.map(r => ({ timestamp: r[0], scope: r[1], present: r[2], target_logins: r[3], logins: r[4], target_calls: r[5], calls: r[6], score: r[7] })));
  return rows.length;
}

/** Deletes Efficiency_Log rows older than the keep window. Reads the sheet's own text, so it needs no formatting. */
async function cleanEfficiencyLog(ctx) {
  const cutoff = addDays(todayIST(ctx.now()), -ctx.cfg.logKeepDays);
  const grid = await ctx.api.grid(ctx.cfg.sheetId, 'Efficiency_Log');
  let n = 0;
  for (let r = 1; r < grid.length; r++) {
    const d = dateStr(str(grid[r][0]).split(' ')[0]);
    if (d >= cutoff) break;
    n++;
  }
  if (n > 0) {
    await ctx.api.deleteFirst(ctx.cfg.sheetId, 'Efficiency_Log', n);
    ctx.store.invalidate();
  }
  return n;
}

/** Starts the timers. Returns a function that stops them (used by tests and shutdown). */
function startJobs(ctx) {
  const timers = [];
  const guard = (name, fn) => () => {
    Promise.resolve().then(fn).catch(e => ctx.log(name + ' failed: ' + (e.message || e)));
  };
  if (ctx.cfg.efficiencyEveryMin > 0) {
    timers.push(setInterval(guard('efficiency', async () => {
      await ctx.lock.run(() => logEfficiency(ctx));
    }), ctx.cfg.efficiencyEveryMin * 60000));
  }
  if (ctx.cfg.syncEveryMin > 0 && ctx.cfg.backendSheetId) {
    timers.push(setInterval(guard('backend sync', () => runSyncSafely(ctx)), ctx.cfg.syncEveryMin * 60000));
  }
  let lastCleanDay = '';
  timers.push(setInterval(guard('cleanup', async () => {
    const now = ctx.now();
    const today = todayIST(now);
    const mins = minutesIST(now);
    if (today === lastCleanDay || mins < 60 || mins > 120) return;   // once a day, between 01:00 and 02:00 India time
    lastCleanDay = today;
    await ctx.lock.run(() => cleanEfficiencyLog(ctx));
  }), 30 * 60000));
  timers.forEach(t => { if (t.unref) t.unref(); });
  return () => timers.forEach(clearInterval);
}

module.exports = { logEfficiency, cleanEfficiencyLog, startJobs, shiftSettings };
