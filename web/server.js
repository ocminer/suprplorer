'use strict';
// suprplorer-web: one process serves every coin at /<coin>/ from that coin's MySQL index.
// Whole responses are cached in Redis per (deploy, coin block generation, URL); the indexer
// bumps the generation on every connected/disconnected block, label changes bump it too.
const cluster = require('cluster');
const os = require('os');
const path = require('path');
const express = require('express');
const { createClient } = require('redis');
const { loadCoins } = require('./lib/coins');
const F = require('./lib/format');
const CALC = require('./lib/calc');
const FC = require('./lib/forecast');
const NV = require('./lib/netviz');

const PORT = Number(process.env.PORT || 3100);
const COINS_DIR = process.env.SUPRPLORER_COINS_DIR || path.join(__dirname, 'coins');
const WORKERS = Number(process.env.WEB_WORKERS || Math.min(4, os.cpus().length));
const CACHE_TTL = 300;
const BUILD_ID = process.env.BUILD_ID || Date.now().toString(36);
const RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: 0 };

// public site settings; GA4 and Search Console switch on when their ids are set in the environment
const SITE = {
  origin: (process.env.CANONICAL_ORIGIN || 'https://suprplorer.cc').replace(/\/$/, ''),
  name: 'Suprplorer',
  ga4: /^G-[A-Z0-9]{4,16}$/.test(process.env.GA4_ID || '') ? process.env.GA4_ID : null,
  gsv: /^[A-Za-z0-9_-]{10,100}$/.test(process.env.GOOGLE_SITE_VERIFICATION || '') ? process.env.GOOGLE_SITE_VERIFICATION : null,
  pool: 'https://neb.suprnova.cc',
  suprnova: 'https://www.suprnova.cc',
};

if (cluster.isPrimary && WORKERS > 1 && !process.env.NO_CLUSTER) {
  const env = { BUILD_ID };
  for (let i = 0; i < WORKERS; i++) cluster.fork(env);
  cluster.on('exit', (w, code) => {
    console.error(`worker ${w.process.pid} exited (${code}); restarting`);
    setTimeout(() => cluster.fork(env), 1000);
  });
  return;
}

// forensic flags written by the indexer (indexer.py FLAG_*)
const FLAGS = [
  [1, 'Self-change', 'An output pays back to one of the input addresses'],
  [2, 'Round payment', 'Exactly one output is a round amount, the other is likely change'],
  [4, 'Consolidation', 'Three or more inputs merged into one output'],
  [8, 'Fan-out', 'Ten or more outputs: batch payout, pool or exchange'],
  [16, 'Multisig spend', 'Spends a multisig output'],
  [32, 'Spends mined coins', 'Spends coinbase outputs'],
  [128, 'Shared inputs', 'Inputs from several addresses, likely one owner'],
];
const flagsOf = f => FLAGS.filter(([b]) => f & b).map(([, name, desc]) => ({ name, desc }));

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify({ method, params }),
    headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// cache key: the path plus only the query parameters the pages actually read, so random query
// strings cannot bypass the cache and hammer the database
const CACHE_PARAMS = ['range', 'page', 'live'];
function cacheUrl(req) {
  const q = CACHE_PARAMS.filter(k => typeof req.query[k] === 'string' && req.query[k].length <= 16)
    .map(k => `${k}=${encodeURIComponent(req.query[k])}`).join('&');
  return req.baseUrl + req.path + (q ? '?' + q : '');
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cacheMiddleware(redis, keyFn, ttl = CACHE_TTL) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = keyFn(req);
    try {
      const hit = await redis.get(key);
      if (hit) {
        const sep = hit.indexOf('\n');
        return res.set('X-Cache', 'HIT').type(hit.slice(0, sep)).send(hit.slice(sep + 1));
      }
    } catch {}
    const send = res.send.bind(res);
    res.send = body => {
      if (res.statusCode === 200 && typeof body === 'string')
        redis.set(key, (res.get('Content-Type') || 'text/html; charset=utf-8') + '\n' + body, { EX: ttl }).catch(() => {});
      res.set('X-Cache', 'MISS');
      return send(body);
    };
    next();
  };
}

// distinct hues that read well on the dark ground; the coin accent (teal) is kept out
const PALETTE = ['#5b8cff', '#f472b6', '#f2b84b', '#a78bfa', '#4ade80', '#fb923c', '#7dd3fc', '#e879f9', '#bef264', '#f87171'];

async function refreshLabels(coin) {
  const rows = (await coin.data.labels()).map(r => ({ ...r,
    category: r.category || (/burn|unspendable/i.test(r.label) ? 'burn' : /project/i.test(r.label) ? 'project' : 'other') }));
  // one colour per label name: hash into the palette, probe to the next free colour on a collision
  const names = [...new Set(rows.map(r => r.label))].sort();
  const used = new Set(), colors = {};
  for (const n of names) {
    let h = 2166136261;
    for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619);
    let i = (h >>> 0) % PALETTE.length, tries = 0;
    while (used.has(i) && tries++ < PALETTE.length) i = (i + 1) % PALETTE.length;
    colors[n] = used.size >= PALETTE.length ? F.colorFor(n) : PALETTE[i];
    used.add(i);
  }
  const map = {};
  const pct = v => (v == null ? null : Number(v));
  for (const r of rows) map[r.address] = { name: r.label, category: r.category, url: r.url || null,
    fee: pct(r.fee), minerFee: pct(r.miner_fee), feeSource: r.fee_source || null,
    color: r.category === 'burn' ? '#6b7280' : colors[r.label] };
  coin.labelMap = map;
}

// inbound peers are often home connections: show only the network part
function maskIp(ip) {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : ip;
}

// Is a peer a node that accepts connections? Outbound peers are (we dialled them). An inbound peer is tested
// once in a while with a plain TCP connect to the coin's peer port, in the background, so the page never waits.
// Only such nodes are shown with their full address (they announce themselves to the network anyway); the
// address of every other peer stays masked.
const PROBE_OK_TTL = 30 * 60 * 1000, PROBE_FAIL_TTL = 30 * 60 * 1000, PROBE_TIMEOUT = 2500, PROBE_PARALLEL = 8;
function probe(host, port) {
  return new Promise(resolve => {
    const s = require('net').createConnection({ host, port, timeout: PROBE_TIMEOUT });
    const done = ok => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
function probeLater(coin, ips, port) {
  coin.probes = coin.probes || new Map();
  const now = Date.now();
  const todo = ips.filter(ip => {
    const r = coin.probes.get(ip);
    return !r || (!r.busy && now - r.at > (r.ok ? PROBE_OK_TTL : PROBE_FAIL_TTL));
  });
  for (const ip of todo) coin.probes.set(ip, { ...(coin.probes.get(ip) || { ok: null }), busy: true, at: now });
  let i = 0;
  const next = () => {
    if (i >= todo.length) return;
    const ip = todo[i++];
    probe(ip, port).then(ok => { coin.probes.set(ip, { ok, at: Date.now(), busy: false }); next(); });
  };
  for (let k = 0; k < Math.min(PROBE_PARALLEL, todo.length); k++) next();
  if (coin.probes.size > 5000) for (const [ip, r] of coin.probes) if (now - r.at > 6 * 3600 * 1000) coin.probes.delete(ip);
}
const hostPort = (ip, port) => (ip.includes(':') ? `[${ip}]` : ip) + ':' + port;

async function getPeers(coin) {
  if (Date.now() - coin.peers.at < 15000) return coin.peers;
  try {
    const [raw, info] = await Promise.all([rpc(coin.rpc, 'getpeerinfo'), rpc(coin.rpc, 'getinfo')]);
    const p2p = Number(info && info.p2pport) || coin.p2pPort || null;
    const peers = raw.filter(p => p.handshake !== false).map(p => {
      const a = String(p.addr || '');
      const i = a.lastIndexOf(':');
      const ip = i > 0 ? a.slice(0, i).replace(/^\[|\]$/g, '') : a;
      const port = i > 0 ? Number(a.slice(i + 1)) : null;
      return { ip, port, inbound: !!p.inbound, protocol: p.version,
        agent: String(p.subver || '').replace(/^\/|\/$/g, '') || 'unknown', height: p.height, connected: p.connected };
    });
    if (p2p) probeLater(coin, [...new Set(peers.filter(p => p.inbound).map(p => p.ip))], p2p);
    const list = peers.map(p => {
      const pr = coin.probes && coin.probes.get(p.ip);
      const open = !p.inbound ? !!p.port : !!(pr && pr.ok && p2p);
      const node = open ? hostPort(p.ip, p.inbound ? p2p : p.port) : null;
      // never hand the full address of a peer that does not accept connections to the page
      return { node, masked: maskIp(p.ip), inbound: p.inbound, checked: !p.inbound || !!(pr && pr.ok != null),
        protocol: p.protocol, agent: p.agent, height: p.height, connected: p.connected };
    }).sort((a, b) => (!!b.node - !!a.node) || b.connected - a.connected);
    coin.peers = { at: Date.now(), info, list, p2p };
  } catch (e) {
    console.error(coin.id, 'peers:', e.message);
    coin.peers.at = Date.now();
  }
  return coin.peers;
}

// ------------------------------------------------------------------ per coin

function coinRouter(coin, redis) {
  const r = express.Router();
  const D = coin.data;
  // the latest block for the header's live indicator (the indexer keeps it in Redis)
  r.use(async (req, res, next) => {
    try {
      const t = JSON.parse(await redis.get(`${coin.prefix}:tip`));
      res.locals.tipHeight = t.height;
      res.locals.tipTime = t.time;
    } catch { res.locals.tipHeight = null; res.locals.tipTime = null; }
    // the market price (price_watch keeps it in Redis; no key = no fresh price)
    try { res.locals.price = JSON.parse(await redis.get(`${coin.prefix}:price`)) || null; } catch { res.locals.price = null; }
    next();
  });
  const dec = coin.decimals;
  const cached = ttl => cacheMiddleware(redis, req => `${coin.prefix}:web:${BUILD_ID}:${coin.gen}:${cacheUrl(req)}`, ttl);

  const entity = addr => (addr && coin.labelMap[addr]) || null;
  const render = (res, view, title, locals) => res.render(view, { coin, title, entity, page: view, ...locals });
  const fail = (res, status, title, message) => res.status(status).render('error', { coin, entity, page: 'error', status, title, message, noindex: true });
  const notFound = (res, what) => fail(res, 404, `${what} not found`,
    `Nothing on the ${coin.name} chain matches this. Check the value and search again.`);
  const rangeOf = req => (Object.prototype.hasOwnProperty.call(RANGES, req.query.range) ? req.query.range : '24h');

  // group miner addresses into pools (labelled addresses) and individual miners
  const minerGroups = st => {
    const groups = new Map();
    for (const m of st.rows) {
      const e = entity(m.address);
      const key = e ? 'L:' + e.name : 'A:' + m.address;
      const g = groups.get(key) || { key, name: e ? e.name : null, category: e ? e.category : null,
        color: e ? e.color : null, address: m.address, addresses: 0, blocks: 0, earned: 0n, last: 0, lastTime: 0 };
      g.addresses += 1; g.blocks += m.blocks; g.earned += m.earned;
      if (m.last > g.last) { g.last = m.last; g.lastTime = m.lastTime; }
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.blocks - a.blocks || b.last - a.last)
      .map(g => ({ ...g, share: st.total ? (100 * g.blocks) / st.total : 0 }));
  };

  // donut segments: the largest groups by blocks, the rest folded into one segment
  const donut = (groups, n = 6) => {
    const top = groups.slice(0, n).map(g => ({ label: g.name || F.short(g.address, 8, 4), value: g.blocks,
      color: g.color || null, href: coin.base + '/address/' + g.address }));
    const rest = groups.slice(n).reduce((s, g) => s + g.blocks, 0);
    if (rest) top.push({ label: 'Other miners', value: rest, color: null });
    return top;
  };

  // blocks per bucket per pool (labelled) and one series for everyone else: stacked bars
  const poolStack = async (range, pools) => {
    const ms = await D.minerSeries(range);
    const names = pools.slice(0, 7).map(p => p.name);
    const buckets = new Map(), coins = new Map();
    for (const r of ms.rows) {
      const e = entity(r.address);
      const k = e && names.includes(e.name) ? e.name : '~other';
      const row = buckets.get(r.t) || {};
      row[k] = (row[k] || 0) + r.n;
      buckets.set(r.t, row);
      const cr = coins.get(r.t) || {};
      cr[k] = (cr[k] || 0) + r.earned / 10 ** dec;
      coins.set(r.t, cr);
    }
    if (!buckets.size) return null;
    const ts = [...buckets.keys()].sort((a, b) => a - b);
    const x = [];
    for (let t = ts[0]; t <= ts[ts.length - 1]; t += ms.bucket) x.push(t);
    const colorOf = n => { const e = Object.values(coin.labelMap).find(l => l.name === n); return e ? e.color : F.colorFor(n); };
    const series = names.map(n => ({ label: n, color: colorOf(n), y: x.map(t => (buckets.get(t) || {})[n] || 0) }));
    series.push({ label: 'Other miners', color: '#334061', y: x.map(t => (buckets.get(t) || {})['~other'] || 0) });
    // coins mined, cumulative over the range, per pool
    const cumulative = series.map(sr => {
      const key = sr.label === 'Other miners' ? '~other' : sr.label;
      let run = 0;
      return { label: sr.label, color: sr.label === 'Other miners' ? '#6b7699' : sr.color,
        y: x.map(t => (run += (coins.get(t) || {})[key] || 0)) };
    });
    // share of blocks per pool, smoothed over a rolling window of buckets
    const W = 4;
    const totals = x.map(t => Object.values(buckets.get(t) || {}).reduce((a, b) => a + b, 0));
    const shareLines = series.filter(sr => sr.label !== 'Other miners').slice(0, 6).map(sr => ({ label: sr.label, color: sr.color,
      y: x.map((_, i) => { let n = 0, d = 0; for (let j = Math.max(0, i - W + 1); j <= i; j++) { n += sr.y[j]; d += totals[j]; }
        return d ? (100 * n) / d : null; }) }));
    return { x, series, bucket: ms.bucket, cumulative, shareLines };
  };

  const overviewData = async () => {
    const [tip, act, act3h, series, lane, miners, transfers, g] = await Promise.all([
      D.tip(), D.activity(86400), D.activity(3 * 3600), D.series('24h'), D.blocks(60), D.miners(86400), D.transfers(8), D.genesis()]);
    const cap = BigInt(coin.maxSupply || 0) * 10n ** BigInt(dec) + (g ? g.carryover : 0n);
    const groups = minerGroups(miners);
    return { tip, act, act3h, series, lane, blocks: lane.slice(0, 12), miners: groups.slice(0, 8), donut: donut(groups),
      minersTotal: miners.total, transfers, cap };
  };

  // ---------------------------------------------------------- pages

  r.get('/', cached(), wrap(async (req, res) => {
    const d = await overviewData();
    if (req.query.live === '1') return res.render('partials/overview-live', { coin, entity, ...d });
    render(res, 'overview', `${coin.name} Block Explorer – blocks, mining pools and rich list`, { ...d,
      desc: `Live ${coin.fullName || coin.name} (${coin.symbol}) block explorer: latest blocks, who found them, mining pools, ` +
        `hashrate and difficulty charts, rich list and full address history. Height ${d.tip.height}.` });
  }));

  r.get('/blocks', cached(), wrap(async (req, res) => {
    const tip = await D.tip();
    const per = 50;
    const pages = Math.max(1, Math.ceil((tip.height + 1) / per));
    const pageNo = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
    render(res, 'blocks', `${coin.name} Blocks`, { desc: `All ${coin.name} blocks, newest first, with the pool or miner that found each one.`, tip, blocks: await D.blocks(per, (pageNo - 1) * per), pageNo, pages });
  }));

  r.get('/block/:id', cached(), wrap(async (req, res) => {
    const b = await D.block(req.params.id);
    if (!b) return notFound(res, 'Block');
    res.locals.canonical = `${SITE.origin}${coin.base}/block/${b.height}`;
    const e = entity(b.miner);
    const [btxs, shares] = await Promise.all([D.blockTxs(b.height), b.shares ? D.blockShares(b.height) : []]);
    render(res, 'block', `${coin.name} Block #${F.num(b.height)}`, { b, txs: btxs, shares, flagsOf,
      desc: `${coin.name} block ${b.height} mined ${F.utc(b.time)}${e ? ' by ' + e.name : ''}: ${b.txs} transactions, ` +
        `reward ${F.amount(b.reward + b.fees, dec, 2, 4)} ${coin.symbol}, difficulty ${F.num(b.difficulty, 2)}. Hash ${b.hash}.` });
  }));

  r.get('/tx/:txid', cached(), wrap(async (req, res) => {
    const tx = await D.tx(req.params.txid.toLowerCase());
    if (!tx) return notFound(res, 'Transaction');
    render(res, 'tx', `${coin.name} Transaction ${F.short(tx.txid, 10, 6)}`, { tx, flags: flagsOf(tx.flags),
      desc: `${coin.name} transaction ${tx.txid} in block ${tx.height}: ${F.amount(tx.totalOut, dec, 2, 8)} ${coin.symbol} to ` +
        `${tx.outputs.length} output(s), fee ${F.amount(tx.fee, dec, 0, 8)} ${coin.symbol}.` });
  }));

  r.get('/address/:addr', cached(), wrap(async (req, res) => {
    const a = await D.address(req.params.addr);
    if (!a) return notFound(res, 'Address');
    const per = 25;
    const pages = Math.max(1, Math.ceil(a.txs / per));
    const pageNo = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
    const [txs, history, utxos] = await Promise.all([D.addressTxs(a.address, per, (pageNo - 1) * per),
      D.balanceHistory(a.address), D.utxos(a.address, 50)]);
    const le = entity(a.address);
    render(res, 'address', `${le ? le.name + ' – ' : ''}${coin.name} Address ${F.short(a.address, 10, 6)}`, { a, label: le, txs: txs.rows,
      desc: `${le ? le.name + ' (' + le.category + '). ' : ''}${coin.name} address ${a.address}: balance ${F.amount(a.balance, dec, 2, 8)} ` +
        `${coin.symbol}, ${a.txs} transactions${a.blocksMined ? ', ' + a.blocksMined + ' blocks found' : ''}.`,
      pageNo, pages, utxos, chart: history.map(p => [p.t, F.coins(p.balance, dec)]) });
  }));

  r.get('/address/:addr/blocks', cached(), wrap(async (req, res) => {
    const a = await D.address(req.params.addr);
    if (!a) return notFound(res, 'Address');
    const per = 50;
    const pages = Math.max(1, Math.ceil(a.blocksMined / per));
    const pageNo = Math.min(Math.max(1, Number(req.query.page) || 1), pages);
    const { rows } = await D.blocksByMiner(a.address, per, (pageNo - 1) * per);
    render(res, 'miner-blocks', `Blocks found by ${entity(a.address) ? entity(a.address).name : F.short(a.address, 10, 6)}`,
      { a, label: entity(a.address), blocks: rows, pageNo, pages });
  }));

  r.get('/mining', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const secs = RANGES[range];
    const K = (coin.models || []).length;
    const [tip, act, series, miners, blocks, models, mseries, s7] = await Promise.all([D.tip(), D.activity(secs || 1e10), D.series(range),
      D.miners(secs), D.blocks(15), K > 1 ? D.modelStats(secs || 1e10, K) : null, K > 1 ? D.modelSeries(range, K) : null, D.series('7d')]);
    // trend of the last 48 hours projected 24 hours ahead (always from the 7-day series, whatever the range)
    const sx = s7.points.map(p => p.t);
    const recent = i => sx[i] >= sx[sx.length - 1] - 72 * 3600;
    const keepX = sx.filter((_, i) => recent(i));
    const fcH = FC.project(sx, s7.points.map(p => p.hashrate));
    const fcD = FC.project(sx, s7.points.map(p => p.difficulty));
    const forecast = fcH && fcD ? {
      hashrate: fcH, difficulty: fcD,
      hChart: FC.chart(keepX, s7.points.filter((_, i) => recent(i)).map(p => p.hashrate), fcH, coin.accent),
      dChart: FC.chart(keepX, s7.points.filter((_, i) => recent(i)).map(p => p.difficulty), fcD, '#8e7cf8'),
    } : null;
    render(res, 'mining', `${coin.name} Mining – hashrate, difficulty and top miners`, {
      desc: `${coin.name} mining statistics: estimated network hashrate per model, difficulty, block times, active miners and the miners that found the most blocks.`, range, tip, act, series, miners: minerGroups(miners),
      minersTotal: miners.total, blocks, models, mseries, forecast });
  }));

  r.get('/pools', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const secs = RANGES[range];
    const K = (coin.models || []).length;
    const [act, miners, byModel, models] = await Promise.all([D.activity(secs || 1e10), D.miners(secs),
      K > 1 ? D.minersByModel(secs, K) : [], K > 1 ? D.modelStats(secs || 1e10, K) : null]);
    const groups = minerGroups(miners);
    // estimated hashrate per group and model: its share of that model's blocks times the model's network hashrate
    if (models) {
      const slotTotals = models.map(m => m.blocks || 0);
      const per = new Map();
      for (const r of byModel) {
        const e = entity(r.address);
        const key = e ? 'L:' + e.name : 'A:' + r.address;
        const v = per.get(key) || new Array(K).fill(0);
        v[r.slot] += r.n;
        per.set(key, v);
      }
      for (const g of groups) {
        const v = per.get(g.key) || new Array(K).fill(0);
        g.models = v.map((n, i) => ({ blocks: n, share: slotTotals[i] ? n / slotTotals[i] : 0,
          hashrate: slotTotals[i] ? (n / slotTotals[i]) * models[i].hashrate : 0 }));
      }
    }
    for (const g of groups) {
      const l = g.name ? Object.values(coin.labelMap).find(x => x.name === g.name) : null;
      g.fee = l ? l.fee : null; g.minerFee = l ? l.minerFee : null; g.feeSource = l ? l.feeSource : null; g.url = l ? l.url : null;
    }
    const pools = groups.filter(g => g.category === 'pool');
    const others = groups.filter(g => g.category !== 'pool');
    const other = others.reduce((o, g) => ({ blocks: o.blocks + g.blocks, earned: o.earned + g.earned }), { blocks: 0, earned: 0n });
    render(res, 'pools', `${coin.name} Mining Pools – share of blocks`, {
      desc: `Which ${coin.name} mining pools find the blocks: pool shares, blocks per pool over time, rewards and payout addresses.`, range, act, pools, other, others: others.slice(0, 25),
      donut: donut(groups, 7), stack: await poolStack(range, pools), models,
      othersCount: others.length, total: miners.total, poolBlocks: pools.reduce((s, p) => s + p.blocks, 0),
      poolEarned: pools.reduce((s, p) => s + p.earned, 0n) });
  }));

  // reward schedule of the coin: reward at a height and the sum up to a height (base units, BigInt)
  const rewardAt = h => { const e = Math.floor(h / (coin.halving || Infinity)); return e >= 64 ? 0n : BigInt(coin.initialReward || 0) >> BigInt(e); };
  const scheduledUpTo = h => {
    let total = 0n, x = 0;
    const H = coin.halving || Infinity;
    while (x <= h) { const e = Math.floor(x / H); if (e >= 64) break; const end = Math.min(h, (e + 1) * H - 1);
      total += BigInt(end - x + 1) * rewardAt(x); x = end + 1; }
    return total;
  };

  r.get('/emission', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const [tip, g, series, d1, d7, watchRaw] = await Promise.all([D.tip(), D.genesis(), D.emissionSeries(range),
      D.issuance(86400), D.issuance(7 * 86400), redis.get(`${coin.prefix}:watch`).catch(() => null)]);
    const watch = watchRaw ? JSON.parse(watchRaw) : null;
    const allowed = g.carryover + scheduledUpTo(tip.height);
    const rNow = rewardAt(tip.height);
    const perDay = rNow * BigInt(Math.round(86400 / coin.blockTime));
    const nextHalving = coin.halving ? (Math.floor(tip.height / coin.halving) + 1) * coin.halving : null;
    const cap = BigInt(coin.maxSupply || 0) * 10n ** BigInt(dec) + g.carryover;
    // the schedule by time: where the supply would be if every block since genesis took exactly the target time
    const sched = series.points.map(p => {
      const h = Math.max(0, Math.floor((p.t + series.bucket - g.time) / coin.blockTime));
      return Number(g.carryover + scheduledUpTo(h)) / 10 ** dec;
    });
    // a young chain has not existed for the whole window: compare with the schedule of the time it has existed
    const age = Math.max(1, tip.time - g.time);
    const sched24 = rNow * BigInt(Math.round(Math.min(86400, age) / coin.blockTime));
    const sched7 = rNow * BigInt(Math.round(Math.min(7 * 86400, age) / coin.blockTime));
    // drop a first bucket that starts before the window: it is only partly inside and would read low
    const since = tip.time - (RANGES[range] || age);
    if (series.points.length > 2 && series.points[0].t < since && range !== 'all') { series.points.shift(); sched.shift(); }
    render(res, 'emission', `${coin.name} Emission – coins issued vs the reward schedule`, { sched24, sched7, age,
      desc: `How many ${coin.symbol} are issued per hour and per day, the supply against the reward schedule, the next halving and the live emission watch.`,
      range, tip, series, d1, d7, watch, allowed, rNow, perDay, nextHalving, cap, sched,
      expectedPerHour: Number(rNow) * 3600 / coin.blockTime / 10 ** dec });
  }));

  // the neural-network models the chain trains: published accuracy (verified against our node), training steps
  r.get('/models', cached(), wrap(async (req, res) => {
    const models = coin.models || [];
    if (!models.length) return fail(res, 404, 'Not available', 'This coin trains no models.');
    const K = models.length;
    const [tip, metaRaw, steps24, ...per] = await Promise.all([D.tip(), redis.get(`${coin.prefix}:models`).catch(() => null),
      D.trainingSteps(86400, K), ...models.map((m, i) => D.modelFrames(i)), ...models.map((m, i) => D.modelState(i))]);
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    const frames = per.slice(0, K), states = per.slice(K);
    const cards = models.map((m, i) => {
      const f = frames[i];
      const last = f[f.length - 1] || null;
      const dayAgo = f.filter(x => x.time <= tip.time - 86400).pop() || f[0] || null;
      const labels = meta && meta.labels ? Object.values(meta.labels)[i] : null;
      return { ...m, slot: i, last, first: f[0] || null, dayAgo, state: states[i], steps24: steps24[i],
        totalSteps: f.reduce((s, x) => s + x.steps, 0), labels, viz: last ? NV.diagram(last, labels) : null };
    });
    // accuracy over time on one shared time axis
    const xs = [...new Set(frames.flat().map(x => x.time))].sort((a, b) => a - b);
    const acc = models.map((m, i) => { const by = new Map(frames[i].map(x => [x.time, x.accuracy])); let lastV = null;
      return { label: m.name, color: m.color, y: xs.map(t => (by.has(t) ? (lastV = by.get(t)) : lastV)) }; });
    render(res, 'models', `${coin.name} Models – what the mining trains`, {
      desc: `${coin.name} mining trains neural networks: accuracy of the ${models.map(m => m.name).join(' and ')} models on samples they never saw, training steps per block and the network of each model.`,
      tip, cards, meta, accChart: { x: xs, lines: acc } });
  }));

  // transactions: activity over time, who sends and receives, the largest transfers, how long coins sit still
  r.get('/activity', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const secs = RANGES[range];
    const [tip, totals, totals24, series, flows, moves, age, clusters] = await Promise.all([D.tip(), D.activityTotals(secs),
      D.activityTotals(86400), D.activitySeries(range), D.flows(secs), D.bigMoves(secs, 15), D.coinAge(), D.clusterLabels()]);
    // one row per owner: a labelled entity, else an address cluster (common-input ownership), else the address
    const owners = new Map();
    for (const f of flows) {
      const e = entity(f.address);
      const key = e ? 'L:' + e.name : f.cluster != null ? 'C:' + f.cluster : 'A:' + f.address;
      const o = owners.get(key) || { key, name: e ? e.name : (f.cluster != null && clusters.get(f.cluster)) || null,
        color: e ? e.color : null, category: e ? e.category : null, address: f.address, addresses: 0, sent: 0n, recv: 0n, txs: 0, top: 0n };
      o.addresses += 1; o.sent += f.sent; o.recv += f.recv; o.txs += f.txs;
      if (f.sent + f.recv > o.top) { o.top = f.sent + f.recv; o.address = f.address; }
      owners.set(key, o);
    }
    // plain numbers for the template (Pug cannot read BigInt literals)
    const list = [...owners.values()].map(o => ({ ...o, net: Number(o.recv - o.sent) / 10 ** dec }));
    const scale = rows => { const top = rows.length ? Math.abs(rows[0].net) : 1; return rows.map(o => ({ ...o, amount: Math.abs(o.net), pct: top ? 100 * Math.abs(o.net) / top : 0 })); };
    const senders = scale(list.filter(o => o.net < 0).sort((a, b) => a.net - b.net).slice(0, 12));
    const receivers = scale(list.filter(o => o.net > 0).sort((a, b) => b.net - a.net).slice(0, 12));
    const ageTotal = age.reduce((t, a) => t + a.value, 0n);
    const ageBands = age.map(a => ({ value: Number(a.value) / 10 ** dec, count: a.count, pct: ageTotal ? Number(a.value * 10000n / ageTotal) / 100 : 0 }));
    render(res, 'activity', `${coin.name} Activity – transfers, top senders and big moves`, {
      desc: `${coin.name} on-chain activity: transfers and value moved over time, active and new addresses, the largest senders and receivers, the biggest transfers and how long coins sit unspent.`,
      range, tip, totals, totals24, series, senders, receivers, moves, ageBands, ageTotal: Number(ageTotal) / 10 ** dec });
  }));

  // mining calculator: expected coins per card and pool from benchmarks and the network per model (last 24h)
  // the mining picture shared by the calculator and the market page: network per model (last 24h), the miner's
  // reward per block, the pools with a known fee, and every benchmarked card's expected coins per day
  const miningModel = async () => {
    const models = coin.models || [];
    const K = models.length;
    // the network of the last 3 hours (as the headline hashrate elsewhere): the hashrate climbs fast, a day
    // average would overstate what a card finds today; fees per block over a day (they are sparse)
    const WIN = 3 * 3600;
    const [tip, stats, d1, s7] = await Promise.all([D.tip(), D.modelStats(WIN, K), D.issuance(86400), D.modelSeries('7d', K)]);
    const net = CALC.network(models, stats, WIN);
    // growth of each model's hashrate: straight line through the last 24 hours, per day relative to now
    net.forEach((n, k) => {
      const p = FC.project(s7.x, s7.slots[k].hashrate.map(v => v || 0), { windowSecs: 86400 });
      n.growth = p ? p.perDay : 0;
    });
    const reward = Number(rewardAt(tip.height)) / 10 ** dec;
    const project = Math.floor(Number(rewardAt(tip.height)) * 5 / 100) / 10 ** dec;
    const feesPerBlock = d1.blocks ? Number(d1.fees) / 10 ** dec / d1.blocks : 0;
    const minerReward = reward - project + feesPerBlock;
    const seen = new Set();
    const pools = [];
    for (const l of Object.values(coin.labelMap)) {
      if (l.category !== 'pool' || l.fee == null || seen.has(l.name)) continue;
      seen.add(l.name);
      pools.push({ name: l.name, fee: l.fee, minerFee: l.minerFee || 0, verified: !!l.feeSource, url: l.url, color: l.color });
    }
    pools.sort((a, b) => a.fee - b.fee || a.name.localeCompare(b.name));
    pools.push({ name: 'Solo (own node)', fee: 0, minerFee: 0, verified: true, solo: true, color: '#8b93ad' });
    const vk = v => String(v).split('.').map(Number);
    const newer = (a, b) => { const x = vk(a), y = vk(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
    // each card with its miner's own dev fee (the pool's fee is applied per pool on the pages)
    const cards = CALC.loadBenchmarks(coin.id, models.map(m => m.id)).map(b => {
      const bpd = CALC.blocksPerDay(b.rates, net);
      const fee = Number(b.fee) >= 0 ? Number(b.fee) : 0;
      return { gpu: b.gpu, vendor: b.vendor, miner: b.miner, version: b.version, power: b.power_w, rates: b.rates, date: b.date, fee,
        parts: CALC.parts(b.rates, net),
        source: b.source, note: b.note || null, auto: b.auto, upcoming: !!b.upcoming, blocksPerDay: bpd, grossPerDay: bpd * minerReward };
    }).sort((a, b) => b.grossPerDay * (1 - b.fee / 100) - a.grossPerDay * (1 - a.fee / 100));
    // the newest release of every miner the cards were measured with (a build not released yet links to the releases);
    // a card on an older release than its miner's newest is marked
    const releases = new Map();
    for (const c of cards) if (!releases.has(c.miner) || newer(c.version, releases.get(c.miner).version)) releases.set(c.miner, c);
    for (const c of cards) c.older = newer(releases.get(c.miner).version, c.version);
    const minerReleases = [...releases.values()].map(c => ({ miner: c.miner, version: c.version, upcoming: c.upcoming, fee: c.fee,
      url: c.miner === 'suprminer' ? (c.upcoming ? 'https://github.com/ocminer/suprminer/releases' : `https://github.com/ocminer/suprminer/releases/tag/v${c.version}`)
        : (/\/releases\/tag\//.test(c.source || '') ? c.source : null) }))
      .sort((a, b) => (b.miner === 'suprminer') - (a.miner === 'suprminer') || a.miner.localeCompare(b.miner));
    const minerRelease = minerReleases.find(r => r.miner === 'suprminer') || minerReleases[0] || null;
    return { models, K, tip, net, reward, project, feesPerBlock, minerReward, pools, cards, d1, minerRelease, minerReleases, netWindow: WIN };
  };

  // market: price from the exchange (via the price feed), market cap, what mining earns in dollars
  r.get('/market', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const price = res.locals.price;
    const [mm, hist, since, act, g, miners] = await Promise.all([miningModel(), D.priceHistory(range), D.priceSince(),
      D.activity(86400), D.genesis(), D.miners(86400)]);
    const supply = Number(mm.tip.supply) / 10 ** dec;
    const maxSupply = Number(BigInt(coin.maxSupply || 0) * 10n ** BigInt(dec) + g.carryover) / 10 ** dec;
    const earned24 = Number(miners.rows.reduce((t, m) => t + m.earned, 0n)) / 10 ** dec;   // to miners, project share excluded
    const issued24 = Number(mm.d1.issued) / 10 ** dec;
    const usd = price ? price.usd : null;
    const ths = act.hashrate / 1e12;
    const POWER = 0.30;
    const sui = mm.pools.find(p => p.name === 'Suprnova') || mm.pools[0];
    const cards = mm.cards.filter((c, i, a) => a.findIndex(x => CALC.family(x.gpu) === CALC.family(c.gpu)) === i).slice(0, 8).map(c => {
      const coins = c.grossPerDay * (1 - (sui.fee + c.fee) / 100), cost = c.power * 24 / 1000 * POWER;
      return { ...c, coins, revenue: usd != null ? coins * usd : null, cost, profit: usd != null ? coins * usd - cost : null,
        breakEven: coins > 0 ? cost / coins : null };
    });
    render(res, 'market', `${coin.name} Price and Market – ${price ? '$' + F.num(usd, usd < 1 ? 4 : 2) : 'not traded'}`, {
      desc: `${coin.name} (${coin.symbol}) price${price ? ' on ' + price.source + ' ' + price.market : ''}, 24h change and volume, market cap, what miners earn per day in dollars, hashprice and GPU mining profit at the current price.`,
      range, price, hist, since, supply, maxSupply, earned24, issued24, ths, POWER, sui, cards,
      hashprice: usd != null && ths > 0 ? earned24 * usd / ths : null, minerReward: mm.minerReward, minerRelease: mm.minerRelease, minerReleases: mm.minerReleases });
  }));

  r.get('/calculator', cached(), wrap(async (req, res) => {
    if (!(coin.models || []).length) return fail(res, 404, 'Not available', 'This coin has no mining calculator yet.');
    // the network measured over each window the page can switch to (the default is miningModel's 3 hours)
    const WINDOWS = [['1h', 3600], ['3h', 3 * 3600], ['6h', 6 * 3600], ['12h', 12 * 3600], ['24h', 86400]];
    const K = (coin.models || []).length;
    const [mm, mtrend, ...wstats] = await Promise.all([miningModel(), D.modelSeries('7d', K),
      ...WINDOWS.map(([, secs]) => D.modelStats(secs, K))]);
    const { models, tip, net, reward, project, feesPerBlock, minerReward, pools, cards, minerRelease, minerReleases } = mm;
    const windows = WINDOWS.map(([id, secs], wi) => {
      const wn = CALC.network(models, wstats[wi], secs);
      return { id, secs, net: wn.map(n => ({ hashrate: n.hashrate, blocksPerDay: n.blocksPerDay, blockTime: n.blockTime })),
        parts: cards.map(c => CALC.parts(c.rates, wn)) };
    });
    const defWindow = WINDOWS.findIndex(([, secs]) => secs === mm.netWindow);
    const priceRaw = res.locals.price ? JSON.stringify(res.locals.price) : null;
    // yield of the strongest cards over the last 24 hours, the window the trend is fitted on (2-hour windows,
    // each at the network of its window),
    // then today's estimate and the next TREND_DAYS on the network trend (one point every 6 hours)
    const trendCards = cards.filter((c, i, a) => a.findIndex(x => CALC.family(x.gpu) === CALC.family(c.gpu)) === i).slice(0, 4);
    const many = minerReleases.length > 1;
    const nameOf = c => many ? `${c.gpu}, ${c.miner}` : c.gpu;
    const tcolors = ['#38d5c3', '#f2b84b', '#8e7cf8', '#5aa9ff'];
    const TREND_DAYS = 7;
    // full windows of the last 24 hours only (the newest window is still filling)
    const hist = mtrend.x.map((x, i) => i).filter(i => mtrend.x[i] >= tip.time - 86400 && mtrend.x[i] + mtrend.bucket <= tip.time);
    const ahead = [];
    for (let t = 6 * 3600; t <= TREND_DAYS * 86400; t += 6 * 3600) ahead.push(t);
    const at = (c, t) => c.parts.reduce((s, b, k) => s + b / (1 + Math.max(0, net[k].growth) * t / 86400), 0) * minerReward;
    const measured = (c, i) => {
      let sum = 0, ok = false;
      models.forEach((m, k) => {
        const h = mtrend.slots[k].hashrate[i], n = mtrend.slots[k].blocks[i];
        if (h > 0 && n) { sum += (n * 86400 / mtrend.bucket) * c.rates[m.id] / h; ok = true; }
      });
      return ok ? sum * minerReward : null;
    };
    const trend = { x: hist.map(i => mtrend.x[i] + mtrend.bucket / 2).concat([tip.time], ahead.map(t => tip.time + t)), lines: [] };
    trendCards.forEach((c, ci) => {
      trend.lines.push({ label: nameOf(c), color: tcolors[ci], now: c.grossPerDay, end: at(c, TREND_DAYS * 86400),
        y: hist.map(i => measured(c, i)).concat([c.grossPerDay], ahead.map(() => null)) });
    });
    trendCards.forEach((c, ci) => {
      trend.lines.push({ label: nameOf(c) + ', on trend', color: tcolors[ci], dash: [4, 5],
        y: hist.map(() => null).concat([c.grossPerDay], ahead.map(t => at(c, t))) });
    });
    const price = priceRaw ? JSON.parse(priceRaw) : null;
    render(res, 'calculator', `${coin.name} Mining Calculator – coins per GPU, pool fees and power cost`, {
      desc: `${coin.name} mining calculator: expected ${coin.symbol} per day for every benchmarked GPU on each pool, after fees, with power cost and break-even price, from the live network hashrate of each model.`,
      tip, net, cards, pools, minerReward, reward, project, feesPerBlock, trend, price, defaultPower: 0.30, minerRelease, minerReleases, trendDays: TREND_DAYS,
      windows, defWindow, trendIdx: trendCards.map(c => cards.indexOf(c)),
      calcData: { models: models.map(m => ({ id: m.id, name: m.name })), net: net.map(n => ({ id: n.id, hashrate: n.hashrate, blocksPerDay: n.blocksPerDay, growth: n.growth })),
        minerReward, pools: pools.map(p => ({ name: p.name, fee: p.fee })), price: price && price.usd ? price.usd : null,
        cards: cards.map(c => ({ gpu: c.gpu, power: c.power, fee: c.fee, blocksPerDay: c.blocksPerDay, parts: c.parts })),
        windows, defWindow, trendDays: TREND_DAYS,
        chart: { id: 'c-trend', hist: hist.length, ahead, cards: trendCards.map(c => cards.indexOf(c)) } } });
  }));

  r.get('/richlist', cached(), wrap(async (req, res) => {
    const [rl, tip] = await Promise.all([D.richlist(100), D.tip()]);
    render(res, 'richlist', `${coin.name} Rich List – top 100 addresses`, { rl, tip,
      desc: `The 100 largest ${coin.name} balances, known pools and wallets labelled, and how the ${coin.symbol} supply is distributed.` });
  }));

  r.get('/network', (req, res) => res.redirect(301, `${coin.base}/peers`));
  r.get('/peers', cached(30), wrap(async (req, res) => {
    const [peers, tip] = await Promise.all([getPeers(coin), D.tip()]);
    const versions = {};
    for (const p of peers.list) versions[p.agent] = (versions[p.agent] || 0) + 1;
    // nodes that accept connections, one per address (an inbound peer can also be an outbound one)
    const nodes = [...new Set(peers.list.filter(p => p.node).map(p => p.node))];
    render(res, 'network', `${coin.name} Peers – connected nodes, versions and addresses to add`, {
      desc: `Nodes connected to our ${coin.name} full node with their client version, and the addresses of nodes that accept connections, ready to copy into your node.`,
      peers: peers.list, info: peers.info, tip, nodes, p2p: peers.p2p,
      versions: Object.entries(versions).sort((a, b) => b[1] - a[1]) });
  }));

  const search = wrap(async (req, res) => {
    const q = String((req.body && req.body.q) || req.query.q || '').trim().slice(0, 128);
    const hit = q ? await D.search(q) : null;
    if (!hit) return fail(res, 404, 'No match', q
      ? `Nothing matches “${q}”. Search for a block height, block hash, transaction ID, address or pool name.`
      : 'Type a block height, block hash, transaction ID, address or pool name.');
    res.redirect(`${coin.base}/${hit.type}/${hit.id}`);
  });
  r.get('/search', search);
  r.post('/search', search);

  r.get('/sitemap-blocks-:n.xml', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0) return res.status(404).end();
    const rows = await D.q('SELECT height, time FROM blocks WHERE height BETWEEN ? AND ? ORDER BY height', [n * 40000, n * 40000 + 39999]);
    if (!rows.length) return res.status(404).end();
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send('<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + rows.map(b =>
        `<url><loc>${SITE.origin}${coin.base}/block/${b.height}</loc><lastmod>${new Date(Number(b.time) * 1000).toISOString().slice(0, 10)}</lastmod></url>`).join('') +
      '</urlset>');
  }));

  // addresses worth indexing: labelled ones and the 1,000 largest balances
  r.get('/sitemap-addresses.xml', wrap(async (req, res) => {
    const rows = await D.q('SELECT address FROM addresses WHERE balance > 0 ORDER BY balance DESC LIMIT 1000');
    const set = new Set([...Object.keys(coin.labelMap), ...rows.map(x => x.address)]);
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send('<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      [...set].map(a => `<url><loc>${SITE.origin}${coin.base}/address/${encodeURIComponent(a)}</loc><changefreq>daily</changefreq></url>`).join('') +
      '</urlset>');
  }));

  // live tip for the header indicator: read from the indexer's Redis key, no database round trip
  r.get('/_/tip', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const t = JSON.parse(await redis.get(`${coin.prefix}:tip`));
      res.json({ height: t.height, time: t.time, hash: t.hash });
    } catch { res.status(503).json({}); }
  });
  // the current market price as price_watch publishes it; 503 when there is no fresh price
  r.get('/_/price', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    let p = null;
    try { p = JSON.parse(await redis.get(`${coin.prefix}:price`)); } catch {}
    if (!p || !(p.usd > 0)) return res.status(503).json({ coin: coin.symbol, usd: null, error: 'no fresh price' });
    res.json({ coin: coin.symbol, usd: p.usd, btc: p.btc, change24hPct: p.change24h, high24h: p.high24h,
      low24h: p.low24h, volume24hCoin: p.volumeCoin, volume24hUsd: p.volumeUsd, source: p.source,
      market: p.market, url: p.url || null, fetchedAt: p.fetchedAt, checkedAt: p.checked });
  });

  r.get('/qr/:addr.svg', (req, res) => {
    if (!/^[a-zA-Z0-9:]{1,100}$/.test(req.params.addr)) return res.status(400).end();
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400')
      .send(require('qr-image').imageSync(req.params.addr, { type: 'svg', margin: 1, ec_level: 'M' }));
  });

  r.use((req, res) => fail(res, 404, 'Page not found', `There is no ${coin.name} page at this address.`));
  r.use((err, req, res, next) => {
    console.error(`[${coin.id}] ${req.method} ${req.originalUrl}:`, err.stack || err);
    if (!res.headersSent) fail(res, 500, 'This page failed to load',
      'Reload in a moment. If it keeps failing, the node or the index may be catching up.');
  });
  return r;
}

// ------------------------------------------------------------------ app

async function main() {
  const coins = loadCoins(COINS_DIR);
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0' });
  redis.on('error', e => console.error('redis:', e.message));
  await redis.connect();
  const sub = redis.duplicate();
  sub.on('error', e => console.error('redis sub:', e.message));
  await sub.connect();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, 'views'));
  app.set('view cache', process.env.NODE_ENV === 'production');
  Object.assign(app.locals, { F, coins, assetVersion: BUILD_ID, site: SITE });
  app.use(express.urlencoded({ extended: false, limit: '2kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    const ga = SITE.ga4 ? ' https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com' : '';
    res.set('Content-Security-Policy', `default-src 'self'; img-src 'self' data:${ga}; style-src 'self' 'unsafe-inline'; ` +
      `script-src 'self'${ga}; connect-src 'self'${ga}; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    res.locals.canonical = SITE.origin + req.path; // query strings (pages, ranges) are not separate documents
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

  for (const coin of coins) {
    coin.data = new (require(`./adapters/${coin.adapter}`))(coin, process.env);
    coin.prefix = coin.redis_prefix || coin.id;
    coin.gen = '0';
    coin.peers = { at: 0, list: [], info: null };
    coin.labelMap = {};
    await refreshLabels(coin).catch(e => console.error(coin.id, 'labels:', e.message));
    try { coin.gen = (await redis.get(`${coin.prefix}:gen`)) || '0'; } catch {}
    // a new generation (block, reorg or label change) reloads labels before the new cache namespace is used
    const onGen = async () => {
      try {
        const g = await redis.get(`${coin.prefix}:gen`);
        if (g && g !== coin.gen) { await refreshLabels(coin); coin.gen = g; }
      } catch (e) { console.error(coin.id, 'gen update:', e.message); }
    };
    await sub.subscribe(`${coin.prefix}:events`, onGen);
    setInterval(onGen, 3000).unref();
    app.use(coin.base, coinRouter(coin, redis));
  }

  // landing page: every explorer hosted here
  app.get('/', cacheMiddleware(redis, req => `suprplorer:web:${BUILD_ID}:${coins.map(c => c.gen).join('.')}:/`, 60),
    wrap(async (req, res) => {
      const cards = await Promise.all(coins.map(async c => {
        try { const [tip, act, act3h] = await Promise.all([c.data.tip(), c.data.activity(86400), c.data.activity(3 * 3600)]); return { coin: c, tip, act, act3h }; }
        catch { return { coin: c, tip: null, act: null }; }
      }));
      res.render('landing', { cards, coin: null, page: 'landing', title: 'Suprplorer – live block explorers by Suprnova',
        desc: 'Suprplorer runs live block explorers for proof-of-work coins: blocks, transactions, mining pools, hashrate and rich lists, indexed from our own full nodes.' });
    }));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send([
    'User-agent: *', 'Allow: /',
    ...coins.flatMap(c => [`Disallow: ${c.base}/search`, `Disallow: ${c.base}/qr/`, `Disallow: ${c.base}/_/`, `Disallow: ${c.base}/?live=`]),
    '', `Sitemap: ${SITE.origin}/sitemap.xml`, ''].join('\n')));

  // sitemap index: static pages, then per coin the blocks (in files of 40,000) and the notable addresses
  const xml = body => '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
  const loc = (u, lastmod, freq, prio) => `<url><loc>${SITE.origin}${u}</loc>` +
    (lastmod ? `<lastmod>${new Date(lastmod * 1000).toISOString().slice(0, 10)}</lastmod>` : '') +
    (freq ? `<changefreq>${freq}</changefreq>` : '') + (prio ? `<priority>${prio}</priority>` : '') + '</url>';
  app.get('/sitemap.xml', wrap(async (req, res) => {
    const parts = [`${SITE.origin}/sitemap-pages.xml`];
    for (const c of coins) {
      const t = await c.data.tip().catch(() => null);
      const files = t ? Math.ceil((t.height + 1) / 40000) : 0;
      for (let i = 0; i < files; i++) parts.push(`${SITE.origin}${c.base}/sitemap-blocks-${i}.xml`);
      parts.push(`${SITE.origin}${c.base}/sitemap-addresses.xml`);
    }
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      parts.map(p => `<sitemap><loc>${p}</loc></sitemap>`).join('') + '</sitemapindex>'));
  }));
  app.get('/sitemap-pages.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml(
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + loc('/', null, 'daily', '0.8') +
    coins.map(c => loc(c.base + '/', null, 'always', '1.0') + ['blocks', 'activity', 'models', 'mining', 'pools', 'calculator', 'market', 'emission', 'richlist', 'peers']
      .map(p => loc(`${c.base}/${p}`, null, 'hourly', '0.8')).join('')).join('') + '</urlset>')));

  app.get('/_health', async (req, res) => {
    const out = {};
    for (const c of coins) {
      try { const t = await c.data.tip(); out[c.id] = { height: t.height, age: Math.floor(Date.now() / 1000) - t.time }; }
      catch (e) { out[c.id] = { error: e.message }; }
    }
    res.json(out);
  });
  app.use((req, res) => res.status(404).render('error', { coin: null, page: 'error', status: 404,
    title: 'Page not found', message: 'There is no page at this address.' }));

  app.listen(PORT, '127.0.0.1', () => console.log(`suprplorer-web ${process.pid} on 127.0.0.1:${PORT}: ` +
    coins.map(c => c.base).join(' ')));
}

main().catch(e => { console.error(e); process.exit(1); });
