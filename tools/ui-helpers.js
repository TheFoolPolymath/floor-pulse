/* Shared helpers for the browser tests in tools/ (static server, Playwright launch, small checks). */
const http = require('http'), fs = require('fs'), path = require('path');
function pw() {
  try { return require('playwright'); } catch (e) { return require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright'); }
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(root) {
  const srv = http.createServer((q, r) => {
    let f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
    if (f.endsWith('/')) f += 'index.html';
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }); r.end(b); } });
  });
  return new Promise(res => srv.listen(0, () => res(srv)));
}
function counter() {
  const c = { pass: 0, fail: 0 };
  c.ok = (cond, msg) => { if (cond) c.pass++; else { c.fail++; console.log('  FAIL: ' + msg); } };
  return c;
}
/** Expand every collapsed sidebar group so each page link can be clicked. */
/** The sidebar is an accordion (one group open at a time), so open only the group that holds this page. */
async function openFor(pg, tab) {
  const opened = await pg.evaluate(t => { const b = document.querySelector('#nav .nv[data-v="' + t + '"]'); const g = b && b.closest('.ng'); if (g && !g.classList.contains('open')) { g.querySelector('.ng-h').click(); return true; } return false; }, tab);
  if (opened) await pg.waitForTimeout(340);   // let the group finish sliding open (the menu has a short motion)
}
async function openAll(pg) { await pg.evaluate(() => { const b = document.querySelector('.ng-h[aria-expanded="false"]'); if (b) b.click(); }); }
async function go(pg, tab) { await openFor(pg, tab); await pg.click(`#nav .nv[data-v="${tab}"]`); await pg.waitForTimeout(60); return pg.innerText('#view'); }
const noHScroll = pg => pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
function collectErrors(pg) {
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/i.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  return errs;
}
module.exports = { pw, serve, counter, openAll, openFor, go, noHScroll, collectErrors };
