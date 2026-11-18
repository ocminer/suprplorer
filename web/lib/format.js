'use strict';
// Formatting helpers shared by the server and the templates.

const group = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// BigInt base units -> { int, frac } with trailing zeros trimmed to `min` digits
function amountParts(v, decimals = 8, min = 2, max = 8) {
  v = BigInt(v);
  const neg = v < 0n;
  if (neg) v = -v;
  const unit = 10n ** BigInt(decimals);
  let frac = (v % unit).toString().padStart(decimals, '0').slice(0, max);
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  return { neg, int: group((v / unit).toString()), frac };
}

function amount(v, decimals = 8, min = 2, max = 8) {
  const p = amountParts(v, decimals, min, max);
  return (p.neg ? '-' : '') + p.int + (p.frac ? '.' + p.frac : '');
}

// BigInt base units -> Number of coins (for charts and percentages only)
const coins = (v, decimals = 8) => Number(BigInt(v)) / 10 ** decimals;

function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '–';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function compact(n, digits = 1) {
  if (n == null) return '–';
  const units = [['', 1], ['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12], ['P', 1e15], ['E', 1e18]];
  let u = units[0];
  for (const x of units) if (Math.abs(n) >= x[1]) u = x;
  return (n / u[1]).toFixed(u[1] === 1 ? 0 : digits).replace(/\.0+$/, '') + u[0];
}

function hashrate(h) {
  const units = [['H/s', 1], ['kH/s', 1e3], ['MH/s', 1e6], ['GH/s', 1e9], ['TH/s', 1e12], ['PH/s', 1e15], ['EH/s', 1e18]];
  let u = units[0];
  for (const x of units) if (h >= x[1]) u = x;
  const v = h / u[1];
  return { value: v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), unit: u[0] };
}

const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? s.slice(0, a) + '…' + s.slice(-b) : s || '');

function ago(ts, now = Date.now() / 1000) {
  const s = Math.max(0, Math.floor(now - ts));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  return Math.floor(s / 86400) + 'd ago';
}

function utc(ts) {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function duration(s) {
  if (s == null) return '–';
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
}

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1048576).toFixed(2) + ' MB';
}

// stable colour per pool / miner name (hue from a string hash)
function colorFor(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360);
  return `hsl(${hue} 72% 64%)`;
}

// HTML escape for the few places where a string is placed into raw HTML
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { esc, amountParts, amount, coins, num, compact, hashrate, short, ago, utc, duration, bytes, colorFor };
