/**
 * node tools/test-live-e2e.js
 * Real browser + real Code.gs (pretend Google environment) + pretend "Sign in with Google" button.
 * Needs Playwright:  npm i -g playwright  (not required to run the app itself).
 */
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const http = require('http'), fs = require('fs'), path = require('path');
const { makeServer } = require('./fake-apps-script');
const root = path.join(__dirname, '..', 'public');
const CID = 'e2e-client.apps.googleusercontent.com', API = 'https://script.google.com/macros/s/FAKE/exec';

const gs = makeServer(); gs.sandbox.GOOGLE_CLIENT_ID = CID; gs.sandbox.setup(); gs.sandbox.loadDemoData();
const owner = gs.call({ action: 'login', id_token: gs.googleToken('owner@gmail.com') });
['10:10', '10:20', '10:30'].forEach(t => { gs.setNow('2026-10-27T' + t + ':00+05:30'); gs.sandbox.logEfficiency(); });
const adminCall = b => gs.call(Object.assign({ token: owner.token }, b));
adminCall({ action: 'access_set', email: 'bravo.tl@gmail.com', name: 'Bharat', role: 'TL', team_id: 'DT2' });

const srv = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(0);

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const port = srv.address().port, b = await chromium.launch(), errs = [];
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  let offline = false, lastEmail = '';
  await p.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: `window.FP_CONFIG={API_URL:'${API}',GOOGLE_CLIENT_ID:'${CID}',REFRESH_MIN:5}` }));
  await p.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: `
    window.google={accounts:{id:{_cb:null,initialize(o){this._cb=o.callback},renderButton(el){el.innerHTML='<button id="fake-google">Sign in with Google</button>';el.firstChild.onclick=()=>this._cb({credential:window.__EMAIL_TOKEN})},disableAutoSelect(){}}}};` }));
  await p.route(API, r => {
    if (offline) return r.abort();
    const body = JSON.parse(r.request().postData()); const out = gs.call(body);
    r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
  });
  const signInAs = async email => { const tok = gs.googleToken(email); await p.evaluate(t => { window.__EMAIL_TOKEN = t; }, tok); await p.click('#fake-google'); };
  const text = () => p.$eval('#view', e => e.innerText);
  const tabs = () => p.$$eval('.tabs button', bs => bs.map(x => x.dataset.v));

  console.log('-- sign-in screen');
  await p.goto(`http://localhost:${port}/`); await p.waitForSelector('#fake-google');
  ok(/Sign in with your Google account/.test(await text()), 'shows Google sign-in first, no data before login');
  ok(!(await p.content()).includes('admin-demo-key'), 'no access keys anywhere in the page');
  await signInAs('stranger@gmail.com'); await p.waitForSelector('.msg');
  ok(/stranger@gmail.com has not been given access/.test(await text()), 'unknown Gmail is refused with a clear message');
  ok(await p.$('#fake-google') !== null, 'sign-in button is back so they can try another account');

  console.log('-- admin');
  await signInAs('owner@gmail.com'); await p.waitForSelector('.tabs button');
  ok((await tabs()).includes('setup') && (await tabs()).includes('teams'), 'admin gets Teams and Staff and access tabs');
  ok(/Admin/.test(await p.$eval('#bar1', e => e.innerText)), 'top bar shows Admin');
  await p.click('.tabs [data-v="live"]'); const live = await text();
  ok(/Disbursed today/i.test(live) && /₹/.test(live), 'live shows disbursed rupees');
  ok(!/NaN|undefined/.test(live), 'live has no NaN/undefined');
  await p.click('.tabs [data-v="people"]'); const people = await text();
  ok(/Pending/i.test(people) && /Disbursed ₹/i.test(people), 'telecaller table has stage columns and amount');
  await p.click('.tabs [data-v="setup"]');
  ok(/owner@gmail.com/.test(await text()) && /bravo.tl@gmail.com/.test(await text()), 'access list shows owner and the TL');
  // give access via the UI
  await p.fill('#a-email', 'D.elta.TL+x@gmail.com'); await p.fill('#a-name', 'Dev'); await p.selectOption('#a-team', 'DT4'); await p.click('[data-act="accset"]');
  await p.waitForFunction(() => /can now sign in/.test(document.querySelector('#view').innerText));
  ok(/D\.elta\.TL\+x@gmail\.com|d\.elta\.tl\+x@gmail\.com/i.test(await text()), 'UI add-access shows the new row');
  ok(gs.sheet('Access').getLastRow() === 4, 'it was written to the Access tab of the sheet');
  // bad input is refused with the server message
  await p.fill('#a-email', 'nope'); await p.click('[data-act="accset"]');
  await p.waitForFunction(() => /does not look like an email/.test(document.querySelector('#view').innerText)); ok(true, 'bad email refused');
  // add a team via UI
  await p.fill('#tm-name', 'Echo'); await p.fill('#tm-lead', 'Esha K'); await p.click('[data-act="teamadd"]');
  await p.waitForFunction(() => /created/.test(document.querySelector('#view').innerText));
  ok(/Echo/.test(await p.$eval('#a-team', e => e.innerText)), 'new team appears in the team picker');

  console.log('-- admin: directory, targets, remarks, cases, devices (real API)');
  ok(gs.sheet('Devices').getLastRow() >= 2, 'the sign-in recorded this device in the Devices tab');
  ok(/Browser tab|Installed app/.test(gs.sheet('Devices').getRange(2, 6, 1, 1).getValues()[0][0]), 'device records installed app vs browser');
  await p.click('.tabs [data-v="directory"]'); await p.waitForSelector('#dirlist tr.clk');
  ok(/Rahul Verma/.test(await text()), 'directory loads from the server on demand');
  await p.click('#dirlist tr.clk >> nth=0'); await p.click('[data-act="x-dedit"]');
  await p.fill('#f-pan', 'ABCDE1234F'); await p.fill('#f-mobile', '9876543210'); await p.fill('#f-ifsc', 'HDFC0001234'); await p.fill('#f-aadhaar', '234567890123'); await p.fill('#f-salary', '24000');
  await p.click('[data-act="x-dsave"]'); await p.waitForFunction(() => /details are saved/.test(document.querySelector('#view').innerText));
  ok(gs.sheet('Directory').getLastRow() === 2, 'directory details were written to the Directory tab');
  ok(await p.evaluate(() => !localStorage.getItem('fp-cache').includes('ABCDE1234F') && !localStorage.getItem('fp-cache').includes('234567890123')), 'PAN and Aadhaar are never stored in the browser cache');
  await p.click('.tabs [data-v="targets"]'); ok(await p.evaluate(() => DIR.length === 0 && !DIRLOADED), 'directory is dropped from memory when you leave the page');
  await p.waitForSelector('input.tin'); await p.fill('input.tin[data-k="EMP|DEMO01"]', '16L'); await p.fill('input.tin[data-k="EMP|DEMO02"]', '20 lakh'); await p.click('[data-act="x-tsave"]');
  await p.waitForFunction(() => /Targets saved/.test(document.querySelector('#view').innerText));
  { const tv = gs.sheet('Targets').getRange(2, 1, gs.sheet('Targets').getLastRow() - 1, 4).getValues(); ok(tv.some(r => r[1] === 'DEMO01' && r[3] === 1600000) && tv.some(r => r[1] === 'DEMO02' && r[3] === 2000000), 'each person got their own target in the sheet'); }
  await p.click('.tabs [data-v="remarks"]'); await p.selectOption('#rm-emp', 'DEMO03'); await p.selectOption('#rm-cat', 'Dress code'); await p.fill('#rm-note', 'shorts'); await p.click('[data-act="x-remadd"]');
  await p.waitForFunction(() => /Remark recorded/.test(document.querySelector('#view').innerText)); ok(gs.sheet('Remarks').getLastRow() === 2, 'remark written to the sheet');
  await p.click('.tabs [data-v="cases"]'); await p.waitForSelector('[data-act="x-cmove"]'); const cid = await p.$eval('[data-act="x-cmove"]', b => b.dataset.v);
  const cur = await p.$eval('#cs-' + cid, e => e.value); await p.selectOption('#cs-' + cid, cur === 'QUERY' ? 'PENDING' : 'QUERY'); await p.fill('#cn-' + cid, 'done'); await p.click(`[data-act="x-cmove"][data-v="${cid}"]`);
  await p.waitForFunction(() => /Case moved to/.test(document.querySelector('#view').innerText)); ok(gs.sheet('Case_Notes').getLastRow() === 2, 'case note written to the sheet');
  await p.click('.tabs [data-v="devices"]'); ok(/Online now/.test(await text()), 'app users page shows who is online');
  await p.click('.tabs [data-v="setup"]');
  // team totals before removing a person
  await p.click('.tabs [data-v="teams"]');
  const before = await p.evaluate(() => { const s = teamAgg(0, 0, 29); return { l: s.logins, amt: s.amt }; });
  await p.click('.tabs [data-v="setup"]');
  const code = await p.evaluate(() => act().find(e => e.team === 0).code);
  await p.click(`[data-act="rm"][data-v="${code}"]`); await p.click(`[data-act="rm"][data-v="${code}"]`);
  await p.waitForFunction(() => /marked as left/.test(document.querySelector('#view').innerText));
  const after = await p.evaluate(() => { const s = teamAgg(0, 0, 29); return { l: s.logins, amt: s.amt }; });
  ok(before.l === after.l && before.amt === after.amt, 'removing a telecaller keeps their history in team totals ' + JSON.stringify(after));
  ok(!(await p.evaluate(c => act().some(e => e.code === c), code)), 'and they disappear from the active list');
  // refresh survives
  await p.click('[data-act="sync"]'); await p.waitForTimeout(300); ok(!/Could not/.test(await text()), 'Refresh button works');

  console.log('-- session survives reload');
  await p.reload(); await p.waitForSelector('.tabs button');
  ok((await tabs()).includes('setup'), 'reload goes straight back in (no second sign-in)');

  console.log('-- team leader');
  await p.click('[data-act="signout"]'); await p.waitForSelector('#fake-google');
  ok(await p.evaluate(() => localStorage.getItem('fp-cache') === null && localStorage.getItem('fp-session') === null), 'sign-out clears the saved session and cached data');
  await signInAs('bravo.tl@gmail.com'); await p.waitForSelector('.tabs button');
  const t = await tabs(); ok(!t.includes('setup') && !t.includes('teams') && t.includes('rank') && t.includes('day'), 'TL tabs: no Teams / Staff, has All teams and Day view: ' + t);
  ok(/Bharat|Bravo/.test(await p.$eval('#bar1', e => e.innerText)), 'top bar shows the TL and team');
  // demo data: DT1 = Rahul..Divya, DT2 (Bravo) = Amit, Riya, Tanvi, Mohit, DT3 = Farah.., DT4 = Aarav..
  const otherNames = ['Rahul Verma', 'Sana Khan', 'Karan Mehta', 'Divya Iyer', 'Farah Ansari', 'Suresh Yadav', 'Kavya Menon', 'Nikhil Pawar', 'Aarav Singh', 'Zoya Qureshi', 'Rohan Kale', 'Meera Reddy'];
  const mine = ['Amit Patil', 'Riya Shah', 'Tanvi Desai', 'Mohit Gupta'];
  for (const tab of t) {
    await p.click(`.tabs [data-v="${tab}"]`); const x = await text();
    if (tab !== 'help' && otherNames.some(n => x.includes(n))) ok(false, 'LEAK on tab ' + tab + ': ' + otherNames.filter(n => x.includes(n)));
  }
  ok(true, 'no other-team telecaller name appears on any TL tab');
  await p.click('.tabs [data-v="people"]'); const pp = await text(); ok(mine.some(n => pp.includes(n)) && !/Rahul Verma/.test(pp), 'TL sees only own telecallers');
  await p.click('.tabs [data-v="rank"]'); const rk = await text();
  ok(/Alpha|Bravo|Charlie|Delta/.test(rk) && /\(you\)/.test(rk), 'All teams lists every team with the TL’s own marked');
  ok(/You are #\d of 5/.test(rk), 'shows position: ' + (rk.match(/You are #\d of 5[^.]*\./) || [''])[0]);
  ok(/Charlie|Delta|Alpha/.test(rk) && /₹/.test(rk), 'other teams’ totals incl. rupees are visible');
  await p.click('.tabs [data-v="day"]'); await p.click('[data-act="dayprev"]'); ok(/Monday, 26 Oct/.test(await text()), 'TL Day view navigates to the previous working day');
  await p.click('.tabs [data-v="live"]'); ok(/Your position today/i.test(await text()), 'TL live shows own position');
  const cache = await p.evaluate(() => localStorage.getItem('fp-cache')); ok(otherNames.every(n => !cache.includes(n)), 'even the offline cache holds no other-team names');
  const sess = await p.evaluate(() => localStorage.getItem('fp-session')); ok(!/owner@gmail/.test(sess) && !/gtok-/.test(sess), 'saved session holds our own token, not the Google token');

  console.log('-- offline and revocation');
  offline = true; await p.click('[data-act="sync"]'); await p.waitForSelector('.lock');
  ok(/Offline/.test(await p.$eval('.lock', e => e.innerText)) && /Live/.test(await p.$eval('#view h2', e => e.innerText)), 'offline: keeps showing last saved data with a notice');
  offline = false;
  adminCall({ action: 'access_revoke', email: 'bravo.tl@gmail.com' });
  await p.click('[data-act="sync"]'); await p.waitForSelector('#fake-google');
  ok(/removed or changed|sign in again/i.test(await text()), 'revoked TL is thrown back to sign-in with a reason');
  ok(await p.evaluate(() => localStorage.getItem('fp-cache') === null), 'and their cached data is wiped');
  await signInAs('bravo.tl@gmail.com'); await p.waitForSelector('.msg');
  ok(/has not been given access/.test(await text()), 'cannot sign back in');

  console.log('-- empty sheet as admin');
  const e = makeServer(); e.sandbox.GOOGLE_CLIENT_ID = CID; e.sandbox.setup();
  const gsOld = gs.call; gs.call = body => e.call(body);
  await p.evaluate(() => { localStorage.clear(); }); await p.reload(); await p.waitForSelector('#fake-google');
  const tok = e.googleToken('owner@gmail.com'); await p.evaluate(t => { window.__EMAIL_TOKEN = t; }, tok); await p.click('#fake-google'); await p.waitForSelector('.tabs button');
  ok(/Nothing to show yet/i.test(await text()), 'brand-new empty sheet shows a friendly empty state (no crash)');
  for (const tab of await tabs()) { await p.click(`.tabs [data-v="${tab}"]`); if (/Something went wrong/.test(await text())) ok(false, 'empty sheet crashed tab ' + tab); }
  ok(true, 'every tab survives an empty sheet');

  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close(); srv.close();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
