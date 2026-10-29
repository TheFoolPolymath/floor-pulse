/** node tools/test-demo-ui.js  -> real browser, demo data, admin and team leader, desktop layout.
 *  Needs Playwright + Chromium (PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH if not on the default path). */
const H = require('./ui-helpers');
const { chromium } = H.pw();
const path = require('path');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
require('fs').mkdirSync(SHOTS, { recursive: true });
const TAB_KEYS_ADMIN = ['live', 'day', 'teams', 'people', 'attendance', 'logins', 'calls', 'cases', 'targets', 'pipeline', 'trends', 'remarks', 'directory', 'setup', 'devices', 'help'];

(async () => {
  const c = H.counter(), srv = await H.serve(require('path').join(__dirname, '..', 'public'));
  const url = 'http://localhost:' + srv.address().port + '/';
  const br = await chromium.launch();
  const pg = await br.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = H.collectErrors(pg);
  await pg.route(/fonts\.(googleapis|gstatic)/, r => r.abort());
  await pg.goto(url); await pg.waitForSelector('#nav .nv');

  console.log('admin navigation');
  const items = await pg.$$eval('#nav .nv', b => b.map(x => x.dataset.v));
  c.ok(TAB_KEYS_ADMIN.every(t => items.includes(t)) && items.length === TAB_KEYS_ADMIN.length, 'admin sees all ' + TAB_KEYS_ADMIN.length + ' pages: ' + items.join(','));
  c.ok((await pg.$$('#nav .ng')).length === 5, 'five sidebar groups');
  for (const t of TAB_KEYS_ADMIN) {
    const x = await H.go(pg, t);
    c.ok(x.length > 40 && !/Something went wrong/i.test(x), 'page ' + t + ' renders');
    c.ok(await H.noHScroll(pg), 'no horizontal scroll on desktop, page ' + t);
  }
  c.ok(await pg.innerText('#pagetitle') === 'Help', 'header shows the page title');
  c.ok(/Updated|Demo data/.test(await pg.innerText('#stamp')), 'header shows the update time');

  console.log('group expand and collapse');
  await pg.evaluate(() => { const b = document.querySelector('.ng-h[data-v="pe"]'); if (b.getAttribute('aria-expanded') === 'false') b.click(); }); await pg.waitForTimeout(40);
  await pg.click('.ng-h[data-v="pe"]'); await pg.waitForTimeout(40);
  c.ok(await pg.$eval('.ng-h[data-v="pe"]', b => b.getAttribute('aria-expanded') === 'false'), 'People group collapses');
  c.ok(await pg.$eval('.ng-h[data-v="pe"] + .ng-items-wrap', e => e.classList.contains('closed')), 'People items hidden when collapsed');
  await pg.click('.ng-h[data-v="pe"]'); await pg.waitForTimeout(40);
  c.ok(await pg.$eval('.ng-h[data-v="pe"]', b => b.getAttribute('aria-expanded') === 'true'), 'People group expands again');

  console.log('sidebar retract to icons and back');
  c.ok(await pg.$eval('#app', a => !a.classList.contains('rail')), 'sidebar starts expanded at 1440px');
  await pg.click('#sideToggle'); await pg.waitForTimeout(60);
  c.ok(await pg.$eval('#app', a => a.classList.contains('rail')), 'retract makes the rail');
  c.ok(await pg.$eval('.nv .lbl', e => getComputedStyle(e).display === 'none'), 'rail hides text labels');
  c.ok(await pg.evaluate(() => localStorage.getItem('fp-rail') === '1'), 'rail choice remembered');
  await pg.waitForTimeout(340);
  c.ok(await pg.evaluate(() => getComputedStyle(document.querySelector('.main')).marginLeft === '72px'), 'content moves to make room for the rail');
  await pg.screenshot({ path: require('path').join(SHOTS, 'desktop-rail.png') });
  await pg.click('#sideToggle'); await pg.waitForTimeout(60);
  c.ok(await pg.$eval('#app', a => !a.classList.contains('rail')), 'open again restores labels');
  await pg.evaluate(() => { try { localStorage.removeItem('fp-rail'); } catch (e) {} });

  console.log('h:m:s durations and team-wise calls report');
  c.ok(await pg.evaluate(() => hms(8705) === '2h:25m:05s' && hms(9100) === '2h:31m:40s' && hms(0) === '0h:00m:00s' && hms(310) === '0h:05m:10s'), 'hms() formats correctly');
  let calls = await H.go(pg, 'calls');
  c.ok(/Calls report/.test(calls), 'Calls report page title');
  c.ok(/\b\d+h:\d{2}m:\d{2}s\b/.test(calls), 'durations shown as h:m:s');
  c.ok(!/\b\d+m \d{2}s\b/.test(calls), 'old "5m 12s" style is gone');
  c.ok(/Branch total/.test(calls), 'admin sees a branch total row');
  const teamCount = await pg.$$eval('#view tr.grp', r => r.length);
  c.ok(teamCount >= 2, 'calls report is grouped by team (' + teamCount + ' team header rows)');
  const sums = await pg.evaluate(() => {
    const out = []; let head = null, sum = 0;
    document.querySelectorAll('#view table tbody tr').forEach(tr => {
      if (tr.classList.contains('grp')) { if (head) out.push([head, sum]); head = +tr.children[1].textContent.replace(/,/g, ''); sum = 0; }
      else if (tr.classList.contains('tot')) { if (head) out.push([head, sum]); head = null; }
      else if (head !== null) sum += +tr.children[1].textContent.replace(/,/g, '') || 0;
    });
    if (head !== null) out.push([head, sum]);
    return out;
  });
  c.ok(sums.length && sums.every(([h, s]) => h === s), 'team header calls equal the sum of its telecallers: ' + JSON.stringify(sums));
  await pg.screenshot({ path: require('path').join(SHOTS, 'desktop-admin-calls.png'), fullPage: true });

  console.log('logins report');
  const logins = await H.go(pg, 'logins');
  const lh = await pg.$$eval('#view thead th', t => t.length); c.ok(/Logins/.test(logins) && lh === 13, 'Logins page shows the last 7 working days (header cells ' + lh + ')');
  c.ok((await pg.$$eval('#view tr.grp', r => r.length)) >= 2, 'logins are grouped by team');
  await pg.screenshot({ path: require('path').join(SHOTS, 'desktop-admin-logins.png'), fullPage: true });

  console.log('range control and a telecaller detail still work');
  await H.go(pg, 'people');
  await pg.click('#view .seg button[data-v="7"]'); await pg.waitForTimeout(40);
  c.ok(await pg.$eval('#view .seg button[data-v="7"]', b => b.getAttribute('aria-pressed') === 'true'), '7d range selected');
  await pg.click('#view tr.clk'); await pg.waitForTimeout(120);
  c.ok(/cases and stages|efficiency trend/i.test(await pg.innerText('#view')), 'clicking a telecaller opens the detail');

  console.log('team leader view');
  await H.go(pg, 'live');
  await pg.click('#bar1 .seg button[data-act="role"][data-v="tl"]'); await pg.waitForTimeout(80);
  const tlNav = await pg.$$eval('#nav .nv', b => b.map(x => x.dataset.v));
  c.ok(!tlNav.includes('directory') && !tlNav.includes('remarks') && !tlNav.includes('setup') && tlNav.includes('logins'), 'team leader does not see admin pages');
  const tlLive = await H.go(pg, 'live');
  c.ok(/How is my team today\?/.test(tlLive), 'team leader Live shows the summary card');
  c.ok(/telecallers are in today/.test(tlLive) && /target for this time of day/.test(tlLive), 'summary sentences render');
  for (const t of ['live', 'day', 'rank', 'people', 'attendance', 'logins', 'calls', 'cases', 'targets', 'pipeline', 'trends', 'help']) {
    const x = await H.go(pg, t);
    c.ok(x.length > 40 && !/Something went wrong/i.test(x), 'team leader page ' + t + ' renders');
  }
  const tlCalls = await H.go(pg, 'calls');
  c.ok(!/Branch total/.test(tlCalls) && /Your team only/.test(tlCalls), 'team leader calls report is their team only');
  c.ok(await H.noHScroll(pg), 'no horizontal scroll, team leader desktop');
  c.ok(errs.length === 0, 'no uncaught errors: ' + errs.join(' | '));
  await br.close(); srv.close();
  console.log('\n' + c.pass + ' passed, ' + c.fail + ' failed');
  process.exit(c.fail ? 1 : 0);
})().catch(e => { console.log('FATAL', e); process.exit(1); });
