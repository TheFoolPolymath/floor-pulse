'use strict';
/* The TV display: secret link key, admin-only link management, and public data only (no money, customers or remarks). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');

const PRIVATE_WORDS = ['disbursed_amount', 'amount', 'customer', 'bank', 'remark', 'pan', 'aadhaar', 'account', 'attendance', 'directory', 'devices', 'cases', 'reason'];

test('TV: no key set means the display is off; a wrong key is refused', async () => {
  const env = await makeEnv();
  try {
    const off = await env.call({ action: 'tv', key: 'anything' });
    assert.equal(off.error, 'tv_off');
    const tok = await env.signIn('admin@gmail.com', 'Admin');
    const made = await env.call({ action: 'tv_key_new', token: tok });
    assert.equal(made.ok, true);
    const wrong = await env.call({ action: 'tv', key: made.key + 'x' });
    assert.equal(wrong.error, 'tv_key');
    const none = await env.call({ action: 'tv', key: '' });
    assert.equal(none.error, 'tv_key');
  } finally { await env.close(); }
});

test('TV: only an admin can make or switch off a link', async () => {
  const env = await makeEnv();
  try {
    const tl = await env.signIn('asha@gmail.com', 'Asha Rao');
    const r = await env.call({ action: 'tv_key_new', token: tl });
    assert.equal(r.error, 'forbidden');
    const noSession = await env.call({ action: 'tv_key_new' });
    assert.equal(noSession.error, 'auth');
  } finally { await env.close(); }
});

test('TV: the link shows team and telecaller scores, and no private data', async () => {
  const env = await makeEnv();
  try {
    const tok = await env.signIn('admin@gmail.com', 'Admin');
    const { key } = await env.call({ action: 'tv_key_new', token: tok });
    const d = await env.call({ action: 'tv', key });
    assert.equal(d.ok, true);
    assert.ok(d.periods.today && d.periods.week, 'both periods are there');
    const t = d.periods.week;
    assert.ok(t.teams.length >= 2, 'teams are listed');
    assert.ok(t.people.some(p => p.name === 'Rahul Verma'), 'telecallers are listed by name');
    assert.ok(t.people.every(p => typeof p.score === 'number' && p.score >= 0 && p.score <= 100), 'scores are 0 to 100');
    assert.ok(t.people.every((p, i, all) => i === 0 || all[i - 1].score >= p.score), 'people are ranked best first');
    const text = JSON.stringify(d).toLowerCase();
    for (const w of PRIVATE_WORDS) {
      assert.ok(!text.includes('"' + w), 'the public board must not contain a ' + w + ' field');
    }
    assert.ok(!text.includes('150000'), 'no rupee amounts');
    assert.ok(!text.includes('emp004'), 'people who left are not on the board');
    assert.ok(Array.isArray(d.series) && d.series.length >= 1, 'a day-by-day series for the charts');
    assert.ok(d.periods.today.totals && typeof d.periods.today.totals.score === 'number', 'branch totals are there');
  } finally { await env.close(); }
});

test('TV: a new link stops the old one; switching off stops all links', async () => {
  const env = await makeEnv();
  try {
    const tok = await env.signIn('admin@gmail.com', 'Admin');
    const first = (await env.call({ action: 'tv_key_new', token: tok })).key;
    const second = (await env.call({ action: 'tv_key_new', token: tok })).key;
    assert.notEqual(first, second);
    assert.equal((await env.call({ action: 'tv', key: first })).error, 'tv_key', 'old link is dead');
    assert.equal((await env.call({ action: 'tv', key: second })).ok, true, 'new link works');
    await env.call({ action: 'tv_key_off', token: tok });
    assert.equal((await env.call({ action: 'tv', key: second })).error, 'tv_off', 'switched off');
  } finally { await env.close(); }
});
