'use strict';
// Trend projection: a straight line (least squares) through a recent window, projected ahead with a
// band of +-1.64 residual standard deviations (about 90% if the residuals were normal). A straight line
// on purpose: an exponential fit on a young, fast-growing chain compounds into absurd numbers. This
// extends the recent trend; it is no prediction of what miners will do, and the page says so.

function project(x, y, { windowSecs = 24 * 3600, aheadSecs = 24 * 3600, step = null } = {}) {
  const end = x.length ? x[x.length - 1] : 0;
  const pts = [];
  for (let i = 0; i < x.length; i++) if (y[i] > 0 && x[i] >= end - windowSecs) pts.push([x[i], y[i]]);
  if (pts.length < 6) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [a, b] of pts) { sxx += (a - mx) ** 2; sxy += (a - mx) * (b - my); }
  const slope = sxx ? sxy / sxx : 0;
  const at = t => my + slope * (t - mx);
  const resid = Math.sqrt(pts.reduce((s, [a, b]) => s + (b - at(a)) ** 2, 0) / Math.max(1, n - 2));
  const dt = step || (x.length > 1 ? x[x.length - 1] - x[x.length - 2] : 3600);
  const fx = [];
  for (let t = end; t <= end + aheadSecs + 1; t += dt) fx.push(t);
  const z = 1.64;
  const pos = v => Math.max(0, v);
  const now = pos(at(end));
  return {
    perDay: now > 0 ? (slope * 86400) / now : 0,      // trend change per day relative to now, 0.12 = +12%/day
    now,
    ahead: pos(at(end + aheadSecs)),
    lo: pos(at(end + aheadSecs) - z * resid),
    hi: pos(at(end + aheadSecs) + z * resid),
    x: fx,
    mid: fx.map(t => pos(at(t))),
    low: fx.map(t => pos(at(t) - z * resid)),
    high: fx.map(t => pos(at(t) + z * resid)),
    points: n,
  };
}

// one chart from history plus projection: x covers both, each line is null where it has no value
function chart(x, y, p, color) {
  const hx = x.slice();
  const all = hx.concat(p.x.slice(1));
  const pad = new Array(p.x.length - 1).fill(null);
  const before = new Array(hx.length - 1).fill(null);
  return {
    x: all,
    lines: [
      { label: 'Measured', color, y: y.concat(pad), fill: true },
      { label: 'Trend', color: '#e8ebf4', dash: [6, 4], y: before.concat(p.mid) },
      { label: 'Band, low', color: '#5e6784', dash: [2, 4], y: before.concat(p.low) },
      { label: 'Band, high', color: '#5e6784', dash: [2, 4], y: before.concat(p.high) },
    ],
  };
}

module.exports = { project, chart };
