'use strict';
/* Every change the app can make. Admin-only actions are checked in app.js before they get here. */
const crypto = require('crypto');
const { str, num, fail, clean, normEmail, todayIST, stampIST, isYmd, addDays, dateStr, dateOrEmpty } = require('./util');
const { teamList, empOut } = require('./metrics');
const { DIR_FIELDS } = require('./repo');
const { canSee, audit } = require('./context');
const { syncBackend } = require('./backend-sync');

const EMP_STATUSES = ['ACTIVE', 'PROBATION', 'NOTICE', 'LEFT'];   // LEFT = gone; the others still count as working
const STAGES = ['LOGIN', 'PENDING', 'QUERY', 'APPROVED', 'REJECTED', 'DISBURSED', 'NOT_INTERESTED'];
const REMARK_CATS = ['Dress code', 'Chewing gum / eating on the floor', 'Late coming', 'Mobile phone use', 'Rude or improper language', 'Not following instructions', 'Leaving seat / long breaks', 'Other'];
const GENDERS = ['Male', 'Female', 'Other'];
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed'];
const BLOODS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const digits = (v) => str(v).replace(/\D/g, '');

function phone(v, label) {
  let d = digits(v);
  if (!d) return '';
  if (d.length === 12 && d.slice(0, 2) === '91') d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw fail('invalid', label + ' must be a 10-digit Indian mobile number.');
  return d;
}
function dateOpt(v, label) {
  const s = str(v);
  if (!s) return '';
  const d = dateStr(s);
  if (!isYmd(d)) throw fail('invalid', label + ' must be a real date like 2026-10-27.');
  return d;
}
function pick(v, list, label) {
  const s = str(v);
  if (!s) return '';
  const hit = list.filter(x => x.toLowerCase() === s.toLowerCase())[0];
  if (!hit) throw fail('invalid', label + ' must be one of: ' + list.join(', ') + '.');
  return hit;
}

/** Checks and tidies the personal details. Sensitive fields are encrypted later, in the repository. */
function cleanDir(f) {
  const o = {};
  o.full_name = clean(f.full_name, 80);
  o.dob = dateOpt(f.dob, 'Date of birth');
  if (o.dob && (o.dob >= todayIST(new Date()) || o.dob < '1940-01-01')) throw fail('invalid', 'Date of birth looks wrong.');
  o.gender = pick(f.gender, GENDERS, 'Gender');
  o.marital_status = pick(f.marital_status, MARITAL, 'Marital status');
  o.blood_group = pick(f.blood_group, BLOODS, 'Blood group');
  o.father_name = clean(f.father_name, 80);
  o.mother_name = clean(f.mother_name, 80);
  o.emergency_name = clean(f.emergency_name, 80);
  o.emergency_phone = phone(f.emergency_phone, 'Emergency contact number');
  o.address = clean(f.address, 250);
  o.mobile = phone(f.mobile, 'Personal mobile number');
  let v = str(f.email).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw fail('invalid', 'Personal email does not look right.');
  o.email = v.slice(0, 120);
  v = str(f.pan).toUpperCase().replace(/\s/g, '');
  if (v && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) throw fail('invalid', 'PAN must look like ABCDE1234F.');
  o.pan = v;
  v = digits(f.aadhaar);
  if (v && !/^[2-9]\d{11}$/.test(v)) throw fail('invalid', 'Aadhaar must be 12 digits.');
  o.aadhaar = v;
  o.bank_name = clean(f.bank_name, 60);
  o.account_holder = clean(f.account_holder, 80);
  v = digits(f.account_no);
  if (v && (v.length < 6 || v.length > 20)) throw fail('invalid', 'Account number must be 6 to 20 digits.');
  o.account_no = v;
  v = str(f.ifsc).toUpperCase().replace(/\s/g, '');
  if (v && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)) throw fail('invalid', 'IFSC must look like HDFC0001234.');
  o.ifsc = v;
  o.bank_branch = clean(f.bank_branch, 80);
  o.designation = clean(f.designation, 60);
  if (str(f.salary) === '') o.salary = '';
  else {
    v = num(f.salary);
    if (v < 0 || v > 10000000) throw fail('invalid', 'Salary looks wrong.');
    o.salary = v;
  }
  return o;
}

function nextEmpCode(emps) {
  let max = 0;
  emps.forEach((e) => { const m = str(e.emp_code).match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  return 'EMP' + ('000' + (max + 1)).slice(-3);
}
function nextTeamId(teams) {
  let max = 0;
  teams.forEach((x) => { const m = x.team_id.match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  return 'T' + (max + 1);
}
function newCaseId() {
  return 'C' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
function newRemarkId() {
  return 'R' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
const who = (me) => me.name || me.email;

/** Runs one write action. Returns the response object for the app. */
async function writeAction(ctx, action, b, me) {
  const { repo, db, cfg } = ctx;
  const now = ctx.now(), today = todayIST(now);
  const emps = await repo.employees(db);
  const teams = teamList(emps);

  if (action === 'staff_add') {
    const code = str(b.emp_code).toUpperCase(), name = clean(b.name, 80);
    if (!name) throw fail('invalid', "Enter the telecaller's name.");
    if (!/^[A-Z0-9_\-]{2,20}$/.test(code)) throw fail('invalid', 'Employee code can only use letters, numbers, - and _ (2 to 20 characters).');
    if (emps.some(e => str(e.emp_code).toUpperCase() === code)) throw fail('invalid', 'The employee code ' + code + ' is already used.');
    const t = teams.filter(x => x.team_id === str(b.team_id))[0];
    if (!t) throw fail('invalid', 'Pick a team that exists.');
    const lead = emps.filter(e => str(e.team_id) === t.team_id && str(e.role).toUpperCase() === 'TL')[0];
    await repo.insertEmployee(db, { emp_code: code, name, team_id: t.team_id, team_name: t.team_name, leader_code: lead ? str(lead.emp_code) : '', role: 'TELECALLER', status: 'ACTIVE', join_date: today });
    return { ok: true, message: name + ' added to ' + t.team_name + '.' };
  }

  if (action === 'staff_remove') {
    const rc = str(b.emp_code).toUpperCase();
    const who1 = emps.filter(e => str(e.emp_code).toUpperCase() === rc)[0];
    if (!who1) throw fail('invalid', 'That employee was not found.');
    if (str(who1.role).toUpperCase() !== 'TELECALLER') throw fail('invalid', 'Only telecallers can be removed here. Team leaders are changed on the Employee directory.');
    await repo.updateEmployee(db, who1.emp_code, { status: 'LEFT', exit_date: today });
    return { ok: true, message: str(who1.name) + ' marked as left. Their history is kept.' };
  }

  if (action === 'team_add') {
    const tn = clean(b.team_name, 40), ln = clean(b.leader_name, 80);
    if (!tn || !ln) throw fail('invalid', "Enter both the team name and the team leader's name.");
    if (teams.some(x => x.team_name.toLowerCase() === tn.toLowerCase())) throw fail('invalid', 'A team called ' + tn + ' already exists.');
    const tid = nextTeamId(teams);
    await repo.insertEmployee(db, { emp_code: nextEmpCode(emps), name: ln, team_id: tid, team_name: tn, leader_code: '', role: 'TL', status: 'ACTIVE', join_date: today });
    return { ok: true, message: 'Team ' + tn + ' (' + tid + ') created with leader ' + ln + '. Now give the leader\'s Gmail access below.', team_id: tid };
  }

  if (action === 'access_set') {
    const em = str(b.email).toLowerCase(), role = str(b.role).toUpperCase(), tid = str(b.team_id);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw fail('invalid', 'That does not look like an email address.');
    if (role !== 'ADMIN' && role !== 'TL') throw fail('invalid', 'Role must be Admin or Team leader.');
    if (role === 'TL' && !teams.some(x => x.team_id === tid)) throw fail('invalid', 'Pick the team this team leader will see.');
    if (normEmail(em) === me.email && role !== 'ADMIN') throw fail('invalid', 'You cannot take admin rights away from yourself. Ask another admin.');
    const name = clean(b.name, 80);
    const ex = await repo.accessFor(db, em);
    await repo.upsertAccess(db, { email: em, name, role, team_id: role === 'TL' ? tid : '', status: 'ACTIVE', added_on: ex && ex.added_on ? ex.added_on : today });
    const t = teams.filter(x => x.team_id === tid)[0];
    return { ok: true, message: em + ' can now sign in as ' + (role === 'ADMIN' ? 'Admin' : 'Team leader of ' + (t ? t.team_name : tid)) + '.' };
  }

  if (action === 'access_revoke') {
    const re = str(b.email);
    if (normEmail(re) === me.email) throw fail('invalid', 'You cannot remove your own access.');
    const ex = await repo.accessFor(db, re);
    if (!ex || ex.status !== 'ACTIVE') throw fail('invalid', 'That email has no active access.');
    await repo.setAccessStatus(db, normEmail(re), 'REVOKED');
    return { ok: true, message: re + ' no longer has access. If they are signed in, they are signed out on their next refresh.' };
  }

  if (action === 'dir_save') {
    const code = str(b.emp_code).toUpperCase();
    const e = emps.filter(x => str(x.emp_code).toUpperCase() === code)[0];
    if (!e) throw fail('invalid', 'That employee was not found.');
    const f = cleanDir(b.fields || {});
    const isTL = str(e.role).toUpperCase() === 'TL', upd = {};
    const nm = b.name === undefined ? str(e.name) : clean(b.name, 80);
    if (!nm) throw fail('invalid', 'Enter the name.');
    upd.name = nm;
    const status = str(b.status).toUpperCase() || str(e.status).toUpperCase() || 'ACTIVE';
    if (EMP_STATUSES.indexOf(status) < 0) throw fail('invalid', 'Employment status must be one of: ' + EMP_STATUSES.join(', ') + '.');
    const jd = b.join_date === undefined ? dateOrEmpty(e.join_date) : dateOpt(b.join_date, 'Date of joining');
    let xd = b.exit_date === undefined ? dateOrEmpty(e.exit_date) : dateOpt(b.exit_date, 'Exit date');
    if (status === 'LEFT') { if (!xd) xd = today; } else xd = '';
    if (jd && xd && xd < jd) throw fail('invalid', 'Exit date cannot be before the joining date.');
    upd.status = status; upd.join_date = jd; upd.exit_date = xd;
    if (b.team_id !== undefined && !isTL && str(b.team_id) !== str(e.team_id)) {
      const t = teams.filter(x => x.team_id === str(b.team_id))[0];
      if (!t) throw fail('invalid', 'Pick a team that exists.');
      const ld = emps.filter(x => str(x.team_id) === t.team_id && str(x.role).toUpperCase() === 'TL')[0];
      upd.team_id = t.team_id; upd.team_name = t.team_name; upd.leader_code = ld ? str(ld.emp_code) : '';
    }
    await db.tx(async (t) => {
      await repo.updateEmployee(t, e.emp_code, upd);
      await repo.saveDirectory(t, e.emp_code, f, today, me.email);
    });
    await audit(ctx, me, 'directory_save', str(e.emp_code));
    return { ok: true, message: nm + '’s details are saved.' };
  }

  if (action === 'target_set') {
    const month = str(b.month), items = Array.isArray(b.items) ? b.items : [];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('invalid', 'Pick a month.');
    if (!items.length || items.length > 400) throw fail('invalid', 'Nothing to save.');
    const teleCodes = {};
    emps.forEach((x) => { if (str(x.role).toUpperCase() === 'TELECALLER') teleCodes[str(x.emp_code).toUpperCase()] = 1; });
    const clean2 = items.map((it) => {
      const sc = str(it.scope).toUpperCase();
      let id = str(it.id);
      if (sc === 'EMP') { id = id.toUpperCase(); if (!teleCodes[id]) throw fail('invalid', 'Unknown telecaller ' + id + '.'); }
      else if (sc === 'TEAM') { if (!teams.some(x => x.team_id === id)) throw fail('invalid', 'Unknown team ' + id + '.'); }
      else throw fail('invalid', 'Bad target row.');
      const amt = (it.amount === '' || it.amount == null) ? '' : num(it.amount);
      if (amt !== '' && (amt < 0 || amt > 10000000000)) throw fail('invalid', 'A target amount looks wrong.');
      return { sc, id, amt };
    });
    await db.tx(async (t) => {
      for (const it of clean2) {
        if (it.amt === '') await repo.deleteTarget(t, it.sc, it.id, month);
        else await repo.upsertTarget(t, it.sc, it.id, month, it.amt, me.email, today);
      }
    });
    return { ok: true, message: 'Targets saved for ' + month + ' (' + clean2.length + ' rows).' };
  }

  if (action === 'remark_add') {
    const code = str(b.emp_code).toUpperCase();
    const e = emps.filter(x => str(x.emp_code).toUpperCase() === code)[0];
    if (!e) throw fail('invalid', 'Pick an employee.');
    const cat = pick(b.category, REMARK_CATS, 'Category');
    if (!cat) throw fail('invalid', 'Pick a category.');
    const note = clean(b.note, 300);
    const day = b.date ? dateOpt(b.date, 'Date') : today;
    if (day > today) throw fail('invalid', 'The date cannot be in the future.');
    const rid = newRemarkId();
    await repo.insertRemark(db, { remark_id: rid, date: day, emp_code: str(e.emp_code), category: cat, note, given_by: who(me), created_at: stampIST(now) });
    return { ok: true, message: 'Remark recorded for ' + str(e.name) + '.', remark_id: rid };
  }

  if (action === 'remark_void') {
    const vid = str(b.remark_id);
    if (!(await repo.remarkById(db, vid))) throw fail('invalid', 'That remark was not found.');
    await repo.voidRemark(db, vid);
    return { ok: true, message: 'Remark withdrawn. It is kept in the database marked VOID.' };
  }

  if (action === 'case_add') {
    const code = str(b.emp_code).toUpperCase();
    const e = emps.filter(x => str(x.emp_code).toUpperCase() === code && str(x.role).toUpperCase() === 'TELECALLER')[0];
    if (!e || !canSee(me, e)) throw fail('invalid', 'Pick one of your telecallers.');
    const cust = clean(b.customer, 80), bank = clean(b.bank, 60);
    if (!cust) throw fail('invalid', 'Enter the customer name.');
    if (!bank) throw fail('invalid', 'Enter the bank.');
    const st = str(b.stage).toUpperCase() || 'LOGIN';
    if (STAGES.indexOf(st) < 0) throw fail('invalid', 'Stage must be one of: ' + STAGES.join(', ') + '.');
    const cd = b.date ? dateOpt(b.date, 'Date') : today;
    const amt = str(b.amount) === '' ? 0 : num(b.amount);
    if (cd > today) throw fail('invalid', 'The date cannot be in the future.');
    if (amt < 0 || amt > 10000000000) throw fail('invalid', 'The amount looks wrong.');
    const cid = newCaseId();
    await repo.insertCase(db, { case_id: cid, date: cd, emp_code: str(e.emp_code), customer: cust, bank, product: clean(b.product, 40), amount: amt, stage: st, stage_date: cd, updated_by: who(me), source: 'APP' });
    return { ok: true, message: 'Case ' + cid + ' added for ' + str(e.name) + '.', case_id: cid };
  }

  if (action === 'case_stage' || action === 'case_note') {
    const cs = str(b.case_id);
    const c = await repo.caseById(db, cs);
    if (!c) throw fail('invalid', 'That case was not found.');
    const owner = emps.filter(x => str(x.emp_code) === c.emp_code)[0];
    if (!canSee(me, owner)) throw fail('forbidden', 'That case belongs to another team.');
    const nt = clean(b.note, 300);
    if (action === 'case_note' && !nt) throw fail('invalid', 'Write the note first.');
    if (action === 'case_stage') {
      if (c.source === 'BACKEND') throw fail('invalid', 'This stage comes from the backend sheet, so it cannot be changed here. You can add a note instead.');
      const ns = str(b.stage).toUpperCase();
      if (STAGES.indexOf(ns) < 0) throw fail('invalid', 'Stage must be one of: ' + STAGES.join(', ') + '.');
      await repo.updateCaseStage(db, cs, ns, today, who(me));
    }
    if (nt) await repo.addCaseNote(db, cs, stampIST(now), who(me), nt);
    return { ok: true, message: action === 'case_stage' ? 'Case moved to ' + str(b.stage).toUpperCase() + '.' : 'Note added.' };
  }

  if (action === 'sync_backend') {
    // already inside the write lock, so call the sync directly; an admin sees its errors
    const s = await syncBackend(ctx, cfg.syncDays);
    return { ok: true, message: 'Synced. ' + s.rows + ' rows read, ' + s.imported + ' cases imported for ' + s.people + ' people' + (s.unmatched ? '. ' + s.unmatched + ' rows could not be matched to a telecaller (see below)' : '') + '.' };
  }

  throw fail('bad_request', 'Unknown request.');
}

/** The Employee directory, one row per employee, with the personal details merged in. Admin only. */
async function directoryOut(ctx) {
  const { repo, db } = ctx;
  const emps = await repo.employees(db);
  const dirRows = await repo.directory(db);
  const dir = {}, lead = {};
  dirRows.forEach((r) => { dir[str(r.emp_code).toUpperCase()] = r; });
  emps.forEach((e) => { if (str(e.role).toUpperCase() === 'TL' && str(e.status).toUpperCase() !== 'LEFT' && !lead[str(e.team_id)]) lead[str(e.team_id)] = str(e.name); });
  return emps.map((e) => {
    const o = empOut(e), d = dir[str(e.emp_code).toUpperCase()] || {};
    o.leader_name = o.role === 'TL' ? '' : (lead[o.team_id] || '');
    DIR_FIELDS.forEach((k) => {
      const x = d[k];
      o[k] = k === 'dob' ? (x ? dateStr(x) : '') : k === 'salary' ? (x === '' || x == null ? '' : num(x)) : str(x);
    });
    o.updated_on = d.updated_on ? str(d.updated_on) : '';
    o.updated_by = str(d.updated_by);
    return o;
  });
}

module.exports = { writeAction, directoryOut, cleanDir, REMARK_CATS, STAGES };
