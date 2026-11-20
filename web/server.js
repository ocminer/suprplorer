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
  for (const r of rows) map[r.address] = { name: r.label, category: r.category, url: r.url || null,
    color: r.category === 'burn' ? '#6b7280' : colors[r.label] };
  coin.labelMap = map;
}

// inbound peers are often home connections: show only the network part
function maskIp(ip) {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : ip;
}

async function getPeers(coin) {
  if (Date.now() - coin.peers.at < 15000) return coin.peers;
  try {
    const [raw, info] = await Promise.all([rpc(coin.rpc, 'getpeerinfo'), rpc(coin.rpc, 'getinfo')]);
    coin.peers = { at: Date.now(), info, list: raw.filter(p => p.handshake !== false).map(p => {
      const a = String(p.addr || '');
      const i = a.lastIndexOf(':');
      const ip = i > 0 ? a.slice(0, i).replace(/^\[|\]$/g, '') : a;
      return { masked: maskIp(ip), inbound: !!p.inbound, protocol: p.version,
        agent: String(p.subver || '').replace(/^\/|\/$/g, '') || 'unknown', height: p.height, connected: p.connected };
    }).sort((a, b) => b.connected - a.connected) };
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
    const buckets = new Map();
    for (const r of ms.rows) {
      const e = entity(r.address);
      const k = e && names.includes(e.name) ? e.name : '~other';
      const row = buckets.get(r.t) || {};
      row[k] = (row[k] || 0) + r.n;
      buckets.set(r.t, row);
    }
    if (!buckets.size) return null;
    const ts = [...buckets.keys()].sort((a, b) => a - b);
    const x = [];
    for (let t = ts[0]; t <= ts[ts.length - 1]; t += ms.bucket) x.push(t);
    const colorOf = n => { const e = Object.values(coin.labelMap).find(l => l.name === n); return e ? e.color : F.colorFor(n); };
    const series = names.map(n => ({ label: n, color: colorOf(n), y: x.map(t => (buckets.get(t) || {})[n] || 0) }));
    series.push({ label: 'Other miners', color: '#334061', y: x.map(t => (buckets.get(t) || {})['~other'] || 0) });
    return { x, series, bucket: ms.bucket };
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
    render(res, 'block', `${coin.name} Block #${F.num(b.height)}`, { b, txs: await D.blockTxs(b.height), flagsOf,
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
    const [tip, act, series, miners, blocks] = await Promise.all([D.tip(), D.activity(secs || 1e10), D.series(range),
      D.miners(secs), D.blocks(15)]);
    render(res, 'mining', `${coin.name} Mining – hashrate, difficulty and top miners`, {
      desc: `${coin.name} mining statistics: estimated network hashrate, difficulty, block times, active miners and the miners that found the most blocks.`, range, tip, act, series, miners: minerGroups(miners),
      minersTotal: miners.total, blocks });
  }));

  r.get('/pools', cached(), wrap(async (req, res) => {
    const range = rangeOf(req);
    const secs = RANGES[range];
    const [act, miners] = await Promise.all([D.activity(secs || 1e10), D.miners(secs)]);
    const groups = minerGroups(miners);
    const pools = groups.filter(g => g.category === 'pool');
    const others = groups.filter(g => g.category !== 'pool');
    const other = others.reduce((o, g) => ({ blocks: o.blocks + g.blocks, earned: o.earned + g.earned }), { blocks: 0, earned: 0n });
    render(res, 'pools', `${coin.name} Mining Pools – share of blocks`, {
      desc: `Which ${coin.name} mining pools find the blocks: pool shares, blocks per pool over time, rewards and payout addresses.`, range, act, pools, other, others: others.slice(0, 25),
      donut: donut(groups, 7), stack: await poolStack(range, pools),
      othersCount: others.length, total: miners.total, poolBlocks: pools.reduce((s, p) => s + p.blocks, 0),
      poolEarned: pools.reduce((s, p) => s + p.earned, 0n) });
  }));

  r.get('/richlist', cached(), wrap(async (req, res) => {
    const [rl, tip] = await Promise.all([D.richlist(100), D.tip()]);
    render(res, 'richlist', `${coin.name} Rich List – top 100 addresses`, { rl, tip,
      desc: `The 100 largest ${coin.name} balances, known pools and wallets labelled, and how the ${coin.symbol} supply is distributed.` });
  }));

  r.get('/network', cached(30), wrap(async (req, res) => {
    const [peers, tip] = await Promise.all([getPeers(coin), D.tip()]);
    const versions = {};
    for (const p of peers.list) versions[p.agent] = (versions[p.agent] || 0) + 1;
    render(res, 'network', `${coin.name} Network – peers and node versions`, {
      desc: `Peers connected to our ${coin.name} full node, client versions in use and how many nodes are in sync.`, peers: peers.list, info: peers.info, tip,
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
        try { return { coin: c, tip: await c.data.tip(), act: await c.data.activity(86400) }; }
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
    coins.map(c => loc(c.base + '/', null, 'always', '1.0') + ['blocks', 'mining', 'pools', 'richlist', 'network']
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
