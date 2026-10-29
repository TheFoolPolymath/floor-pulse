/** node tools/test-code-gs.js  -> runs Code.gs against a pretend Google Sheet and checks the rules. */
const { makeServer } = require('./fake-apps-script');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
const CID = 'test-client.apps.googleusercontent.com';

const s = makeServer();
s.sandbox.GOOGLE_CLIENT_ID = CID;
const login = email => s.call({ action: 'login', id_token: s.googleToken(email) });
const data = tok => s.call({ action: 'data', token: tok });

console.log('1. setup()');
s.sandbox.setup();
const tabs = s.registry[s.props.SHEET_ID].getSheets().map(x => x.name);
eq(tabs.sort(), ['Access', 'Attendance', 'Audit_Log', 'Calls_MIS', 'Case_Notes', 'Cases', 'Config', 'Devices', 'Directory', 'Efficiency_Log', 'Employees', 'Import_Issues', 'KPI_MIS', 'Name_Map', 'Read_Me', 'Remarks', 'Targets'], 'tabs created, default Sheet1 removed');
eq(s.sheet('KPI_MIS').getRange(1, 1, 1, 9).getValues()[0], ['date', 'emp_code', 'logins', 'approved', 'rejected', 'pending', 'disbursed', 'disbursed_amount', 'not_interested'], 'KPI headers include disbursed_amount');
eq(s.sheet('Access').getRange(2, 1, 1, 5).getValues()[0], ['owner@gmail.com', '', 'ADMIN', '', 'ACTIVE'], 'running user became first admin');
eq(s.triggers.map(t => t.h).sort(), ['dailyCleanup', 'logEfficiency', 'syncBackend'], 'three timers installed');
eq(s.registry[s.props.SHEET_ID].tz, 'Asia/Kolkata', 'sheet timezone set to IST');
ok(!!s.props.SESSION_SECRET, 'session secret generated');
s.sandbox.setup();
eq(s.sheet('Access').getLastRow(), 2, 'setup twice does not duplicate admin');
eq(s.triggers.length, 3, 'setup twice does not duplicate timers');
s.sandbox.checkSetup();
ok(s.logs.some(l => /ALL GOOD/.test(l)), 'checkSetup reports all good: ' + s.logs.filter(l => /FIX/.test(l)).join(' | '));

console.log('2. demo data');
s.sandbox.loadDemoData();
eq(s.sheet('Employees').getLastRow(), 21, '4 TL + 16 telecallers + header');
let threw = false; try { s.sandbox.loadDemoData(); } catch (e) { threw = true; } ok(threw, 'loading demo twice is refused');
const kpiRows = s.sheet('KPI_MIS').getLastRow(); ok(kpiRows > 50, 'kpi rows created ' + kpiRows);

console.log('3. sign-in rules');
let r = s.call({ action: 'login', id_token: 'garbage' }); eq(r.error, 'login', 'bad token rejected');
r = s.call({ action: 'login', id_token: s.googleToken('owner@gmail.com', { aud: 'someone-elses-app' }) }); eq(r.error, 'config', 'token for a different app rejected');
r = s.call({ action: 'login', id_token: s.googleToken('owner@gmail.com', { email_verified: 'false' }) }); eq(r.error, 'login', 'unverified email rejected');
r = s.call({ action: 'login', id_token: s.googleToken('owner@gmail.com', { exp: '1' }) }); eq(r.error, 'login', 'expired token rejected');
r = s.call({ action: 'login', id_token: s.googleToken('stranger@gmail.com') }); eq(r.error, 'not_allowed', 'unknown gmail refused'); ok(/stranger@gmail.com/.test(r.message), 'refusal names the email');
r = s.call({ action: 'data' }); eq(r.error, 'auth', 'data without token refused');
r = s.call({ action: 'data', token: 'abc.def' }); eq(r.error, 'auth', 'forged token refused');
const a = login('o.wner@gmail.com'); ok(a.ok && a.user.role === 'ADMIN', 'admin signs in (gmail dots ignored)');
const tampered = a.token.replace(/^./, c => c === 'A' ? 'B' : 'A'); eq(data(tampered).error, 'auth', 'tampered token refused');

console.log('4. admin data');
let ad = data(a.token);
eq(ad.role, 'ADMIN', 'role admin'); eq(ad.employees.filter(e => e.role === 'TELECALLER').length, 16, 'admin gets all telecallers');
eq(ad.teams.length, 4, '4 teams'); eq(ad.teams[0], { team_id: 'DT1', team_name: 'Alpha', leader: 'Asha Rao', size: 4 }, 'team record');
ok(ad.kpi[0].disbursed_amount !== undefined, 'kpi has amount'); eq(ad.team_daily.length, 0, 'admin does not need team_daily');
eq(ad.meta.today, '2026-10-27', 'today is IST date'); eq(ad.meta.history_days, 180, 'admin history');
ok(ad.access.length === 1, 'admin sees access list');

console.log('5. team leader privacy');
r = s.call({ action: 'access_set', token: a.token, email: 'tl.alpha@gmail.com', name: 'Asha', role: 'TL', team_id: 'DT1' }); ok(r.ok, 'admin adds TL for DT1: ' + r.message);
r = s.call({ action: 'access_set', token: a.token, email: 'tl.bravo@gmail.com', name: 'Bharat', role: 'TL', team_id: 'DT2' }); ok(r.ok, 'admin adds TL for DT2');
const tl = login('tl.alpha@gmail.com'); ok(tl.ok && tl.user.role === 'TL' && tl.user.team_id === 'DT1', 'TL signs in');
const td = data(tl.token);
const myCodes = new Set(ad.employees.filter(e => e.team_id === 'DT1').map(e => e.emp_code));
ok(td.employees.every(e => e.team_id === 'DT1'), 'TL employees are only DT1 (' + td.employees.length + ')');
ok(td.attendance.length > 0 && td.attendance.every(x => myCodes.has(x.emp_code)), 'TL attendance only own team');
ok(td.kpi.length > 0 && td.kpi.every(x => myCodes.has(x.emp_code)), 'TL kpi only own team');
ok(td.calls.length > 0 && td.calls.every(x => myCodes.has(x.emp_code)), 'TL calls only own team');
eq(td.teams.length, 4, 'TL still sees all 4 team names for ranking');
eq(td.access, [], 'TL gets no access list');
ok(!JSON.stringify(td).includes('tl.bravo'), 'no other TL email anywhere in TL payload');
ok(!JSON.stringify(td).includes('Bharat Shah') || td.teams.some(t => t.leader === 'Bharat Shah'), 'other leader name only appears in team list');
// the other teams' people must not appear anywhere
const others = ad.employees.filter(e => e.team_id !== 'DT1' && e.role === 'TELECALLER');
ok(others.every(e => !JSON.stringify(td).includes(e.name) && !JSON.stringify(td).includes('"' + e.emp_code + '"')), 'no other-team telecaller name or code in TL payload');
eq(new Set(td.team_daily.map(x => x.team_id)).size, 4, 'team totals for all 4 teams');
// totals must equal what raw rows add up to
const raw = {};
ad.kpi.forEach(k => { const e = ad.employees.find(x => x.emp_code === k.emp_code); if (!e || e.role !== 'TELECALLER') return; const att = ad.attendance.find(x => x.date === k.date && x.emp_code === k.emp_code); if (att && att.status !== 'P') return; const key = e.team_id + k.date; raw[key] = raw[key] || { l: 0, amt: 0, d: 0 }; raw[key].l += k.logins; raw[key].amt += k.disbursed_amount; raw[key].d += k.disbursed; });
let mism = 0; td.team_daily.forEach(x => { const w = raw[x.team_id + x.date] || { l: 0, amt: 0, d: 0 }; if (w.l !== x.logins || w.amt !== x.disbursed_amount || w.d !== x.disbursed) mism++; });
eq(mism, 0, 'team_daily totals equal the sum of raw rows');
eq(td.meta.history_days, 60, 'TL history is 60 days');
for (const act of ['staff_add', 'staff_remove', 'team_add', 'access_set', 'access_revoke']) eq(s.call({ action: act, token: tl.token, email: 'x@y.com', role: 'ADMIN' }).error, 'forbidden', 'TL cannot ' + act);
eq(s.sheet('Access').getLastRow(), 4, 'TL attempts changed nothing');

console.log('13. directory, targets, remarks, cases, devices');
{
  const A = login('owner@gmail.com'), TL = login('tl.alpha@gmail.com'), TL2 = login('tl.bravo@gmail.com');
  const call = (tok, o) => s.call(Object.assign({ token: tok }, o));
  // directory: admin only, never in the normal data call
  eq(call(TL.token, { action: 'directory' }).error, 'forbidden', 'TL cannot open directory');
  ok(!('directory' in data(A.token)), 'directory is not part of the normal data payload');
  let d = call(A.token, { action: 'directory' }); ok(d.ok && d.directory.length === 20, 'directory lists everyone (' + (d.directory || []).length + ')');
  const row = d.directory.find(x => x.emp_code === 'DEMO01'); eq(row.leader_name, 'Asha Rao', 'reporting manager comes from the team leader');
  const good = { full_name: 'Rahul Verma', dob: '1995-03-14', gender: 'male', marital_status: 'Single', blood_group: 'B+', father_name: 'A', mother_name: 'B', emergency_name: 'C', emergency_phone: '+91 98765 43210', address: '12 MG Road, Mumbai', mobile: '9123456780', email: 'Rahul@Gmail.com', pan: 'abcde1234f', aadhaar: '2345 6789 0123', bank_name: 'HDFC Bank', account_holder: 'Rahul Verma', account_no: '50100123456789', ifsc: 'hdfc0001234', bank_branch: 'Andheri', designation: 'Telecaller', salary: '₹22,000' };
  let r2 = call(A.token, { action: 'dir_save', emp_code: 'DEMO01', fields: good, status: 'PROBATION', join_date: '2025-03-01' }); ok(r2.ok, 'directory save works: ' + r2.message);
  d = call(A.token, { action: 'directory' }); const sv = d.directory.find(x => x.emp_code === 'DEMO01');
  eq([sv.pan, sv.aadhaar, sv.ifsc, sv.mobile, sv.emergency_phone, sv.gender, sv.salary, sv.status, sv.email], ['ABCDE1234F', '234567890123', 'HDFC0001234', '9123456780', '9876543210', 'Male', 22000, 'PROBATION', 'rahul@gmail.com'], 'values cleaned and saved');
  ok(data(A.token).employees.find(x => x.emp_code === 'DEMO01').status === 'PROBATION', 'probation still counts in the employee list');
  [['pan', 'ABC123'], ['aadhaar', '123'], ['ifsc', 'XYZ'], ['mobile', '12345'], ['dob', '2030-01-01'], ['gender', 'robot'], ['account_no', '12'], ['salary', '-5']].forEach(([k, v]) => {
    const rr = call(A.token, { action: 'dir_save', emp_code: 'DEMO01', fields: Object.assign({}, good, { [k]: v }) }); eq(rr.error, 'invalid', 'bad ' + k + ' rejected');
  });
  r2 = call(A.token, { action: 'dir_save', emp_code: 'DEMO01', fields: Object.assign({}, good, { address: '=IMPORTXML("x")' }) }); d = call(A.token, { action: 'directory' });
  ok(d.directory.find(x => x.emp_code === 'DEMO01').address.charAt(0) === "'", 'formula in address is neutralised');
  r2 = call(A.token, { action: 'dir_save', emp_code: 'DEMO02', fields: {}, status: 'LEFT' }); d = call(A.token, { action: 'directory' });
  eq(d.directory.find(x => x.emp_code === 'DEMO02').exit_date, '2026-10-27', 'LEFT fills exit date with today');
  r2 = call(A.token, { action: 'dir_save', emp_code: 'DEMO02', fields: {}, status: 'ACTIVE' }); ok(r2.ok && call(A.token, { action: 'directory' }).directory.find(x => x.emp_code === 'DEMO02').exit_date === '', 'back to ACTIVE clears exit date');
  eq(call(TL.token, { action: 'dir_save', emp_code: 'DEMO01', fields: {} }).error, 'forbidden', 'TL cannot edit directory');
  ok(s.sheet('Audit_Log').getLastRow() >= 3, 'directory opens and saves are logged');
  ok(!JSON.stringify(data(TL.token)).includes('ABCDE1234F') && !JSON.stringify(data(A.token)).includes('ABCDE1234F'), 'PAN never travels in the data call');

  // targets
  eq(call(TL.token, { action: 'target_set', month: '2026-10', items: [] }).error, 'forbidden', 'TL cannot set targets');
  r2 = call(A.token, { action: 'target_set', month: '2026-10', items: [{ scope: 'EMP', id: 'DEMO01', amount: '1600000' }, { scope: 'EMP', id: 'DEMO02', amount: 2000000 }, { scope: 'EMP', id: 'DEMO05', amount: 1000000 }] }); ok(r2.ok, 'targets saved');
  eq(call(A.token, { action: 'target_set', month: '2026-10', items: [{ scope: 'EMP', id: 'NOPE', amount: 1 }] }).error, 'invalid', 'unknown employee target refused');
  eq(call(A.token, { action: 'target_set', month: 'Oct', items: [{ scope: 'EMP', id: 'DEMO01', amount: 1 }] }).error, 'invalid', 'bad month refused');
  let ad2 = data(A.token); eq(ad2.targets.filter(t => t.month === '2026-10' && t.scope === 'EMP').find(t => t.id === 'DEMO01').amount, 1600000, 'each employee has their own target');
  eq(ad2.team_targets.find(t => t.team_id === 'DT1' && t.month === '2026-10'), { team_id: 'DT1', month: '2026-10', amount: 7000000, source: 'sum' }, 'team target = sum of members');
  call(A.token, { action: 'target_set', month: '2026-10', items: [{ scope: 'TEAM', id: 'DT1', amount: 5000000 }] });
  eq(data(A.token).team_targets.find(t => t.team_id === 'DT1' && t.month === '2026-10').source, 'set', 'team override wins');
  call(A.token, { action: 'target_set', month: '2026-10', items: [{ scope: 'EMP', id: 'DEMO01', amount: '' }] });
  ok(!data(A.token).targets.some(t => t.id === 'DEMO01' && t.month === '2026-10' && t.scope === 'EMP'), 'blank clears a target');
  const tdd = data(TL.token); ok(tdd.targets.every(t => t.scope === 'EMP' && /^DEMO0[1-4]$/.test(t.id)), 'TL sees targets of own team only'); ok(tdd.team_targets.length >= 1, 'TL still gets team totals');
  call(A.token, { action: 'target_set', month: '2026-10', items: [{ scope: 'EMP', id: 'DEMO01', amount: 1600000 }] });

  // remarks
  eq(call(TL.token, { action: 'remark_add', emp_code: 'DEMO01', category: 'Dress code', note: 'x' }).error, 'forbidden', 'TL cannot give remarks');
  r2 = call(A.token, { action: 'remark_add', emp_code: 'DEMO01', category: 'Dress code', note: 'Came in shorts' }); ok(r2.ok, 'admin gives remark: ' + JSON.stringify(r2));
  eq(call(A.token, { action: 'remark_add', emp_code: 'DEMO01', category: 'Nonsense', note: 'x' }).error, 'invalid', 'unknown category refused');
  ad2 = data(A.token); eq(ad2.remarks.length, 1, 'remark visible to admin'); eq(ad2.remarks[0].category, 'Dress code', 'category kept');
  ok(!JSON.stringify(data(TL.token)).includes('Came in shorts'), 'remarks never reach TLs');
  call(A.token, { action: 'remark_void', remark_id: r2.remark_id }); eq(data(A.token).remarks.length, 0, 'voided remark disappears but row stays'); ok(s.sheet('Remarks').getLastRow() === 2, 'row kept in sheet');

  // cases
  const cs = data(A.token).cases; ok(cs.length > 10 && cs.every(c => c.date >= '2026-10-14'), 'only last 14 days of cases (' + cs.length + ')');
  r2 = call(TL.token, { action: 'case_add', emp_code: 'DEMO01', customer: 'Test Customer', bank: 'HDFC Bank', amount: 500000, stage: 'login' }); ok(r2.ok, 'TL adds a case for own team');
  eq(call(TL.token, { action: 'case_add', emp_code: 'DEMO09', customer: 'X', bank: 'Y' }).error, 'invalid', 'TL cannot add case for another team');
  const cid = r2.case_id;
  ok(!data(TL2.token).cases.some(c => c.case_id === cid), 'other TL does not see the case');
  r2 = call(TL.token, { action: 'case_stage', case_id: cid, stage: 'PENDING', note: 'Waiting for salary slip' }); ok(r2.ok, 'TL moves stage with a reason');
  eq(call(TL2.token, { action: 'case_stage', case_id: cid, stage: 'DISBURSED' }).error, 'forbidden', 'other TL cannot move it');
  eq(call(TL2.token, { action: 'case_note', case_id: cid, note: 'hi' }).error, 'forbidden', 'other TL cannot note it');
  const after = data(A.token); eq(after.cases.find(c => c.case_id === cid).stage, 'PENDING', 'stage updated'); eq(after.cases.find(c => c.case_id === cid).stage_date, '2026-10-27', 'stage date today');
  eq(after.case_notes.filter(n => n.case_id === cid).length, 1, 'note stored');
  eq(call(A.token, { action: 'case_stage', case_id: cid, stage: 'WEIRD' }).error, 'invalid', 'bad stage refused');

  // devices
  const dev = { id: 'dev-abc-12345', label: 'Android · Chrome 129', mode: 'Installed app', platform: 'Android' };
  s.call({ action: 'login', id_token: s.googleToken('tl.alpha@gmail.com'), device: dev });
  s.call({ action: 'data', token: TL.token, device: dev });
  let dv = data(A.token).devices; const mine = dv.filter(x => x.email === 'tlalpha@gmail.com'); eq(mine.length, 1, 'one device row for that phone'); eq([mine[0].device, mine[0].mode], ['Android · Chrome 129', 'Installed app'], 'device and app recorded');
  s.call({ action: 'login', id_token: s.googleToken('tl.alpha@gmail.com'), device: dev }); ok(data(A.token).devices.find(x => x.email === 'tlalpha@gmail.com').sign_ins >= 2, 'sign-ins counted');
  eq(data(TL.token).devices, [], 'TL cannot see devices');
  s.call({ action: 'data', token: TL.token, device: { id: '../bad', label: 'x' } }); eq(data(A.token).devices.length, dv.length, 'bad device id ignored');
}

console.log('6. revoke is immediate');
r = s.call({ action: 'access_revoke', token: a.token, email: 'tl.alpha@gmail.com' }); ok(r.ok, 'revoked');
eq(data(tl.token).error, 'auth', 'revoked TL is cut off on the very next request');
eq(login('tl.alpha@gmail.com').error, 'not_allowed', 'revoked TL cannot sign in again');
r = s.call({ action: 'access_set', token: a.token, email: 'tl.alpha@gmail.com', role: 'TL', team_id: 'DT3' }); ok(r.ok, 're-grant to a different team');
eq(login('tl.alpha@gmail.com').user.team_id, 'DT3', 'now sees DT3 instead');
eq(s.sheet('Access').getLastRow(), 4, 're-grant reuses the row (no duplicate)');

console.log('7. admin safety rails');
eq(s.call({ action: 'access_revoke', token: a.token, email: 'owner@gmail.com' }).error, 'invalid', 'cannot revoke yourself');
eq(s.call({ action: 'access_set', token: a.token, email: 'owner@gmail.com', role: 'TL', team_id: 'DT1' }).error, 'invalid', 'cannot demote yourself');
eq(s.call({ action: 'access_set', token: a.token, email: 'not-an-email', role: 'ADMIN' }).error, 'invalid', 'bad email refused');
eq(s.call({ action: 'access_set', token: a.token, email: 'z@gmail.com', role: 'TL', team_id: 'NOPE' }).error, 'invalid', 'TL for a missing team refused');
eq(s.call({ action: 'access_set', token: a.token, email: 'z@gmail.com', role: 'BOSS' }).error, 'invalid', 'bad role refused');
eq(s.call({ action: 'access_revoke', token: a.token, email: 'nobody@gmail.com' }).error, 'invalid', 'revoking unknown email says so');
r = s.call({ action: 'access_set', token: a.token, email: 'second.admin@gmail.com', role: 'ADMIN' }); ok(r.ok, 'second admin added');
ok(login('second.admin@gmail.com').user.role === 'ADMIN', 'second admin can sign in');

console.log('8. staff and teams');
r = s.call({ action: 'staff_add', token: a.token, emp_code: 'EMP900', name: 'New Person', team_id: 'DT2' }); ok(r.ok, 'add telecaller');
eq(s.call({ action: 'staff_add', token: a.token, emp_code: 'emp900', name: 'Dup', team_id: 'DT2' }).error, 'invalid', 'duplicate code (any case) refused');
eq(s.call({ action: 'staff_add', token: a.token, emp_code: 'EMP901', name: '  ', team_id: 'DT2' }).error, 'invalid', 'blank name refused');
eq(s.call({ action: 'staff_add', token: a.token, emp_code: 'EMP901', name: 'X', team_id: 'ZZ' }).error, 'invalid', 'missing team refused');
eq(s.call({ action: 'staff_add', token: a.token, emp_code: 'A|B', name: 'X', team_id: 'DT1' }).error, 'invalid', 'code with | refused');
r = s.call({ action: 'staff_add', token: a.token, emp_code: 'EMP902', name: '=HYPERLINK("http://evil","x")', team_id: 'DT1' }); ok(r.ok, 'formula-looking name accepted but defanged');
const emps = s.sheet('Employees'); const lastName = emps.get(emps.getLastRow(), 2); ok(lastName.startsWith("'="), 'stored with a leading apostrophe: ' + lastName);
eq(emps.get(emps.getLastRow() - 1, 5), 'DEMOTL2', 'new telecaller linked to the team leader code');
r = s.call({ action: 'team_add', token: a.token, team_name: 'Echo', leader_name: 'Esha K' }); ok(r.ok && r.team_id === 'DT5' || r.team_id === 'T5', 'team added: ' + r.team_id);
eq(s.call({ action: 'team_add', token: a.token, team_name: 'echo', leader_name: 'Z' }).error, 'invalid', 'duplicate team name refused');
// removal keeps history
const beforeRows = data(a.token).kpi.filter(k => k.emp_code === 'DEMO01').length;
r = s.call({ action: 'staff_remove', token: a.token, emp_code: 'DEMO01' }); ok(r.ok, 'remove telecaller');
const after = data(a.token); eq(after.employees.find(e => e.emp_code === 'DEMO01').status, 'LEFT', 'marked LEFT');
eq(after.kpi.filter(k => k.emp_code === 'DEMO01').length, beforeRows, 'their history rows are still sent');
ok(!!after.employees.find(e => e.emp_code === 'DEMO01').exit_date, 'exit date set');
eq(s.call({ action: 'staff_remove', token: a.token, emp_code: 'DEMOTL1' }).error, 'invalid', 'cannot remove a team leader row here');
eq(after.teams.find(t => t.team_id === 'DT1').size, 4, 'team size: 4 originally, +1 added (EMP902), -1 removed (DEMO01)');

console.log('9. messy sheet input');
const att = s.sheet('Attendance'), kp = s.sheet('KPI_MIS'), cl = s.sheet('Calls_MIS');
let n = att.getLastRow() + 1;
att.set(n, 1, '27/10/2026'); att.set(n, 2, 'EMP902'); att.set(n, 3, 'p'); att.set(n, 4, new Date(Date.UTC(1899, 11, 30, 4, 30)));   // text date (Indian style), lowercase status, time-only cell
n = kp.getLastRow() + 1; kp.set(n, 1, new Date('2026-10-26T00:00:00+05:30')); kp.set(n, 2, 'EMP902'); kp.set(n, 3, '3'); kp.set(n, 7, 2); kp.set(n, 8, '₹4,50,000');
const d2 = data(a.token);
const a902 = d2.attendance.find(x => x.emp_code === 'EMP902'); eq(a902 && [a902.date, a902.status], ['2026-10-27', 'P'], 'dd/mm/yyyy text date and lowercase p understood');
ok(a902.in_time === 'TIME' || typeof a902.in_time === 'string', 'time-only cell did not crash');
const k902 = d2.kpi.find(x => x.emp_code === 'EMP902'); eq(k902.date, '2026-10-26', 'Date object read as the right IST day');
const dayRow = d2.kpi.find(x => x.emp_code === 'EMP902');
const adminAgain = s.call({ action: 'data', token: a.token }); ok(!adminAgain.error, 'messy data does not break the feed');
// numbers with currency symbol and commas land as a number in team totals (checked via a TL of that team)
r = s.call({ action: 'access_set', token: a.token, email: 'tl.charlie@gmail.com', role: 'TL', team_id: 'DT1' });
const tl1 = data(login('tl.charlie@gmail.com').token); const tdRow = tl1.team_daily.find(x => x.team_id === 'DT1' && x.date === '2026-10-26');
ok(tdRow && tdRow.disbursed_amount >= 450000, 'amount typed as "₹4,50,000" counted as 450000 in team totals (' + (tdRow && tdRow.disbursed_amount) + ')');
// numbers but no attendance row => counted as present; absent employee's numbers ignored
const absentCode = 'DEMO02'; n = att.getLastRow() + 1; att.set(n, 1, '2026-10-27'); att.set(n, 2, absentCode); att.set(n, 3, 'A'); att.set(n, 4, '');
n = kp.getLastRow() + 1; kp.set(n, 1, '2026-10-27'); kp.set(n, 2, absentCode); kp.set(n, 3, 99); kp.set(n, 7, 0);
const dd = data(login('tl.charlie@gmail.com').token).team_daily.find(x => x.team_id === 'DT1' && x.date === '2026-10-27');
ok(dd.logins < 99, 'numbers from someone marked Absent are ignored');

console.log('10. efficiency timer');
const logRows = () => s.sheet('Efficiency_Log').getLastRow() - 1;
s.sandbox.logEfficiency(); eq(logRows(), 1 + 4, 'one BRANCH row + one per team that has data (' + logRows() + ')');
const first = s.sheet('Efficiency_Log').getRange(2, 1, 1, 8).getValues()[0]; eq(first[0], '2026-10-27 10:30', 'timestamp is IST text'); eq(first[1], 'BRANCH', 'first scope is BRANCH');
ok(first[7] >= 0 && first[7] <= 100, 'score in range ' + first[7]);
s.setNow('2026-10-27T22:00:00+05:30'); const before = logRows(); s.sandbox.logEfficiency(); eq(logRows(), before, 'nothing logged after the shift ends');
s.setNow('2026-11-01T11:00:00+05:30'); s.sandbox.logEfficiency(); eq(logRows(), before, 'nothing logged on a Sunday');
s.setNow('2026-10-27T10:40:00+05:30'); s.sandbox.logEfficiency(); ok(logRows() > before, 'logs again on the next 10-minute tick');
const effAdmin = data(a.token).efficiency_log; ok(effAdmin.some(x => x.scope === 'BRANCH'), 'admin sees BRANCH log');
const effTl = tl1.efficiency_log; ok(effTl.length === 0 || effTl.every(x => x.scope === 'DT1'), 'TL log limited to own team');
const effTl2 = data(login('tl.charlie@gmail.com').token).efficiency_log; ok(effTl2.length > 0 && effTl2.every(x => x.scope === 'DT1'), 'TL log (fresh) only own team, ' + effTl2.length + ' rows');
// cleanup removes old rows only
const lg = s.sheet('Efficiency_Log'); lg.cells.splice(1, 0, ['2026-09-01 10:10', 'BRANCH', 1, 2, 3, 4, 5, 6]);
s.setNow('2026-10-27T01:00:00+05:30'); const pre = lg.getLastRow(); s.sandbox.dailyCleanup(); eq(lg.getLastRow(), pre - 1, 'nightly cleanup deletes only rows older than 14 days');

console.log('11. clear demo data');
s.sandbox.clearDemoData();
ok(![...Array(s.sheet('Employees').getLastRow()).keys()].some(i => String(s.sheet('Employees').get(i + 1, 1)).startsWith('DEMO')), 'no DEMO employees left');
ok(s.sheet('Employees').getLastRow() > 1, 'real rows (EMP900 etc.) survived');

console.log('14. backend sheet sync');
{
  const g = makeServer(); g.sandbox.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com'; g.sandbox.setup();
  const E = (code, name, team, role, lead) => g.sandbox.appendObj_('Employees', { emp_code: code, name, team_id: team, team_name: 'Team ' + team, leader_code: lead, role, status: 'ACTIVE', join_date: '2025-01-01' });
  E('TL1', 'Abhishek Rao', 'A', 'TL', ''); E('TL2', 'Sahil Khan', 'B', 'TL', ''); E('TL3', 'Nitin Joshi', 'C', 'TL', ''); E('TL4', 'Pradnya More', 'D', 'TL', '');
  E('E01', 'Abhishek Pawar', 'A', 'TELECALLER', 'TL1'); E('E02', 'Pritam Das', 'A', 'TELECALLER', 'TL1'); E('E03', 'Aaryan Sharma', 'B', 'TELECALLER', 'TL2');
  E('E04', 'Riya Shah', 'C', 'TELECALLER', 'TL3'); E('E05', 'Riya Mehta', 'D', 'TELECALLER', 'TL4'); E('E06', 'Soni Patel', 'B', 'TELECALLER', 'TL2');
  g.sandbox.appendObj_('Access', { email: 'owner@gmail.com', name: 'Owner', role: 'ADMIN', status: 'ACTIVE', added_on: '2026-10-01' });
  g.sandbox.appendObj_('Access', { email: 'tl.a@gmail.com', name: 'Abhishek Rao', role: 'TL', team_id: 'A', status: 'ACTIVE', added_on: '2026-10-01' });
  // the backend team's own sheet, laid out like their screenshot
  const bk = g.sandbox.SpreadsheetApp.create('Backend entries'), sh = bk.getSheetByName('Sheet1'); sh.maxRows = 3000;
  const D = x => new Date(x + 'T00:00:00+05:30');
  const rows = [
    ['Date', 'TL Name', 'TC Name', 'Customer Name', 'Number', 'Rm/code', 'Stage', 'Amount', 'Bank Name', 'Location'],
    [D('2026-10-26'), 'Abhishek', 'Abhishek', 'Rambabu', 0, 'Kunjal', 'Approved For Disbursal', 615000, 'Idfc', 'Madurai'],
    [D('2026-10-26'), 'Abhishek', 'Abhishek', 'Rambabu', 0, 'Kunjal', 'Approved For Disbursal', 370000, 'Idfc', 'Madurai'],
    [D('2026-10-26'), 'Abhishek', 'Pritam', 'Sagar wankhade', 0, 'Daya', 'Rejected', 'Not eligible for a loan. Based on bank statement analysis.', 'Incred', 'Pune'],
    [D('2026-10-26'), 'Nitin', 'Riya', 'Dimple Jain', 0, 'Kunjal', 'Rejected', 'Application previously rejected to be declined', 'Idfc', 'Mumbai'],
    [D('2026-10-26'), 'Pradnya', 'Riya', 'Mashala shaik', 0, 'Daya', 'Customer NI', 'Consent', 'Idfc', 'Kurnool'],
    [D('2026-10-26'), 'Sahil', 'Soni', 'Nikhil kumar', 0, 'Kunjal', 'Customer NI', 'Consent', 'Idfc', 'Hyderabad'],
    ['10/26/2026', 'Sahil', 'Aaryan', 'Typed Date Person', 0, 'Smitha', 'Rejected', 'Cheque bounce', 'Kotak', 'Chennai'],
    [D('2026-10-27'), 'Abhishek', 'Pritam', 'Ali hossen', 0, 'Kunjal', 'Disbursed', 400000, 'Idfc', 'Chennai'],
    [D('2025-09-02'), 'Abhishek', 'Abhishek', 'Very Old', 0, 'Kunjal', 'Rejected', 'old', 'Idfc', 'Delhi'],
    ['not a date', 'Sahil', 'Aaryan', 'Bad Date Person', 0, 'Kunjal', 'Rejected', 'x', 'Idfc', 'Delhi'],
    [D('2026-10-27'), 'Sahil', 'Zzz Nobody', 'Ghost', 0, 'Kunjal', 'Pending', 100000, 'Idfc', 'Delhi']
  ];
  rows.forEach((r, i) => r.forEach((v, j) => sh.set(i + 1, j + 1, v)));
  const A = g.call({ action: 'login', id_token: g.googleToken('owner@gmail.com') }), TLt = g.call({ action: 'login', id_token: g.googleToken('tl.a@gmail.com') });
  eq(g.call({ action: 'sync_backend', token: A.token }).error, 'backend', 'sync refuses until the backend sheet is connected');
  g.sandbox.BACKEND_SHEET_ID = 'nope'; const bad = g.call({ action: 'sync_backend', token: A.token }); ok(bad.error === 'backend' && /Viewer/.test(bad.message), 'unreachable backend sheet gives the "share it as Viewer" message');
  g.sandbox.BACKEND_SHEET_ID = bk.getId();
  eq(g.call({ action: 'sync_backend', token: TLt.token }).error, 'forbidden', 'a team leader cannot trigger the sync');
  const r1 = g.call({ action: 'sync_backend', token: A.token }); ok(r1.ok, 'admin sync works: ' + (r1.message || r1.error));
  const sy = g.call({ action: 'data', token: A.token }); const sum = sy.sync;
  eq([sum.rows, sum.imported, sum.unmatched], [9, 8, 1], 'rows read, cases imported, rows that could not be matched ("Soni" finds Soni Patel; "Zzz Nobody" is unknown)');
  const cs = sy.cases, by = n => cs.find(c => c.customer === n);
  eq(cs.length, 8, 'eight cases imported');
  eq([by('Rambabu').stage, by('Rambabu').amount, by('Rambabu').rm, by('Rambabu').location], ['APPROVED', 615000, 'Kunjal', 'Madurai'], '"Approved For Disbursal" is approved, not disbursed; amount, RM and location kept');
  eq(cs.filter(c => c.customer === 'Rambabu').length, 2, 'two identical-looking rows stay two cases');
  eq([by('Sagar wankhade').stage, by('Sagar wankhade').emp_code, by('Sagar wankhade').reason.slice(0, 12)], ['REJECTED', 'E02', 'Not eligible'], 'rejection reason from the Amount column is kept as the reason');
  eq(by('Dimple Jain').emp_code, 'E04', 'Riya under TL Nitin is Riya Shah'); eq(by('Mashala shaik').emp_code, 'E05', 'Riya under TL Pradnya is Riya Mehta');
  eq([by('Mashala shaik').stage, by('Mashala shaik').reason], ['NOT_INTERESTED', 'Consent'], 'Customer NI becomes Not interested');
  eq(by('Typed Date Person').date, '2026-10-26', 'typed text date read as month/day/year');
  eq(by('Ali hossen').stage, 'DISBURSED', 'a "Disbursed" stage is disbursed');
  ok(!cs.some(c => c.customer === 'Very Old'), 'rows older than the window are skipped');
  const iss = g.sheet('Import_Issues'); const itxt = []; for (let r = 2; r <= iss.getLastRow(); r++) itxt.push(iss.getRange(r, 2, 1, 7).getValues()[0].join(' | '));
  ok(itxt.some(x => /Bad date/.test(x) && /not a date/.test(x)) && itxt.some(x => /Name not matched/.test(x) && /Zzz Nobody/.test(x)), 'problems are listed in Import_Issues: ' + itxt.length);
  const kp = d => { const k = g.sheet('KPI_MIS'); const out = []; for (let r = 2; r <= k.getLastRow(); r++) { const v = k.getRange(r, 1, 1, 10).getValues()[0]; out.push(v); } return out; };
  const K = kp(), kf = (emp, day) => { const v = K.find(r => r[1] === emp && String(r[0]).slice(0, 10) === day); return v && { logins: v[2], approved: v[3], rejected: v[4], pending: v[5], disbursed: v[6], amt: v[7], ni: v[8], src: v[9] }; };
  eq(kf('E01', '2026-10-26'), { logins: 2, approved: 2, rejected: 0, pending: 0, disbursed: 0, amt: 0, ni: 0, src: 'BACKEND' }, 'login counts per person per day');
  eq(kf('E02', '2026-10-27'), { logins: 1, approved: 1, rejected: 0, pending: 0, disbursed: 1, amt: 400000, ni: 0, src: 'BACKEND' }, 'a disbursed case counts as approved and adds its amount');
  eq(kf('E05', '2026-10-26'), { logins: 1, approved: 0, rejected: 1, pending: 0, disbursed: 0, amt: 0, ni: 1, src: 'BACKEND' }, 'Customer NI counts as a rejected login and as not interested');
  // the app now shows them
  const adata = g.call({ action: 'data', token: A.token }); ok(adata.kpi.some(r => r.emp_code === 'E01' && r.logins === 2), 'logins reach the app data (so the efficiency score uses them)');
  const tdata = g.call({ action: 'data', token: TLt.token }); ok(tdata.cases.length === 4 && tdata.cases.every(c => ['E01', 'E02'].includes(c.emp_code)), 'team leader sees only their own team’s cases'); eq(tdata.sync, null, 'sync status is for admins only');
  // running it again changes nothing
  g.call({ action: 'sync_backend', token: A.token }); eq(g.call({ action: 'data', token: A.token }).cases.length, 8, 'syncing twice does not duplicate cases'); eq(kp().length, K.length, 'syncing twice does not duplicate KPI rows');
  // a manual case and a note survive; a stage change in the backend sheet is picked up
  const man = g.call({ action: 'case_add', token: A.token, emp_code: 'E01', customer: 'Manual Person', bank: 'HDFC', stage: 'LOGIN' }); ok(man.ok, 'manual case added');
  const rid = by('Sagar wankhade').case_id; g.call({ action: 'case_note', token: A.token, case_id: rid, note: 'asked Pritam' });
  sh.set(4, 7, 'Disbursed'); sh.set(4, 8, 250000); g.setNow('2026-10-27T11:00:00+05:30');
  g.call({ action: 'sync_backend', token: A.token }); const d2 = g.call({ action: 'data', token: A.token });
  ok(d2.cases.some(c => c.customer === 'Manual Person' && !c.source), 'a case added by hand in the app is kept'); ok(d2.cases.length === 9, 'eight backend cases plus the manual one');
  const ch = d2.cases.find(c => c.case_id === rid); eq([ch.stage, ch.stage_date], ['DISBURSED', '2026-10-27'], 'a stage change in the backend sheet updates the case and restarts its stuck clock');
  ok(d2.case_notes.some(n => n.case_id === rid), 'notes written in the app stay attached to the case');
  // fixing a name with Name_Map
  g.sandbox.appendObj_('Name_Map', { tc_name: 'Zzz Nobody', tl_name: 'Sahil', emp_code: 'E06' });
  g.call({ action: 'sync_backend', token: A.token }); const d3 = g.call({ action: 'data', token: A.token }); eq(d3.sync.unmatched, 0, 'Name_Map fixes a name');
  ok(d3.cases.some(c => c.customer === 'Ghost' && c.emp_code === 'E06'), 'the fixed row is now imported');
  // the backend team edits a customer name: no orphan left behind
  sh.set(2, 4, 'Rambabu K'); g.call({ action: 'sync_backend', token: A.token }); const d4 = g.call({ action: 'data', token: A.token });
  ok(d4.cases.filter(c => /^Rambabu/.test(c.customer)).length === 2 && d4.cases.some(c => c.customer === 'Rambabu K'), 'renaming a customer replaces the old row');
  // the timer never throws, even when the backend sheet vanishes
  g.sandbox.BACKEND_SHEET_ID = 'gone'; g.sandbox.syncBackend(); ok(/Viewer/.test(g.call({ action: 'data', token: A.token }).sync.error), 'timer stores a clear error instead of crashing');
  g.sandbox.BACKEND_SHEET_ID = bk.getId();
}

console.log('14b. matching by employee ID and the ready-made backend sheet');
{
  const g = makeServer(); g.sandbox.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com'; g.sandbox.setup();
  const E = (code, name, team, role, status = 'ACTIVE') => g.sandbox.appendObj_('Employees', { emp_code: code, name, team_id: team, team_name: 'Team ' + team, leader_code: '', role, status, join_date: '2025-01-01' });
  E('TL1', 'Abhishek Rao', 'A', 'TL'); E('TL2', 'Sahil Khan', 'B', 'TL');
  E('E01', 'Abhishek Pawar', 'A', 'TELECALLER'); E('E02', 'Pritam Das', 'A', 'TELECALLER'); E('E05', 'Riya Mehta', 'B', 'TELECALLER'); E('E09', 'Old Timer', 'B', 'TELECALLER', 'LEFT');
  g.sandbox.appendObj_('Access', { email: 'owner@gmail.com', name: 'Owner', role: 'ADMIN', status: 'ACTIVE', added_on: '2026-10-01' });
  const A = g.call({ action: 'login', id_token: g.googleToken('owner@gmail.com') });
  eq(g.call({ action: 'data', token: A.token }).sync_on, false, 'not connected before the template is made');
  const t = g.sandbox.createBackendTemplate(); ok(t.created && t.id && t.url, 'createBackendTemplate makes a sheet');
  const tss = g.sandbox.SpreadsheetApp.openById(t.id), ent = tss.getSheetByName('Entries'), tc = tss.getSheetByName('Telecallers');
  eq(ent.getRange(1, 1, 1, 11).getValues()[0], ['Date', 'TC Emp ID', 'TC Name', 'TL Name', 'Customer Name', 'Number', 'Rm/code', 'Stage', 'Amount', 'Bank Name', 'Location'], 'the headings are made');
  eq(tc.getRange(1, 1, 4, 3).getValues().map(r => r.join('|')), ['Emp ID|Name|TL Name', 'E01|Abhishek Pawar|Abhishek Rao', 'E02|Pritam Das|Abhishek Rao', 'E05|Riya Mehta|Sahil Khan'], 'telecaller list copied (leavers left out)');
  ok(/ARRAYFORMULA/.test(ent.getRange(2, 3, 1, 1).getValues()[0][0]) && /ARRAYFORMULA/.test(ent.getRange(2, 4, 1, 1).getValues()[0][0]), 'TC name and TL name fill in from the Emp ID');
  eq(g.props.BACKEND_SHEET_ID, t.id, 'the new sheet is connected automatically'); eq(g.sandbox.createBackendTemplate().created, false, 'running it again does not make a second sheet');
  eq(g.call({ action: 'data', token: A.token }).sync_on, true, 'the app knows it is connected');
  const D = x => new Date(x + 'T00:00:00+05:30'); let r = 2;
  const put = row => { row.forEach((v, j) => ent.set(r, j + 1, v)); r++; };
  //   date, id, name, tl, customer, number, rm, stage, amount, bank, location
  put([D('2026-10-26'), 'E05', 'Riya Mehta', 'Sahil Khan', 'Cust One', '', 'Daya', 'Approved For Disbursal', 300000, 'Idfc', 'Pune']);
  put([D('2026-10-26'), 'ZZ9', '', '', 'Cust Two', '', 'Daya', 'Rejected', 'bad', 'Idfc', 'Pune']);
  put([D('2026-10-26'), '', 'Pritam Das', 'Abhishek', 'Cust Three', '', 'Kunjal', 'Pending', 0, 'Axis', 'Delhi']);
  put([D('2026-10-26'), 'e01', 'Totally Different', '', 'Cust Four', '', 'Kunjal', 'Disbursed', 500000, 'Axis', 'Delhi']);
  const res = g.call({ action: 'sync_backend', token: A.token }); ok(res.ok, 'sync from the made sheet: ' + (res.message || res.error));
  const d = g.call({ action: 'data', token: A.token }), by = n => d.cases.find(c => c.customer === n);
  eq([by('Cust One').emp_code, by('Cust Three').emp_code, by('Cust Four').emp_code], ['E05', 'E02', 'E01'], 'matched by ID, by name when the ID is blank, and the ID wins over a wrong name (lower case id accepted)');
  ok(!by('Cust Two'), 'an unknown Emp ID is not guessed'); eq(d.sync.unmatched, 1, 'and is counted as a problem');
  const iss = g.sheet('Import_Issues'); const txt = []; for (let x = 2; x <= iss.getLastRow(); x++) txt.push(iss.getRange(x, 2, 1, 7).getValues()[0].join(' | '));
  ok(txt.some(x => /ZZ9/.test(x) && /Check the ID/.test(x)) && txt.some(x => /Check TL/.test(x) && /Totally Different/.test(x)), 'issues explain the unknown ID and the name that disagrees with the ID: ' + txt.length);
  // a new joiner appears in the list by itself
  E('E10', 'New Joiner', 'A', 'TELECALLER'); g.call({ action: 'sync_backend', token: A.token });
  ok(tc.getRange(2, 1, 6, 1).getValues().flat().includes('E10'), 'a new telecaller shows up in the drop-down list after the next sync');
  // a sheet that only has Emp ID (no TC Name column) still works
  const b2 = g.sandbox.SpreadsheetApp.create('Other'); const s2 = b2.getSheetByName('Sheet1'); s2.maxRows = 100;
  [['Date', 'Emp ID', 'Customer Name', 'Stage', 'Amount', 'Bank Name'], [D('2026-10-26'), 'E02', 'Only ID', 'Rejected', 'Policy reject', 'Kotak']].forEach((row, i) => row.forEach((v, j) => s2.set(i + 1, j + 1, v)));
  g.sandbox.BACKEND_SHEET_ID = b2.getId(); g.call({ action: 'sync_backend', token: A.token }); ok(g.call({ action: 'data', token: A.token }).cases.some(c => c.customer === 'Only ID' && c.emp_code === 'E02' && c.reason === 'Policy reject'), 'works with only an Emp ID column');
}

console.log('12. empty sheet');
const e = makeServer(); e.sandbox.GOOGLE_CLIENT_ID = CID; e.sandbox.setup();
const ea = e.call({ action: 'login', id_token: e.googleToken('owner@gmail.com') }); ok(ea.ok, 'admin can sign in to an empty sheet');
const ed = e.call({ action: 'data', token: ea.token }); ok(!ed.error && ed.employees.length === 0 && ed.teams.length === 0, 'empty sheet returns empty data, not an error');
const nothing = makeServer(); nothing.sandbox.GOOGLE_CLIENT_ID = CID;
eq(nothing.call({ action: 'data', token: 'x.y' }).error ? 'err' : 'bad', 'err', 'before setup, requests fail cleanly');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
