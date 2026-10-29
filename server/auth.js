'use strict';
/* Google proves who the person is. The Access list decides whether they may come in. */
const { str, fail } = require('./util');

/** Checks a Google sign-in token with Google and returns the verified email and name. */
async function verifyGoogleIdToken(idToken, clientId, fetchImpl = globalThis.fetch, nowMs = Date.now()) {
  if (!str(idToken)) throw fail('login', 'No Google sign-in was received. Please try again.');
  if (!clientId) throw fail('config', 'GOOGLE_CLIENT_ID is not set on the server.');
  const res = await fetchImpl('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) throw fail('login', 'Google could not verify this sign-in. Please try again.');
  const t = await res.json();
  if (t.aud !== clientId) throw fail('config', 'The Client ID the website uses and GOOGLE_CLIENT_ID on the server do not match.');
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw fail('login', 'This sign-in did not come from Google.');
  if (String(t.email_verified) !== 'true') throw fail('login', 'This Google account has no verified email.');
  if (Number(t.exp) * 1000 < nowMs) throw fail('login', 'This sign-in has expired. Please try again.');
  return { email: str(t.email), name: str(t.name) };
}

module.exports = { verifyGoogleIdToken };
