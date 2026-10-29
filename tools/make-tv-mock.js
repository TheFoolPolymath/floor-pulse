/**
 * Builds the TV demo board from public/data/mock.json, using the SAME code the live server uses (server/tv.js).
 *   node tools/make-tv-mock.js
 * Writes public/data/tv.json. The TV page (tv.html?demo=1) reads it when there is no live server.
 * Run it again after make-mock.js changes the demo numbers.
 */
const fs = require('fs'), path = require('path');
const { buildTv } = require('../server/tv');

const DATA = path.join(__dirname, '..', 'public', 'data');
const mock = JSON.parse(fs.readFileSync(path.join(DATA, 'mock.json'), 'utf8'));

// A stand-in for the database and the sheet cache, fed from the mock file.
const asof = new Date(mock.meta.asof);
const ctx = {
  db: null,
  now: () => asof,
  cfg: { branch: mock.meta.branch },
  repo: {
    employees: async () => mock.employees,
    config: async () => mock.config
  },
  store: {
    snapshot: async () => ({ attendance: mock.attendance, kpi: mock.kpi, calls: mock.calls })
  }
};

buildTv(ctx).then((board) => {
  board.demo = true;
  board.note = 'Demo data from public/data/mock.json. Made-up staff and numbers.';
  fs.writeFileSync(path.join(DATA, 'tv.json'), JSON.stringify(board));
  const p = board.periods.week.people.length;
  console.log('Wrote public/data/tv.json: ' + board.periods.week.teams.length + ' teams, ' + p + ' telecallers, ' + board.series.length + ' working days.');
}).catch((e) => { console.error(e); process.exit(1); });
