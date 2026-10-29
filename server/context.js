'use strict';
/*
 * Everything the request handlers and timers share: database, sheets, settings, the write lock,
 * and the access rules (who may sign in, and as what).
 */
const { makeRepo } = require('./repo');
const { SheetStore } = require('./sheets');
const { normEmail, str, fail, stampIST, sheetSafe, stampMs } = require('./util');

/** Runs write jobs one after another, so two admins saving at once cannot interleave. */
function mutex() {
  let chain = Promise.resolve();
  return {
    run(fn) {
      const p = chain.then(fn, fn);
      chain = p.catch(() => {});
      return p;
    }
  };
}

/** Used when no service account is configured: every sheet call explains what to set. */
const noSheets = new Proxy({}, {
  get() {
    return () => { throw fail('config', 'The Google service account is not set on the server (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE).'); };
  }
});

function createContext({ cfg, db, api, now = () => new Date(), log = () => {}, fetch = globalThis.fetch }) {
  const repo = makeRepo({ dataKey: cfg.dataKey });
  const sheetsApi = api || noSheets;
  const store = new SheetStore({ api: sheetsApi, spreadsheetId: cfg.sheetId, now: () => now().getTime(), ttlMs: cfg.snapshotTtlMs });
  return { cfg, db, api: sheetsApi, repo, store, now, log, fetch, lock: mutex() };
}

/** The Access row for this email if it is active and valid, or null. Checked on EVERY request so revoking works at once. */
async function accessFor(ctx, email) {
  const row = await ctx.repo.accessFor(ctx.db, email);
  if (!row || row.status !== 'ACTIVE') return null;
  if (row.role !== 'ADMIN' && row.role !== 'TL') return null;
  if (row.role === 'TL' && !row.team_id) return null;
  return { email: normEmail(email), name: row.name, role: row.role, team_id: row.role === 'TL' ? row.team_id : '' };
}

async function teamExists(ctx, teamId) {
  const emps = await ctx.repo.employees(ctx.db);
  return emps.some(e => str(e.team_id) === str(teamId));
}

/** Team leaders may act only on telecallers in their own team. Admins may act on anyone. */
function canSee(me, emp) {
  return me.role === 'ADMIN' || (!!emp && str(emp.team_id) === me.team_id);
}

/** Writes one line to Audit_Log in the sheet. Never allowed to break the action itself. */
async function audit(ctx, me, action, target) {
  try {
    await ctx.store.appendObjects('Audit_Log', [{ when: stampIST(ctx.now()), email: me.email, action, target: sheetSafe(target, 60) }]);
  } catch (e) { ctx.log('audit failed: ' + e.message); }
}

/** Remembers which device and app each signed-in person uses. Never allowed to break sign-in or data loading. */
async function touchDevice(ctx, me, dev, isLogin) {
  try {
    const id = dev && str(dev.id);
    if (!id || !/^[A-Za-z0-9_\-]{8,64}$/.test(id)) return;
    const now = ctx.now(), stamp = stampIST(now);
    const old = await ctx.repo.device(ctx.db, id, me.email);
    const info = { email: me.email, name: str(me.name).slice(0, 80), role: me.role, device: str(dev.label).slice(0, 60), mode: str(dev.mode).slice(0, 30), platform: str(dev.platform).slice(0, 30), last_seen: stamp };
    if (old) {
      if (!isLogin && now.getTime() - stampMs(old.last_seen) < 120000) return;   // one write every 2 minutes is plenty
      info.first_seen = old.first_seen;
      info.sign_ins = isLogin ? old.sign_ins + 1 : old.sign_ins;
    } else {
      info.first_seen = stamp;
      info.sign_ins = 1;
    }
    await ctx.repo.saveDevice(ctx.db, id, me.email, info);
  } catch (e) { ctx.log('device tracking skipped: ' + e.message); }
}

module.exports = { createContext, mutex, accessFor, teamExists, canSee, audit, touchDevice };
