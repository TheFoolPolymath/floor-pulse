/**
 * Mock data generator for Floor Pulse.
 *   node tools/make-mock.js
 * Writes:
 *   public/data/mock.json        what the app loads in demo mode (no Google sign-in needed)
 * 20 telecallers, 4 teams, 4 team leaders, 7 working days (20-27 Oct 2026),
 * today (27 Oct) is partial, frozen at 15:30 IST, with a 10-minute efficiency log.
 */
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..', 'public', 'data');
fs.mkdirSync(OUT, { recursive: true });

function mul(s) { return function () { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mul(20261027);

const PL = 2, PC = 250, CONN_BM = 0.40, DISB_BM = 0.30, START = 600, END = 1140, ASOF = 930; // 15:30
const DAYS = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27'];
const TODAY = DAYS[DAYS.length - 1];

const TEAMS = [['T1', 'Abhishek', 'EMP101', 'Abhishek Rao'], ['T2', 'Neha', 'EMP102', 'Neha Kulkarni'], ['T3', 'Imran', 'EMP103', 'Imran Shaikh'], ['T4', 'Pooja', 'EMP104', 'Pooja Nair']];
const NAMES = [
  'Rahul Verma', 'Sana Khan', 'Karan Mehta', 'Divya Iyer', 'Amit Patil',
  'Riya Shah', 'Tanvi Desai', 'Mohit Gupta', 'Farah Ansari', 'Suresh Yadav',
  'Kavya Menon', 'Nikhil Pawar', 'Aarav Singh', 'Zoya Qureshi', 'Rohan Kale',
  'Meera Reddy', 'Sameer Sayyed', 'Anjali Das', 'Harsh Trivedi', 'Pallavi More'];
// story tweaks so the dashboard has something to show
const TWEAK = {
  EMP001: { skill: 1.22, slope: 0.07 },   // Rahul: star, improving
  EMP005: { skill: 0.72, slope: -0.06 },  // Amit: slipping
  EMP008: { att: 0.55 },                  // Mohit: many absences
  EMP012: { cr: 0.27 },                   // Nikhil: low connect rate
  EMP014: { skill: 1.15, slope: 0.04 },
  EMP017: { att: 0.62 },
  EMP019: { skill: 0.7, slope: 0.05 },    // Harsh: weak but rising
};
const TEAM_BIAS = [1.0, 1.08, 0.92, 1.02];

const employees = [];
TEAMS.forEach((t, i) => employees.push({ emp_code: t[2], name: t[3], team_id: t[0], team_name: t[1], leader_code: '', role: 'TL', status: 'ACTIVE', join_date: '2025-02-01', exit_date: '' }));
const tele = NAMES.map((n, k) => {
  const ti = Math.floor(k / 5), code = 'EMP' + String(k + 1).padStart(3, '0');
  const tw = TWEAK[code] || {};
  const p = {
    code, name: n, team: ti,
    skill: tw.skill || (0.7 + rnd() * 0.5) * TEAM_BIAS[ti],
    att: tw.att || 0.88 + rnd() * 0.1,
    cr: tw.cr || 0.31 + rnd() * 0.15,
    avg: 1.9 + rnd() * 1.7,
    ph: 0.85 + rnd() * 0.45,
    slope: tw.slope != null ? tw.slope : (rnd() - 0.5) * 0.05,
    apr: 0.45 + rnd() * 0.2,
  };
  employees.push({ emp_code: code, name: n, team_id: TEAMS[ti][0], team_name: TEAMS[ti][1], leader_code: TEAMS[ti][2], role: 'TELECALLER', status: 'ACTIVE', join_date: '2025-' + String(1 + (k % 9)).padStart(2, '0') + '-' + String(3 + k).padStart(2, '0'), exit_date: '' });
  return p;
});
employees.push({ emp_code: 'EMP099', name: 'Vishal Naik', team_id: 'T2', team_name: 'Neha', leader_code: 'EMP102', role: 'TELECALLER', status: 'LEFT', join_date: '2025-01-05', exit_date: '2026-09-30' });

const attendance = [], kpi = [], calls = [];
const full = {};   // code -> [{...final day stats} | null]
tele.forEach(p => {
  full[p.code] = DAYS.map((d, k) => {
    const u = rnd();
    let st = u < p.att ? 'P' : (u < p.att + (1 - p.att) * 0.5 ? 'L' : 'A');
    if (k === DAYS.length - 1 && ['EMP008', 'EMP017', 'EMP010'].includes(p.code)) st = p.code === 'EMP010' ? 'L' : 'A';
    if (k === DAYS.length - 1 && ['EMP001', 'EMP014'].includes(p.code)) st = 'P';
    if (st !== 'P') return { st };
    const m = Math.max(0.5, 1 + p.slope * (k - 3) / 3);
    const cl = Math.round(PC * p.skill * m * (0.85 + 0.3 * rnd()));
    const cn = Math.round(cl * p.cr * (0.9 + 0.2 * rnd()));
    const mins = Math.round(cn * p.avg * (0.9 + 0.2 * rnd()));
    const lg = Math.round(PL * p.skill * m * (0.7 + 0.6 * rnd()));
    const ni = Math.round(cn * (0.35 + 0.15 * rnd()));
    const pn = Math.round(lg * Math.max(0.05, 0.4 - (DAYS.length - 1 - k) * 0.06));
    const ap = Math.round((lg - pn) * p.apr);
    const ds = Math.round(ap * 0.55 * (0.8 + 0.4 * rnd()));
    let amt = 0; for (let q = 0; q < ds; q++) amt += Math.round((90000 + rnd() * 460000) / 1000) * 1000;   // Rs 0.9 to 5.5 lakh per case
    return { st, calls: cl, conn: cn, mins, logins: lg, appr: ap, rej: lg - pn - ap, pend: pn, disb: ds, amt, ni };
  });
});

// value of a final stat at fraction f of the day (today only)
const at = (p, x, f) => Math.round(x * Math.pow(f, p.ph));
const frac = m => Math.max(0, Math.min(1, (m - START) / (END - START)));
function stats(p, k, f) {
  const r = full[p.code][k];
  if (r.st !== 'P') return null;
  if (k < DAYS.length - 1) return r;
  const o = { st: 'P' };
  ['calls', 'conn', 'mins', 'logins', 'appr', 'rej', 'pend', 'disb', 'amt', 'ni'].forEach(key => { o[key] = at(p, r[key], f); });
  return o;
}

tele.forEach(p => DAYS.forEach((d, k) => {
  const r = full[p.code][k];
  const inT = r.st === 'P' ? String(9 + Math.floor(rnd() * 2)).padStart(2, '0') + ':' + String(Math.floor(rnd() * 59)).padStart(2, '0') : '';
  attendance.push({ date: d, emp_code: p.code, status: r.st, in_time: inT });
  const s = stats(p, k, frac(ASOF));
  if (!s) return;
  kpi.push({ date: d, emp_code: p.code, logins: s.logins, approved: s.appr, rejected: s.rej, pending: s.pend, disbursed: s.disb, disbursed_amount: Math.round(s.amt / 1000) * 1000, not_interested: s.ni });
  calls.push({ date: d, emp_code: p.code, calls: s.calls, connected: s.conn, talk_seconds: s.mins * 60 });
}));

function scoreOf(a) {
  if (!a.tL) return 0;
  const c = x => Math.min(1, x);
  const rL = a.logins / a.tL, rC = a.calls / a.tC, rN = a.calls ? (a.conn / a.calls) / CONN_BM : 0, rD = a.logins ? (a.disb / a.logins) / DISB_BM : 0;
  return 100 * (0.45 * c(rL) + 0.30 * c(rC) + 0.15 * c(rN) + 0.10 * c(rD));
}
const hh = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const efficiency_log = [];
const k0 = DAYS.length - 1;
for (let m = START + 10; m <= ASOF; m += 10) {
  const f = frac(m);
  const scopes = { BRANCH: tele };
  TEAMS.forEach((t, i) => { scopes[t[0]] = tele.filter(p => p.team === i); });
  Object.keys(scopes).forEach(sc => {
    const a = { present: 0, logins: 0, calls: 0, conn: 0, disb: 0 };
    scopes[sc].forEach(p => { const s = stats(p, k0, f); if (!s) return; a.present++; a.logins += s.logins; a.calls += s.calls; a.conn += s.conn; a.disb += s.disb; });
    a.tL = a.present * PL * f; a.tC = a.present * PC * f;
    efficiency_log.push({ timestamp: TODAY + ' ' + hh(m), scope: sc, present: a.present, target_logins: a.present * PL, logins: a.logins, target_calls: a.present * PC, calls: a.calls, score: Math.round(scoreOf(a) * 10) / 10 });
  });
}

const config = [
  { key: 'per_head_logins', value: PL }, { key: 'per_head_calls', value: PC },
  { key: 'connect_benchmark', value: CONN_BM }, { key: 'disb_benchmark', value: DISB_BM },
  { key: 'shift_start_min', value: START }, { key: 'shift_end_min', value: END }, { key: 'stuck_days', value: 3 }];

const access = [
  { email: 'owner@example.com', name: 'Rajesh Menon', role: 'ADMIN', team_id: '', status: 'ACTIVE', added_on: '2026-01-15' },
  { email: 'abhishek.tl@example.com', name: 'Abhishek Rao', role: 'TL', team_id: 'T1', status: 'ACTIVE', added_on: '2026-01-15' },
  { email: 'neha.tl@example.com', name: 'Neha Kulkarni', role: 'TL', team_id: 'T2', status: 'ACTIVE', added_on: '2026-01-15' },
  { email: 'imran.tl@example.com', name: 'Imran Shaikh', role: 'TL', team_id: 'T3', status: 'ACTIVE', added_on: '2026-01-15' },
  { email: 'pooja.tl@example.com', name: 'Pooja Nair', role: 'TL', team_id: 'T4', status: 'ACTIVE', added_on: '2026-01-15' }];


/* ---------- v2 demo data: targets, cases, remarks, devices, directory ---------- */
const pick = a => a[Math.floor(rnd() * a.length)];
const MONTH = TODAY.slice(0, 7), PREV = '2026-09';
const mtd = {}; tele.forEach(p => { let t = 0; DAYS.forEach((d, k) => { const x = stats(p, k, frac(ASOF)); if (x) t += x.amt; }); mtd[p.code] = t; });
const targets = [];
tele.forEach((p, i) => {
  // each person gets their own round-lakh target, a mix of ahead and behind so the screens have a story
  const want = mtd[p.code] / [0.62, 0.8, 0.95, 1.15, 0.7][i % 5];
  const tg = Math.max(8, Math.round(want / 1e5 / 2) * 2) * 1e5;
  targets.push({ scope: 'EMP', id: p.code, month: MONTH, amount: tg });
  targets.push({ scope: 'EMP', id: p.code, month: PREV, amount: Math.max(8, Math.round(tg / 1e5 * 0.9 / 2) * 2) * 1e5 });
});
targets.push({ scope: 'TEAM', id: 'T2', month: MONTH, amount: Math.round(targets.filter(t => t.month === MONTH && t.scope === 'EMP' && tele.find(p => p.code === t.id).team === 1).reduce((s, t) => s + t.amount, 0) * 1.1 / 1e5) * 1e5 });
const team_targets = [];
TEAMS.forEach((t, ti) => [MONTH, PREV].forEach(m => {
  const set = targets.find(x => x.scope === 'TEAM' && x.id === t[0] && x.month === m);
  const sum = targets.filter(x => x.scope === 'EMP' && x.month === m && tele.find(p => p.code === x.id).team === ti).reduce((s, x) => s + x.amount, 0);
  team_targets.push({ team_id: t[0], month: m, amount: set ? set.amount : sum, source: set ? 'set' : 'sum' });
}));

const CUST = ['Sunil Jadhav', 'Pooja Kamble', 'Imtiyaz Shaikh', 'Neelam Rane', 'Vikram Sawant', 'Geeta Naik', 'Arjun Bhosale', 'Fatima Sheikh', 'Ramesh Pawar', 'Sunita Gaikwad', 'Mahesh Kulkarni', 'Rukhsar Khan', 'Deepak Salvi', 'Anita Shinde', 'Prakash Mane', 'Lata Joshi', 'Yusuf Merchant', 'Kiran Chavan', 'Smita Patkar', 'Rajendra Thakur', 'Shabana Ali', 'Nitin Wagh', 'Varsha Kadam', 'Ganesh Ghule'];
const CBANK = ['HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Bajaj Finance', 'State Bank of India', 'Kotak Mahindra Bank', 'IDFC First Bank', 'Tata Capital'];
const CPROD = ['Personal loan', 'Business loan', 'Home loan', 'Car loan', 'Credit card'];
const WIN = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27'];
const cases = [], case_notes = [];
tele.forEach(p => {
  const n = 3 + Math.floor(rnd() * 4);
  for (let q = 0; q < n; q++) {
    const wi = Math.floor(rnd() * WIN.length), date = WIN[wi], old = wi < 6;
    const u = rnd();
    const stage = u > 0.93 ? 'NOT_INTERESTED' : old ? (u < 0.35 ? 'DISBURSED' : u < 0.5 ? 'REJECTED' : u < 0.75 ? 'PENDING' : u < 0.9 ? 'QUERY' : 'APPROVED') : (u < 0.35 ? 'LOGIN' : u < 0.7 ? 'PENDING' : u < 0.8 ? 'APPROVED' : u < 0.9 ? 'QUERY' : 'DISBURSED');
    const later = WIN.slice(wi); const sd = (stage === 'LOGIN' || old && (stage === 'PENDING' || stage === 'QUERY')) ? date : pick(later);
    const id = 'C' + String(cases.length + 1).padStart(5, '0');
    cases.push({ case_id: id, date, emp_code: p.code, customer: pick(CUST), bank: pick(CBANK), product: pick(CPROD), amount: (1 + Math.floor(rnd() * 14)) * 100000, stage, stage_date: sd, updated_by: TEAMS[p.team][3],
      source: rnd() < 0.5 ? 'BACKEND' : '', rm: pick(['Kunjal', 'Daya', 'Smitha', 'Jaspreet']), location: pick(['Mumbai', 'Pune', 'Hyderabad', 'Chennai', 'Madurai', 'Bangalore', 'Delhi']),
      reason: stage === 'REJECTED' ? pick(['Live loan count reject rule', 'Greater than 10 PL enquiries in last 3 months', 'Declined based on scorecard cutoff', 'PAN number is not valid on system', 'Outstanding greater than max eligibility']) : stage === 'NOT_INTERESTED' ? 'Consent' : '' });
  }
});
['Waiting for salary slips from the customer', 'Bank asked for a co-applicant, customer is thinking', 'Customer not picking up, will visit tomorrow'].forEach((note, i) => {
  const c = cases.filter(x => x.stage === 'PENDING' || x.stage === 'QUERY')[i * 2]; if (c) case_notes.push({ case_id: c.case_id, date: '2026-10-26 17:40', by: TEAMS[tele.find(p => p.code === c.emp_code).team][3], note });
});

const remarks = [
  ['2026-10-27', 'EMP012', 'Chewing gum / eating on the floor', 'Chewing gum while on a customer call'],
  ['2026-10-26', 'EMP008', 'Dress code', 'Came in shorts and slippers, asked to go and change'],
  ['2026-10-24', 'EMP005', 'Mobile phone use', 'Personal phone on the desk during calls, told twice'],
  ['2026-10-23', 'EMP012', 'Late coming', 'Third late arrival this week'],
  ['2026-10-22', 'EMP017', 'Rude or improper language', 'Raised voice with a customer'],
  ['2026-10-21', 'EMP008', 'Leaving seat / long breaks', 'Away from the desk for 40 minutes'],
  ['2026-10-20', 'EMP003', 'Dress code', 'No ID card on the floor']
].map((r, i) => ({ remark_id: 'R' + (100 + i), date: r[0], emp_code: r[1], category: r[2], note: r[3], given_by: 'Rajesh Menon', created_at: r[0] + ' 12:10' }));

const devices = [
  { email: 'owner@example.com', name: 'Rajesh Menon', role: 'ADMIN', device: 'Windows · Chrome 129', mode: 'Browser tab', platform: 'Windows', first_seen: '2026-10-12 09:02', last_seen: '2026-10-27 15:28', sign_ins: 9 },
  { email: 'owner@example.com', name: 'Rajesh Menon', role: 'ADMIN', device: 'iOS · Safari 18', mode: 'Installed app', platform: 'iOS', first_seen: '2026-10-13 21:15', last_seen: '2026-10-27 14:02', sign_ins: 4 },
  { email: 'abhishek.tl@example.com', name: 'Abhishek Rao', role: 'TL', device: 'Android SM-S918B · Chrome 129', mode: 'Installed app', platform: 'Android', first_seen: '2026-10-12 10:05', last_seen: '2026-10-27 15:24', sign_ins: 3 },
  { email: 'neha.tl@example.com', name: 'Neha Kulkarni', role: 'TL', device: 'Android Redmi Note 11 · Chrome 128', mode: 'Browser tab', platform: 'Android', first_seen: '2026-10-14 10:40', last_seen: '2026-10-27 11:12', sign_ins: 6 },
  { email: 'imran.tl@example.com', name: 'Imran Shaikh', role: 'TL', device: 'Windows · Edge 129', mode: 'Browser tab', platform: 'Windows', first_seen: '2026-10-15 09:50', last_seen: '2026-10-26 18:31', sign_ins: 5 }
];

const FEMALE = new Set(['Sana Khan', 'Divya Iyer', 'Riya Shah', 'Tanvi Desai', 'Farah Ansari', 'Kavya Menon', 'Zoya Qureshi', 'Meera Reddy', 'Anjali Das', 'Pallavi More', 'Neha Kulkarni', 'Pooja Nair']);
const PLACES = ['Andheri East', 'Borivali West', 'Thane West', 'Dadar', 'Vashi, Navi Mumbai', 'Kandivali East', 'Mulund West', 'Ghatkopar', 'Goregaon East', 'Malad West'];
const BANKS2 = [['HDFC Bank', 'HDFC0000123'], ['ICICI Bank', 'ICIC0000456'], ['State Bank of India', 'SBIN0001234'], ['Axis Bank', 'UTIB0000789'], ['Kotak Mahindra Bank', 'KKBK0000321']];
const L = 'ABCDEFGHJKLMNPRSTUVWXYZ', digs = n => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');
const directory = employees.map((e, i) => {
  const fn = e.name, fem = FEMALE.has(fn), parts = fn.split(' '), sur = parts[parts.length - 1], bk = pick(BANKS2);
  const complete = !['EMP008', 'EMP017', 'EMP099'].includes(e.emp_code), isTL = e.role === 'TL';
  const lead = isTL ? '' : (employees.find(x => x.emp_code === e.leader_code) || {}).name || '';
  const mob = '9' + pick(['8', '7', '9', '6']) + digs(8);
  const d = {
    emp_code: e.emp_code, name: e.name, team_id: e.team_id, team_name: e.team_name, leader_code: e.leader_code, role: e.role, status: e.status, join_date: e.join_date, exit_date: e.exit_date, leader_name: lead,
    full_name: fn, dob: (1989 + Math.floor(rnd() * 13)) + '-' + String(1 + Math.floor(rnd() * 12)).padStart(2, '0') + '-' + String(1 + Math.floor(rnd() * 28)).padStart(2, '0'),
    gender: fem ? 'Female' : 'Male', marital_status: pick(['Single', 'Single', 'Married']), blood_group: pick(['A+', 'B+', 'O+', 'AB+', 'O-', '']),
    father_name: pick(['Ramesh', 'Suresh', 'Mahesh', 'Anil', 'Dilip', 'Prakash']) + ' ' + sur, mother_name: pick(['Sunita', 'Meena', 'Kavita', 'Asha', 'Lata', 'Rekha']) + ' ' + sur,
    emergency_name: pick(['Ramesh', 'Sunita', 'Kavita', 'Anil']) + ' ' + sur, emergency_phone: '9' + pick(['8', '7', '9']) + digs(8),
    address: (10 + Math.floor(rnd() * 190)) + ', ' + pick(['Shivaji Nagar', 'Ganesh Chawl', 'Sai Krupa Society', 'Lokhandwala Complex', 'Sector 9']) + ', ' + pick(PLACES) + ', Maharashtra 4000' + String(10 + Math.floor(rnd() * 80)),
    mobile: mob, email: parts[0].toLowerCase() + '.' + sur.toLowerCase() + '@example.com',
    pan: Array.from({ length: 3 }, () => L[Math.floor(rnd() * L.length)]).join('') + 'P' + sur[0].toUpperCase() + digs(4) + L[Math.floor(rnd() * L.length)],
    aadhaar: String(2 + Math.floor(rnd() * 8)) + digs(11), bank_name: bk[0], account_holder: fn, account_no: digs(12), ifsc: bk[1], bank_branch: pick(PLACES).split(',')[0],
    designation: isTL ? 'Team Leader' : pick(['Telecaller', 'Telecaller', 'Senior Telecaller']), salary: isTL ? 45000 + Math.floor(rnd() * 8) * 2500 : 18000 + Math.floor(rnd() * 8) * 1500,
    updated_on: '2026-10-01', updated_by: 'owner@example.com'
  };
  if (!complete) { ['father_name', 'mother_name', 'emergency_name', 'emergency_phone', 'pan', 'aadhaar', 'ifsc', 'bank_name', 'account_no', 'blood_group'].forEach(k => { d[k] = ''; }); d.account_holder = e.emp_code === 'EMP017' ? 'S. Das' : d.account_holder; }
  if (e.status === 'LEFT') d.designation = 'Telecaller';
  if (i === 2) d.status = 'PROBATION';
  if (i === 9) d.status = 'NOTICE';
  return d;
});

const data = { meta: { asof: TODAY + 'T' + hh(ASOF) + ':00+05:30', branch: 'Mumbai Branch', history_days: 180, note: 'Demo data. Generated by tools/make-mock.js' }, employees, attendance, kpi, calls, config, efficiency_log, access, sync_on: true, sync: { at: '2026-10-27 15:20', days: 60, tabs: 1, rows: cases.length + 2, imported: cases.length, people: tele.length, kpi_rows: 80, unmatched: 2, warnings: 0, issue_count: 2, error: '', issues: [{ type: 'Name not matched', tc: 'Soni', customer: 'Nikhil kumar gudipally', detail: 'No telecaller called "Soni" in Employees. Add them to Employees, or add a row in Name_Map.' }, { type: 'Name not matched', tc: 'Akshata', customer: 'Ramashankar Khare', detail: 'More than one telecaller matches "Akshata". Add a row in Name_Map with tc_name, tl_name and emp_code.' }] }, targets, team_targets, cases, case_notes, remarks, devices, directory };
fs.writeFileSync(path.join(OUT, 'mock.json'), JSON.stringify(data));
console.log('employees ' + employees.length + ', attendance ' + attendance.length + ', kpi ' + kpi.length + ', calls ' + calls.length + ', log ' + efficiency_log.length);
