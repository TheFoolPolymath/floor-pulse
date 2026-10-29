/** node tools/test-phone-ui.js  -> phone layout (360px wide) for admin and team leader in demo mode,
 *  then the live-mode branch with the API stubbed in the browser (no backend needed).
 *  Needs Playwright + Chromium. Screenshots go to SHOTS (default: ./shots). */
const H = require('./ui-helpers');
const { chromium } = H.pw();
const fs = require('fs'), path = require('path');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const PUBLIC = path.join(__dirname, '..', 'public');
const shot = n => path.join(SHOTS, n);
const TL_PAGES = ['live', 'day', 'rank', 'people', 'attendance', 'logins', 'calls', 'cases', 'targets', 'pipeline', 'trends', 'help'];
const ADMIN_PAGES = ['live', 'day', 'teams', 'people', 'attendance', 'logins', 'calls', 'cases', 'targets', 'pipeline', 'trends', 'remarks', 'directory', 'setup', 'devices', 'help'];
/** on a phone the menu is a drawer: open it the way a finger would, pick the page, and the drawer closes itself */
async function phoneGo(pg, tab) {
  if (!(await pg.$eval('#app', a => a.classList.contains('drawer')))) { await pg.click('.menu'); await pg.waitForTimeout(220); }
  await H.openFor(pg, tab);
  await pg.click('#nav .nv[data-v="' + tab + '"]'); await pg.waitForTimeout(120);
  return pg.innerText('#view');
}
const overflowing = pg => pg.evaluate(() => [...document.querySelectorAll('#view *, .top *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('.tw'); }).slice(0, 4).map(e => e.tagName + '.' + e.className));

(async () => {
  const c = H.counter(), srv = await H.serve(PUBLIC);
  const url = 'http://localhost:' + srv.address().port + '/';
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  const errs = H.collectErrors(pg);
  await pg.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await pg.goto(url); await pg.waitForSelector('#nav .nv', { state: 'attached' });

  console.log('phone: admin drawer');
  c.ok(await pg.isVisible('.menu'), 'hamburger visible on phone');
  c.ok(!(await pg.isVisible('#sideToggle')), 'desktop retract button hidden on phone');
  c.ok(await pg.evaluate(() => document.querySelector('.side').getBoundingClientRect().right <= 0), 'menu starts off screen');
  await pg.click('.menu'); await pg.waitForTimeout(300);
  c.ok(await pg.$eval('#app', a => a.classList.contains('drawer')), 'hamburger opens the menu');
  c.ok(await pg.evaluate(() => document.querySelector('.side').getBoundingClientRect().right > 200), 'open menu is on screen');
  await pg.screenshot({ path: shot('phone-admin-drawer.png') });
  await pg.click('.scrim', { position: { x: 330, y: 400 } }); await pg.waitForTimeout(250);
  c.ok(!(await pg.$eval('#app', a => a.classList.contains('drawer'))), 'tapping the dark area closes the menu');
  await pg.click('.menu'); await pg.waitForTimeout(250);
  await H.openFor(pg, 'calls');
  await pg.click('#nav .nv[data-v="calls"]'); await pg.waitForTimeout(250);
  c.ok(!(await pg.$eval('#app', a => a.classList.contains('drawer'))), 'choosing a page closes the menu');
  c.ok((await pg.innerText('#pagetitle')) === 'Calls report', 'the chosen page is shown');
  c.ok(await pg.evaluate(() => getComputedStyle(document.querySelector('.nv')).minHeight === '44px'), 'nav targets are 44px tall');

  console.log('phone: every admin page fits 360px');
  for (const t of ADMIN_PAGES) {
    await phoneGo(pg, t);
    c.ok(await H.noHScroll(pg), 'admin ' + t + ' has no sideways scroll ' + JSON.stringify(await overflowing(pg)));
  }
  await phoneGo(pg, 'calls');
  c.ok(await pg.evaluate(() => getComputedStyle(document.querySelector('#view table thead')).display === 'none'), 'phone tables hide the header row and become cards');
  c.ok(await pg.evaluate(() => getComputedStyle(document.querySelector('#view td[data-l]')).display === 'grid'), 'card rows are label/value grids');
  c.ok(await pg.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#view tbody td')).fontSize) >= 14.5), 'text is at least 15px on phones');
  c.ok(/\b\d+h:\d{2}m:\d{2}s\b/.test(await pg.innerText('#view')), 'durations are h:m:s on phones too');
  await pg.screenshot({ path: shot('phone-admin-calls.png'), fullPage: false });

  console.log('phone: team leader');
  if (!(await pg.$eval('#app', a => a.classList.contains('drawer')))) { await pg.click('.menu'); await pg.waitForTimeout(250); }
  await pg.click('#sideAct .seg button[data-act="role"][data-v="tl"]'); await pg.waitForTimeout(150);
  for (const t of TL_PAGES) {
    const x = await phoneGo(pg, t);
    c.ok(x.length > 40 && !/Something went wrong/i.test(x), 'team leader ' + t + ' renders on phone');
    c.ok(await H.noHScroll(pg), 'team leader ' + t + ' has no sideways scroll ' + JSON.stringify(await overflowing(pg)));
  }
  await phoneGo(pg, 'live');
  c.ok(await pg.isVisible('.sum'), 'summary card is visible on the phone Live page');
  await pg.screenshot({ path: shot('phone-tl-live.png'), fullPage: false });
  await phoneGo(pg, 'people');
  await pg.screenshot({ path: shot('phone-tl-telecallers.png'), fullPage: false });
  await pg.click('#view tr.clk'); await pg.waitForTimeout(150);
  c.ok(await H.noHScroll(pg), 'telecaller detail on phone has no sideways scroll');
  c.ok(await pg.evaluate(() => Math.max(...[...document.querySelectorAll('#view svg')].map(s => s.getBoundingClientRect().width)) <= 330), 'charts fit the phone width');
  c.ok(errs.length === 0, 'no uncaught errors in demo phone run: ' + errs.join(' | '));
  await ctx.close();

  console.log('live mode (API stubbed in the browser)');
  const data = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'mock.json'), 'utf8'));
  const tlTeam = data.employees.find(e => e.role === 'TELECALLER').team_id;
  let delayMs = 0, calls = 0;
  const live = await br.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const lp = await live.newPage();
  const lerrs = H.collectErrors(lp);
  await lp.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await lp.route(/config\.js(\?.*)?$/, r => r.fulfill({ contentType: 'text/javascript', body: "window.FP_CONFIG={API_URL:'/api',GOOGLE_CLIENT_ID:'stub.apps.googleusercontent.com',BRANCH:'Mumbai Branch',REFRESH_MIN:5};" }));
  await lp.route(/\/api$/, async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action !== 'data') return r.fulfill({ json: { ok: true, message: 'Done.' } });
    calls++;
    if (delayMs) await new Promise(res => setTimeout(res, delayMs));
    const role = process.env.LIVE_ROLE === 'ADMIN' ? 'ADMIN' : 'TL';
    const payload = Object.assign({}, data, { role, team_id: role === 'TL' ? tlTeam : '', user: { email: 'lead@example.com', name: 'Lead' }, meta: Object.assign({}, data.meta, { asof: new Date().toISOString() }) });
    r.fulfill({ json: payload });
  });
  await lp.addInitScript(() => { try { localStorage.setItem('fp-session', JSON.stringify({ token: 't', user: { email: 'lead@example.com', name: 'Lead', role: 'TL' } })); } catch (e) {} });
  await lp.goto(url); await lp.waitForSelector('#nav .nv', { state: 'attached', timeout: 10000 });
  c.ok(calls >= 1, 'live branch loads data from the API');
  c.ok(await lp.$eval('#nav', n => n.textContent.includes('My team')), 'live team leader sees the My team group');
  c.ok(await lp.isVisible('.sum'), 'live summary card renders from real-shaped data');
  c.ok(!(await lp.isVisible('.side .ng-h:has-text("Admin")')), 'no admin group for a team leader in live mode');
  delayMs = 700;
  await lp.click('.menu'); await lp.waitForTimeout(250);
  await lp.click('#sideAct button[data-act="sync"]');
  await lp.waitForTimeout(120);
  c.ok(await lp.$eval('#sideAct button[data-act="sync"]', b => b.disabled && /Refreshing/.test(b.textContent)), 'Refresh shows a busy state and is disabled while loading');
  await lp.waitForTimeout(1000);
  c.ok(await lp.$eval('#sideAct button[data-act="sync"]', b => !b.disabled && b.textContent.trim() === 'Refresh'), 'Refresh is enabled again when the data is back');
  delayMs = 0;
  await lp.click('.scrim', { position: { x: 330, y: 400 } }); await lp.waitForTimeout(250);
  c.ok(await H.noHScroll(lp), 'live phone Live page has no sideways scroll');
  await lp.screenshot({ path: shot('phone-tl-live-api.png') });
  c.ok(lerrs.length === 0, 'no uncaught errors in live mode: ' + lerrs.join(' | '));
  await live.close();

  await br.close(); srv.close();
  console.log('\n' + c.pass + ' passed, ' + c.fail + ' failed');
  process.exit(c.fail ? 1 : 0);
})().catch(e => { console.log('FATAL', e); process.exit(1); });
