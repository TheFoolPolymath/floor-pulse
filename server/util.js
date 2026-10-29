'use strict';
/* Small shared helpers. Every calendar date is a yyyy-mm-dd string in India time (IST, UTC+5:30). */

const DAY_MS = 864e5;
const IST_MS = 5.5 * 3600e3;

const str = (v) => String(v == null ? '' : v).trim();
const pad = (n) => { n = String(n); return n.length < 2 ? '0' + n : n; };

/** Numbers may come as text with commas, rupee signs or spaces ("4,50,000", "₹25,000"). */
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = Number(str(v).replace(/[₹,\s]/g, ''));
  return isFinite(n) ? n : 0;
}

/** An error the API can show to the user. `code` decides the response. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Trim, drop line breaks and cap the length. Used for every free-text field. */
function clean(v, max = 100) {
  return str(v).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

/** For writing text into a sheet: stops "=IMPORTXML(...)" from becoming a live formula. */
function sheetSafe(v, max = 100) {
  const s = clean(v, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Gmail ignores dots and +tags, so a.b+x@gmail.com and ab@gmail.com are the same person. */
function normEmail(e) {
  e = str(e).toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let u = e.slice(0, at), d = e.slice(at + 1);
  if (d === 'gmail.com' || d === 'googlemail.com') {
    u = u.split('+')[0].replace(/\./g, '');
    d = 'gmail.com';
  }
  return u + '@' + d;
}

/** yyyy-mm-dd in India time for a timestamp in milliseconds. */
function istDate(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
function todayIST(now) { return istDate(now.getTime()); }
/** Adds n days to a yyyy-mm-dd string (calendar arithmetic, no time-zone surprises). */
function addDays(ymd, n) { return new Date(Date.parse(ymd + 'T12:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
/** 0 = Sunday. Noon UTC is the same calendar day in India, so the weekday is safe. */
function weekday(ymd) { return new Date(Date.parse(ymd + 'T12:00:00Z')).getUTCDay(); }
function isSunday(ymd) { return weekday(ymd) === 0; }
/** Minutes after midnight in India time. */
function minutesIST(now) { const d = new Date(now.getTime() + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function hhmm(mins) { return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
/** "2026-10-27 14:05" in India time. */
function stampIST(now) { return todayIST(now) + ' ' + hhmm(minutesIST(now)); }
/** Timestamp from stampIST() back to milliseconds. */
function stampMs(s) {
  const m = str(s).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
  return m ? Date.parse(m[1] + 'T' + m[2] + ':00+05:30') : 0;
}

/**
 * Accepts yyyy-mm-dd, d/m/yyyy (day first, as Indian sheets show it), a Date,
 * or a Google Sheets date serial number. Always returns yyyy-mm-dd (or the text as it was).
 */
function dateStr(v) {
  if (v instanceof Date) return istDate(v.getTime());
  if (typeof v === 'number' && v > 20000 && v < 80000) return istDate(Date.UTC(1899, 11, 30) + v * DAY_MS);
  const s = str(v);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/))) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
  return s;
}

/** Returns a yyyy-mm-dd string, or '' when the value is empty. */
function dateOrEmpty(v) { return v == null || v === '' ? '' : dateStr(v); }

/** True when the string is a real calendar date in yyyy-mm-dd form. */
function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T12:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Column letters for a 1-based index: 1 -> A, 27 -> AA. */
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

module.exports = {
  DAY_MS, IST_MS, str, pad, num, fail, clean, sheetSafe, normEmail, istDate, todayIST, addDays,
  weekday, isSunday, minutesIST, hhmm, stampIST, stampMs, dateStr, dateOrEmpty, isYmd, colLetter
};
