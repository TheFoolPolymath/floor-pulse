/* Local preview of the TV display with made-up staff and numbers. Needs nothing else installed.
 *   node tools/tv-preview.js
 * then open the TV link it prints. Stop with Ctrl+C.  It is not the live server: no Google sign-in, no database. */
const path = require('path');
const { makeEnv } = require('../test/harness');

(async () => {
  const env = await makeEnv();                      // in-memory database with a few sample telecallers and two teams
  env.ctx.cfg.serveStatic = true;                   // also serve the website (public/) from this process
  env.ctx.cfg.staticDir = path.join(__dirname, '..', 'public');
  const tok = await env.signIn('admin@gmail.com', 'Admin');
  const { key } = await env.call({ action: 'tv_key_new', token: tok });
  console.log('\nFloor Pulse TV preview is running.\n');
  console.log('  TV screen:      ' + env.base + '/tv?k=' + key);
  console.log('  TV demo board:  ' + env.base + '/tv?demo=1   (made-up numbers from public/data/mock.json)');
  console.log('  Dashboard:      ' + env.base + '/   (sign-in will not work here; use the TV link)\n');
  console.log('Press Ctrl+C to stop.');
})().catch(e => { console.error(e); process.exit(1); });
