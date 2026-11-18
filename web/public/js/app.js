/* suprplorer client: relative times, charts (uPlot), live refresh, search shortcut, copy buttons */
(function () {
  'use strict';
  var css = getComputedStyle(document.documentElement);
  var C = function (n) { return css.getPropertyValue(n).trim(); };

  // ------------------------------------------------------------ relative times
  function ago(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function tick() {
    var els = document.querySelectorAll('[data-ts]');
    for (var i = 0; i < els.length; i++) els[i].textContent = ago(+els[i].getAttribute('data-ts'));
  }
  tick();
  setInterval(tick, 1000);

  // ------------------------------------------------------------ number formats
  function compact(n) {
    var u = [['', 1], ['K', 1e3], ['M', 1e6], ['G', 1e9], ['T', 1e12], ['P', 1e15], ['E', 1e18]], x = u[0];
    for (var i = 0; i < u.length; i++) if (Math.abs(n) >= u[i][1]) x = u[i];
    var v = n / x[1];
    return (x[1] === 1 ? +v.toFixed(v < 10 ? 2 : 1) : +v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)) + x[0];
  }
  var FMT = {
    hashrate: function (v) { return compact(v) + 'H/s'; },
    compact: compact,
    int: function (v) { return Math.round(v).toLocaleString('en-US'); },
    coins: function (v) { return v.toLocaleString('en-US', { maximumFractionDigits: 2 }); },
    seconds: function (v) { return v < 90 ? Math.round(v) + 's' : (v / 60).toFixed(1) + 'm'; }
  };
  function fmtDate(ts, span) {
    var d = new Date(ts * 1000);
    var mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    var hm = ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
    return span > 2 * 86400 ? mon + ' ' + d.getUTCDate() : hm;
  }

  // ------------------------------------------------------------ charts
  function hexA(c, a) { // '#rrggbb' + alpha, or an hsl() colour with alpha
    if (c.charAt(0) === '#') return c + ('0' + Math.round(a * 255).toString(16)).slice(-2);
    return c.replace(/\)$/, ' / ' + a + ')');
  }
  function makeChart(el) {
    var cfg = JSON.parse(el.textContent);
    var host = document.getElementById(cfg.target);
    if (!host) return;
    if (!window.uPlot || !cfg.x || cfg.x.length < 2) {
      host.innerHTML = '<div class="chart-empty">Not enough blocks in this range yet.</div>';
      return;
    }
    var color = cfg.color || C('--accent');
    var fmt = FMT[cfg.format] || FMT.compact;
    var span = cfg.x[cfg.x.length - 1] - cfg.x[0];
    var stacked = !!cfg.stack;
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;

    // stacked bars: series k shows the sum of series k..n, drawn largest first so each colour shows its own slice
    var data = [cfg.x], series = [{}];
    if (stacked) {
      var n = cfg.stack.length;
      for (var k = 0; k < n; k++) {
        data.push(cfg.x.map(function (_, i) {
          var sum = 0;
          for (var j = k; j < n; j++) sum += cfg.stack[j].y[i];
          return sum;
        }));
        series.push({ stroke: cfg.stack[k].color, fill: cfg.stack[k].color, width: 0,
          paths: uPlot.paths.bars({ size: [0.78, 40], gap: 2, radius: 0.15 }), points: { show: false } });
      }
    } else {
      data.push(cfg.y);
      series.push(cfg.bars
        ? { stroke: color, fill: hexA(color, 0.85), width: 0, paths: uPlot.paths.bars({ size: [0.7, 28], radius: 0.25 }), points: { show: false } }
        : { stroke: color, width: 2, paths: cfg.step ? uPlot.paths.stepped({ align: 1 }) : uPlot.paths.spline(), points: { show: false },
            fill: function (u) {
              var g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
              g.addColorStop(0, hexA(color, 0.32));
              g.addColorStop(0.65, hexA(color, 0.06));
              g.addColorStop(1, hexA(color, 0));
              return g;
            } });
    }
    var axis = { stroke: C('--dim'), font: '500 11px Geist, sans-serif', ticks: { show: false }, border: { show: false } };
    var opts = {
      width: host.clientWidth, height: host.clientHeight,
      padding: [14, 16, 0, 0],
      legend: { show: false },
      cursor: { points: { size: 9, width: 2, fill: C('--bg'), stroke: stacked ? 'transparent' : color },
                x: true, y: false, drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { range: function (u, min, max) {
        if (cfg.zero || stacked || cfg.bars) return [0, (max || 1) * 1.15];
        var pad = (max - min) * 0.2 || Math.abs(max) * 0.1 || 1;
        return [Math.max(0, min - pad), max + pad];
      } } },
      axes: [
        Object.assign({}, axis, { size: 30, space: 80, grid: { show: false },
          values: function (u, vals) { return vals.map(function (v) { return fmtDate(v, span); }); } }),
        Object.assign({}, axis, { size: 54, space: 40, grid: { stroke: C('--line-soft'), width: 1, dash: [3, 4] },
          values: function (u, vals) { return vals.map(fmt); } })
      ],
      series: series,
      hooks: {
        draw: [function (u) { // glowing marker on the latest value of a line chart
          if (stacked || cfg.bars) return;
          var i = u.data[1].length - 1, v = u.data[1][i];
          if (v == null) return;
          var x = u.valToPos(u.data[0][i], 'x', true), y = u.valToPos(v, 'y', true), c = u.ctx, r = devicePixelRatio;
          c.save();
          c.beginPath(); c.arc(x, y, 9 * r, 0, 2 * Math.PI); c.fillStyle = hexA(color, 0.18); c.fill();
          c.beginPath(); c.arc(x, y, 4 * r, 0, 2 * Math.PI); c.fillStyle = color; c.fill();
          c.restore();
        }],
        setCursor: [function (u) {
          var i = u.cursor.idx;
          if (i == null || u.cursor.left < 0) { tip.hidden = true; return; }
          var when = new Date(u.data[0][i] * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
          var html;
          if (stacked) {
            html = cfg.stack.map(function (s) {
              return s.y[i] ? '<div><i class="dot" style="--c:' + s.color + '"></i> ' + s.label + ' <b>' + s.y[i] + '</b></div>' : '';
            }).join('') + '<div class="when">' + when + '</div>';
          } else {
            html = '<b>' + fmt(u.data[1][i]) + '</b> ' + (cfg.unit || '') + '<div class="when">' + when + '</div>';
          }
          tip.innerHTML = html;
          tip.hidden = false;
          var left = u.cursor.left, w = u.over.clientWidth;
          tip.style.left = Math.min(Math.max(left, 70), w - 70) + 'px';
          tip.style.top = (stacked || cfg.bars ? 10 : Math.max(10, u.valToPos(u.data[1][i], 'y'))) + 'px';
        }]
      }
    };
    var u = new uPlot(opts, data, host);
    u.over.appendChild(tip);
    u.over.addEventListener('mouseleave', function () { tip.hidden = true; });
    new ResizeObserver(function () { u.setSize({ width: host.clientWidth, height: host.clientHeight }); }).observe(host);
  }
  var charts = document.querySelectorAll('script[type="application/json"][data-chart]');
  for (var i = 0; i < charts.length; i++) {
    try { makeChart(charts[i]); } catch (e) { if (window.console) console.error(e); }
  }

  // ------------------------------------------------------------ live: header tip + overview fragments
  var liveRegion = document.querySelector('[data-live]');
  var tipEl = document.querySelector('[data-live-tip]');
  var lastHeight = null, busy = false;
  function refreshRegion(newBlock) {
    if (!liveRegion || busy) return;
    busy = true;
    fetch(liveRegion.getAttribute('data-live'), { headers: { 'Accept': 'text/html' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        liveRegion.innerHTML = html;
        tick();
        if (newBlock) {
          var tile = liveRegion.querySelector('.lane a.newest');
          if (tile) tile.classList.add('arrived');
        }
      })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  function pollTip() {
    if (!tipEl || document.hidden) return;
    fetch(tipEl.getAttribute('data-live-tip'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (!t || t.height == null) { tipEl.classList.add('stale'); return; }
        var h = tipEl.querySelector('.live-height'), a = tipEl.querySelector('.live-age');
        h.textContent = 'Block #' + t.height.toLocaleString('en-US');
        a.setAttribute('data-ts', t.time);
        a.textContent = ago(t.time);
        // no block for 15 minutes on a one-minute chain: show the indicator as stale
        tipEl.classList.toggle('stale', Date.now() / 1000 - t.time > 900);
        if (lastHeight !== null && t.height !== lastHeight) {
          tipEl.classList.add('flash');
          setTimeout(function () { tipEl.classList.remove('flash'); }, 2500);
          refreshRegion(true);
        }
        lastHeight = t.height;
      })
      .catch(function () { tipEl.classList.add('stale'); });
  }
  if (tipEl) { pollTip(); setInterval(pollTip, 8000); }
  if (liveRegion) setInterval(function () { if (!document.hidden) refreshRegion(false); }, 60000); // ages, miners
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pollTip(); });

  // ------------------------------------------------------------ search shortcut
  document.addEventListener('keydown', function (e) {
    var t = e.target.tagName;
    if (e.key === '/' && t !== 'INPUT' && t !== 'TEXTAREA') {
      var s = document.querySelector('.hero-search input') || document.querySelector('.topsearch input');
      if (s) { e.preventDefault(); s.focus(); s.select(); }
    } else if (e.key === 'Escape' && t === 'INPUT') {
      e.target.blur();
    }
  });

  // ------------------------------------------------------------ copy buttons
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
      var old = b.textContent;
      b.textContent = 'Copied';
      b.classList.add('done');
      setTimeout(function () { b.textContent = old; b.classList.remove('done'); }, 1400);
    });
  });
})();
