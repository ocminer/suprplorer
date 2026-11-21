'use strict';
// Mining calculator: benchmarks (repository file + daily miner imports) against the network per model.
const fs = require('fs');
const path = require('path');

// repository file first, then automatic imports; for the same miner, card and power the newer version wins,
// and on the same version the repository file wins (it is reviewed)
const DIRS = (process.env.SUPRPLORER_BENCHMARK_DIRS || '/opt/suprplorer/benchmarks:/var/lib/suprplorer/benchmarks')
  .split(':').filter(Boolean);
const cache = new Map();

function readJson(file) {
  try {
    const st = fs.statSync(file);
    const c = cache.get(file);
    if (c && c.mtime === st.mtimeMs) return c.doc;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtime: st.mtimeMs, doc });
    return doc;
  } catch {
    return null;
  }
}

const vkey = v => String(v).split(/[.+_-]/).map(x => (/^\d+$/.test(x) ? x.padStart(6, '0') : x)).join('.');

function loadBenchmarks(coinId, models) {
  const best = new Map();
  DIRS.forEach((dir, rank) => {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f === `${coinId}.json` || (f.startsWith(`${coinId}-`) && f.endsWith('.json'))); } catch {}
    for (const f of files.sort()) {
      const doc = readJson(path.join(dir, f));
      if (!doc || doc.coin !== coinId || !Array.isArray(doc.benchmarks)) continue;
      for (const b of doc.benchmarks) {
        if (!b || !b.rates || !models.every(m => Number(b.rates[m]) > 0)) continue;
        const key = `${b.miner}|${b.gpu}|${b.power_w}`;
        const cur = best.get(key);
        const better = !cur || vkey(b.version) > vkey(cur.version) || (vkey(b.version) === vkey(cur.version) && rank < cur.rank);
        if (better) best.set(key, { ...b, rank, auto: rank > 0 });
      }
    }
  });
  return [...best.values()];
}

// network per model over a window: blocks per day on that model and its attempts per second
function network(models, stats, windowSecs) {
  return models.map((m, i) => {
    const s = stats[i] || {};
    return { id: m.id, name: m.name, color: m.color, hashrate: s.hashrate || 0, blockTime: s.blockTime || null,
      blocksPerDay: (s.blocks || 0) * 86400 / windowSecs };
  });
}

// expected blocks per day of one card: per model, its share of that model's attempts times that model's blocks
function blocksPerDay(rates, net) {
  return net.reduce((sum, n) => sum + (n.hashrate > 0 ? n.blocksPerDay * (rates[n.id] || 0) / n.hashrate : 0), 0);
}

module.exports = { loadBenchmarks, network, blocksPerDay };
