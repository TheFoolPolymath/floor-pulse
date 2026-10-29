'use strict';
/*
 * The HTTP layer. One endpoint for the app: POST /api with a JSON body { action, token, device, ... }.
 * Responses keep the shape the website already uses: { ok: true, ... } or { error, message }.
 * Application errors are returned with HTTP 200 (the website reads the error field), as before.
 * Also serves the website from ./public unless SERVE_STATIC=false.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { str, fail } = require('./util');
const { makeToken, readToken } = require('./security');
const { verifyGoogleIdToken } = require('./auth');
const { accessFor, teamExists, touchDevice, audit } = require('./context');
const { buildData } = require('./data');
const { writeAction, directoryOut } = require('./actions');
const { tvBoard, tvKeyAdmin } = require('./tv');

const ADMIN_ACTIONS = { staff_add: 1, staff_remove: 1, team_add: 1, access_set: 1, access_revoke: 1, dir_save: 1, target_set: 1, remark_add: 1, remark_void: 1, sync_backend: 1 };
const CASE_ACTIONS = { case_add: 1, case_stage: 1, case_note: 1 };   // admin, or a team leader for their own team

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/** The one route for everything the app asks. Returns the response object. */
async function route(ctx, b) {
  const { cfg } = ctx;
  const action = str(b.action);
  const nowDate = ctx.now();

  // The TV display: public, but only with the secret link key (no sign-in, no personal data)
  if (action === 'tv') return tvBoard(ctx, b.key);

  if (action === 'login') {
    const g = await verifyGoogleIdToken(b.id_token, cfg.googleClientId, ctx.fetch, nowDate.getTime());
    const acc = await accessFor(ctx, g.email);
    if (!acc) throw fail('not_allowed', 'The Google account ' + g.email + ' has not been given access. Ask your admin to add this email.');
    if (acc.role === 'TL' && !(await teamExists(ctx, acc.team_id))) throw fail('not_allowed', 'Your team (' + acc.team_id + ') was not found in Employees. Ask your admin.');
    await touchDevice(ctx, acc, b.device, true);
    return { ok: true, token: makeToken(acc.email, cfg.sessionSecret, nowDate.getTime(), cfg.sessionDays), user: { email: acc.email, name: acc.name || g.name, role: acc.role, team_id: acc.team_id } };
  }

  const email = readToken(b.token, cfg.sessionSecret, nowDate.getTime());
  if (!email) throw fail('auth', 'Your session has ended. Please sign in again.');
  const me = await accessFor(ctx, email);
  if (!me) throw fail('auth', 'Your access was removed or changed. Please sign in again, or ask your admin.');

  if (action === 'data') {
    if (me.role === 'TL' && !(await teamExists(ctx, me.team_id))) throw fail('noteam', 'Your team was not found. Ask your admin.');
    await touchDevice(ctx, me, b.device, false);
    return buildData(ctx, me);
  }

  if (action === 'tv_key_new' || action === 'tv_key_off') {
    if (me.role !== 'ADMIN') throw fail('forbidden', 'Only an admin can do this.');
    return ctx.lock.run(() => tvKeyAdmin(ctx, me, action));
  }

  if (action === 'directory') {   // personal, bank and salary data: admin only, never part of the normal data call
    if (me.role !== 'ADMIN') throw fail('forbidden', 'Only an admin can open the employee directory.');
    await audit(ctx, me, 'directory_open', '');
    return { ok: true, directory: await directoryOut(ctx) };
  }

  if (ADMIN_ACTIONS[action] || CASE_ACTIONS[action]) {
    if (ADMIN_ACTIONS[action] && me.role !== 'ADMIN') throw fail('forbidden', 'Only an admin can do this.');
    return ctx.lock.run(() => writeAction(ctx, action, b, me));
  }
  throw fail('bad_request', 'Unknown request.');
}

/** Turns any failure into the { error, message } shape the website expects. */
async function safeRoute(ctx, b) {
  try {
    return await route(ctx, b);
  } catch (err) {
    if (err.code) return { error: err.code, message: err.message };
    ctx.log('server error: ' + (err.stack || err.message));
    return { error: 'server', message: 'Something went wrong on the server: ' + err.message };
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(fail('bad_request', 'The request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(req, res, status, type, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = Object.assign({ 'content-type': type }, headers);
  const accepts = /gzip/.test(String(req.headers['accept-encoding'] || ''));
  if (accepts && buf.length > 860 && req.method !== 'HEAD') {
    zlib.gzip(buf, (e, z) => {
      if (e) { res.writeHead(status, h); res.end(buf); return; }
      res.writeHead(status, Object.assign(h, { 'content-encoding': 'gzip', vary: 'Accept-Encoding' }));
      res.end(z);
    });
    return;
  }
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, obj, headers = {}) {
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(obj), Object.assign({ 'cache-control': 'no-store' }, headers));
}

/** Serves the website. index.html and config.js are never cached; data files are never stored. */
function serveStatic(ctx, req, res, pathname) {
  const root = path.resolve(ctx.cfg.staticDir || path.join(__dirname, '..', 'public'));
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) { sendJson(req, res, 404, { error: 'not_found' }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { sendJson(req, res, 404, { error: 'not_found', message: 'Not found.' }); return; }
    const ext = path.extname(file).toLowerCase();
    const name = path.basename(file);
    let cache = 'public, max-age=3600';
    if (name === 'index.html' || name === 'config.js' || name === 'sw.js' || name === 'tv.html') cache = 'no-cache';
    if (rel.indexOf('/data/') >= 0) cache = 'no-store';
    send(req, res, 200, TYPES[ext] || 'application/octet-stream', data, { 'cache-control': cache });
  });
}

function createHandler(ctx) {
  const allowed = new Set(ctx.cfg.allowedOrigins || []);
  return async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const origin = req.headers.origin;
      if (origin && allowed.has(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/healthz') { sendJson(req, res, 200, { ok: true }); return; }
      if (url.pathname === '/api') {
        if (req.method === 'GET') { sendJson(req, res, 200, { ok: true, app: 'Floor Pulse API', hint: 'Open the dashboard website, not this link.' }); return; }
        if (req.method !== 'POST') { sendJson(req, res, 405, { error: 'bad_request', message: 'Use POST.' }); return; }
        let b;
        try { b = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
          sendJson(req, res, 200, { error: e.code || 'bad_request', message: e.code ? e.message : 'The request was not valid JSON.' });
          return;
        }
        const out = await safeRoute(ctx, b && typeof b === 'object' ? b : {});
        sendJson(req, res, 200, out);
        return;
      }
      if (ctx.cfg.serveStatic && (req.method === 'GET' || req.method === 'HEAD')) {
        serveStatic(ctx, req, res, url.pathname === '/tv' ? '/tv.html' : url.pathname);   // /tv is the friendly address of the TV page
        return;
      }
      sendJson(req, res, 404, { error: 'not_found' });
    } catch (err) {
      ctx.log('request error: ' + (err.stack || err.message));
      if (!res.headersSent) sendJson(req, res, 200, { error: err.code || 'server', message: err.code ? err.message : 'Something went wrong on the server.' });
    }
  };
}

module.exports = { createHandler, route, safeRoute, ADMIN_ACTIONS, CASE_ACTIONS };
