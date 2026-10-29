'use strict';
/*
 * Session tokens and encryption for the most sensitive directory fields.
 *  - Tokens: "<payload>.<HMAC>". The payload holds the email and an expiry time.
 *  - Field encryption: AES-256-GCM. PAN, Aadhaar and bank account numbers are stored encrypted,
 *    so someone who reads the database alone cannot read them. Losing DATA_KEY loses them.
 */
const crypto = require('crypto');
const { fail } = require('./util');

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** A session token for this email, valid for `days` days from `nowMs`. */
function makeToken(email, secret, nowMs, days) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Math.floor(nowMs / 1000) + days * 86400 })).toString('base64url');
  return payload + '.' + sign(payload, secret);
}

/** Returns the email inside a valid, unexpired token, or null. */
function readToken(token, secret, nowMs) {
  const t = String(token || '');
  const i = t.indexOf('.');
  if (i < 1) return null;
  const payload = t.slice(0, i), given = Buffer.from(t.slice(i + 1));
  const want = Buffer.from(sign(payload, secret));
  if (want.length !== given.length || !crypto.timingSafeEqual(want, given)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!o || !o.e || !(o.x > nowMs / 1000)) return null;
  return String(o.e);
}

/** DATA_KEY from the environment, as 32 raw bytes. Null when it is not set. */
function parseDataKey(b64) {
  if (!b64) return null;
  const k = Buffer.from(String(b64), 'base64');
  if (k.length !== 32) throw fail('config', 'DATA_KEY must be 32 random bytes encoded as base64.');
  return k;
}

const BOX = 'v1:';

function encryptField(plain, key) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  if (!key) throw fail('config', 'DATA_KEY is not set on the server, so this directory field cannot be saved.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return BOX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decryptField(stored, key) {
  const s = String(stored || '');
  if (!s) return '';
  if (!s.startsWith(BOX)) throw fail('config', 'A stored directory field is not encrypted. Run the migration again with DATA_KEY set.');
  if (!key) throw fail('config', 'DATA_KEY is not set on the server, so directory fields cannot be read.');
  const raw = Buffer.from(s.slice(BOX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { makeToken, readToken, parseDataKey, encryptField, decryptField };
