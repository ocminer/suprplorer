'use strict';
// Data adapter for coins indexed with the suprplorer UTXO schema (indexer/schema.sql).
// Coins with another data model (DAG, account based) get their own adapter with the
// same method names. Amounts leave this module as BigInt base units.
const mysql = require('mysql2/promise');

const hex = b => (b == null ? null : Buffer.from(b).toString('hex'));
const unhex = s => Buffer.from(s, 'hex');
const isHex64 = s => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);

// chart ranges: seconds covered and bucket size
const RANGES = {
  '24h': { span: 86400, bucket: 900 },
  '7d': { span: 7 * 86400, bucket: 7200 },
  '30d': { span: 30 * 86400, bucket: 6 * 3600 },
  all: { span: null, bucket: null },
};

class UtxoMysqlAdapter {
  constructor(coin, env) {
    this.coin = coin;
    this.db = mysql.createPool({
      host: env.MYSQL_HOST || '127.0.0.1', user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: coin.db,
      connectionLimit: 20, supportBigNumbers: true, bigNumberStrings: true,
      typeCast: (field, next) => {
        if (field.type === 'LONGLONG' || field.type === 'NEWDECIMAL') {
          const v = field.string();
          if (v == null) return null;
          return v.includes('.') ? Number(v) : BigInt(v);
        }
        return next();
      },
    });
    this.w0 = null; // expected work of a block at difficulty 1 (the genesis target)
  }

  async q(sql, args) {
    const [rows] = await this.db.query(sql, args);
    return rows;
  }

  async genesis() {
    if (this.g) return this.g;
    const [b] = await this.q('SELECT bits, reward, coinbase_out, time FROM blocks WHERE height=0');
    if (!b) return null;
    const bits = Number(b.bits);
    const target = BigInt(bits & 0xffffff) << BigInt(bits >>> 24);
    this.w0 = Number((1n << 256n) / (target + 1n));
    // the genesis row stores the whole genesis coinbase as its reward; the carry-over is that less the
    // scheduled reward of height 0 (coin.genesisReward, base units)
    this.g = { time: Number(b.time), carryover: BigInt(b.coinbase_out) - BigInt(this.coin.genesisReward || 0) };
    return this.g;
  }

  // ---------------------------------------------------------------- chain state

  async tip() {
    const [r] = await this.q('SELECT height, hash, time, supply, utxo_count, address_count, difficulty FROM blocks ' +
      'ORDER BY height DESC LIMIT 1');
    if (!r) return null;
    return { height: Number(r.height), hash: hex(r.hash), time: Number(r.time), supply: r.supply,
      utxo_count: Number(r.utxo_count), address_count: Number(r.address_count), difficulty: Number(r.difficulty) };
  }

  // activity over the last `seconds` before the tip
  async activity(seconds = 86400) {
    await this.genesis();
    const t = await this.tip();
    const since = t.time - seconds;
    const [r] = await this.q('SELECT COUNT(*) blocks, SUM(difficulty) sd, AVG(difficulty) ad, MIN(time) t0, ' +
      'COUNT(DISTINCT miner_address_id) miners, SUM(tx_count) - COUNT(*) txs, SUM(volume) volume, SUM(fees) fees ' +
      'FROM blocks WHERE time > ? AND height > 0', [since]);
    const blocks = Number(r.blocks);
    const span = Math.max(1, Math.min(seconds, t.time - Number(r.t0 || t.time)));
    return { blocks, miners: Number(r.miners), txs: Number(r.txs || 0n), volume: r.volume || 0n, fees: r.fees || 0n,
      difficulty: Number(r.ad || 0), hashrate: blocks ? (Number(r.sd) * this.w0) / span : 0,
      blockTime: blocks > 1 ? span / blocks : null };
  }

  // time series for the charts: per bucket blocks, mean difficulty, hashrate, active miners, transfers
  async series(range = '24h') {
    await this.genesis();
    const t = await this.tip();
    let { span, bucket } = RANGES[range] || RANGES['24h'];
    if (!span) {
      span = Math.max(3600, t.time - this.g.time);
      bucket = Math.max(900, Math.ceil(span / 150 / 900) * 900);
    }
    const since = t.time - span;
    const rows = await this.q('SELECT FLOOR(time / ?) * ? AS b, COUNT(*) n, AVG(difficulty) ad, SUM(difficulty) sd, ' +
      'COUNT(DISTINCT miner_address_id) miners, SUM(tx_count) - COUNT(*) txs FROM blocks ' +
      'WHERE time > ? AND height > 0 GROUP BY b ORDER BY b', [bucket, bucket, since]);
    return { range, bucket, points: rows.map(r => {
      const start = Number(r.b);
      const width = Math.max(60, Math.min(bucket, t.time - start)); // the last bucket is still filling
      return { t: start, blocks: Number(r.n), difficulty: Number(r.ad), miners: Number(r.miners), txs: Number(r.txs),
        hashrate: (Number(r.sd) * this.w0) / width, blockTime: Number(r.n) ? width / Number(r.n) : null };
    }) };
  }

  // coins issued per bucket (coinbase less fees, project share included) and the supply at the end of each bucket
  async emissionSeries(range = '24h') {
    await this.genesis();
    const t = await this.tip();
    let { span, bucket } = RANGES[range] || RANGES['24h'];
    if (!span) {
      span = Math.max(3600, t.time - this.g.time);
      bucket = Math.max(3600, Math.ceil(span / 120 / 3600) * 3600);
    } else {
      bucket = Math.max(bucket, 3600); // hourly at least: issuance per hour is the unit people compare
    }
    const rows = await this.q('SELECT FLOOR(time / ?) * ? AS bk, COUNT(*) n, SUM(coinbase_out - fees) issued, MAX(supply) supply, ' +
      'MAX(height) h FROM blocks WHERE time > ? AND height > 0 GROUP BY bk ORDER BY bk', [bucket, bucket, t.time - span]);
    return { bucket, points: rows.map(r => {
      const start = Number(r.bk);
      const width = Math.max(60, Math.min(bucket, t.time - start + 60));
      return { t: start, blocks: Number(r.n), issued: BigInt(r.issued), perHour: Number(BigInt(r.issued)) / width * 3600,
        supply: BigInt(r.supply), height: Number(r.h) };
    }) };
  }

  // issuance over the last `seconds`
  async issuance(seconds) {
    const t = await this.tip();
    const [r] = await this.q('SELECT COUNT(*) n, COALESCE(SUM(coinbase_out - fees), 0) issued, COALESCE(SUM(fees), 0) fees ' +
      'FROM blocks WHERE time > ? AND height > 0', [t.time - seconds]);
    return { blocks: Number(r.n), issued: BigInt(r.issued), fees: BigInt(r.fees) };
  }

  // Per model (slot = height mod K): blocks, the time spent on them and the attempts they took.
  // The interval of a block is its time minus its parent's, so it counts the time spent on that block's model.
  async modelStats(seconds = 86400, k = 2) {
    await this.genesis();
    const t = await this.tip();
    const rows = await this.q('SELECT x.height % ? slot, COUNT(*) n, SUM(x.dt) st, SUM(x.difficulty) sd, AVG(x.difficulty) ad, ' +
      'MIN(x.dt) mindt, MAX(x.dt) maxdt FROM (SELECT b.height, b.difficulty, CAST(b.time AS SIGNED) - CAST(p.time AS SIGNED) dt ' +
      'FROM blocks b JOIN blocks p ON p.height = b.height - 1 WHERE b.time > ? AND b.height > 0) x GROUP BY slot ORDER BY slot',
      [k, t.time - seconds]);
    const total = rows.reduce((s, r) => s + Math.max(0, Number(r.st)), 0) || 1;
    return Array.from({ length: k }, (_, i) => {
      const r = rows.find(x => Number(x.slot) === i);
      if (!r) return { slot: i, blocks: 0, seconds: 0, timeShare: 0, blockTime: null, hashrate: 0, difficulty: 0 };
      const st = Math.max(1, Number(r.st));
      return { slot: i, blocks: Number(r.n), seconds: st, timeShare: st / total, blockTime: st / Number(r.n),
        hashrate: (Number(r.sd) * this.w0) / st, difficulty: Number(r.ad) };
    });
  }

  // per-model hashrate and block time per bucket (same buckets as series())
  async modelSeries(range = '24h', k = 2) {
    await this.genesis();
    const t = await this.tip();
    let { span, bucket } = RANGES[range] || RANGES['24h'];
    if (!span) {
      span = Math.max(3600, t.time - this.g.time);
      bucket = Math.max(900, Math.ceil(span / 150 / 900) * 900);
    }
    const rows = await this.q('SELECT FLOOR(x.time / ?) * ? AS bk, x.height % ? slot, COUNT(*) n, SUM(x.dt) st, SUM(x.difficulty) sd ' +
      'FROM (SELECT b.height, b.time, b.difficulty, CAST(b.time AS SIGNED) - CAST(p.time AS SIGNED) dt FROM blocks b ' +
      'JOIN blocks p ON p.height = b.height - 1 WHERE b.time > ? AND b.height > 0) x GROUP BY bk, slot ORDER BY bk',
      [bucket, bucket, k, t.time - span]);
    const by = new Map();
    for (const r of rows) {
      const b = Number(r.bk);
      if (!by.has(b)) by.set(b, Array.from({ length: k }, () => ({ hashrate: null, blockTime: null, blocks: 0 })));
      const st = Number(r.st);
      if (st > 0) by.get(b)[Number(r.slot)] = { hashrate: (Number(r.sd) * this.w0) / st, blockTime: st / Number(r.n), blocks: Number(r.n) };
    }
    const x = [...by.keys()].sort((a, b) => a - b);
    return { bucket, x, slots: Array.from({ length: k }, (_, i) => ({
      hashrate: x.map(b => by.get(b)[i].hashrate), blockTime: x.map(b => by.get(b)[i].blockTime),
      blocks: x.map(b => by.get(b)[i].blocks) })) };
  }

  // ---------------------------------------------------------------- lists

  async blocks(limit = 20, offset = 0) {
    const rows = await this.q('SELECT b.height, b.hash, b.time, b.tx_count, b.size, b.reward, b.fees, b.difficulty, ' +
      'b.share_count, a.address miner FROM blocks b LEFT JOIN addresses a ON a.id=b.miner_address_id ' +
      'ORDER BY b.height DESC LIMIT ? OFFSET ?', [limit, offset]);
    return rows.map(r => ({ height: Number(r.height), hash: hex(r.hash), time: Number(r.time), txs: Number(r.tx_count),
      size: Number(r.size), reward: BigInt(r.reward) + BigInt(r.fees), difficulty: Number(r.difficulty),
      shares: Number(r.share_count), miner: r.miner }));
  }

  // blocks found by one payout address
  async blocksByMiner(addr, limit = 50, offset = 0) {
    const [a] = await this.q('SELECT id FROM addresses WHERE address=?', [addr]);
    if (!a) return { total: 0, rows: [] };
    const [c] = await this.q('SELECT COUNT(*) n FROM blocks WHERE miner_address_id=? AND height > 0', [a.id]);
    const rows = await this.q('SELECT height, hash, time, tx_count, size, reward, fees, difficulty, share_count FROM blocks ' +
      'WHERE miner_address_id=? AND height > 0 ORDER BY height DESC LIMIT ? OFFSET ?', [a.id, limit, offset]);
    return { total: Number(c.n), rows: rows.map(r => ({ height: Number(r.height), hash: hex(r.hash), time: Number(r.time),
      txs: Number(r.tx_count), size: Number(r.size), reward: BigInt(r.reward) + BigInt(r.fees), difficulty: Number(r.difficulty),
      shares: Number(r.share_count), miner: addr })) };
  }

  // blocks per bucket per miner address (for the pool share chart)
  async minerSeries(range = '24h') {
    await this.genesis();
    const t = await this.tip();
    let { span, bucket } = RANGES[range] || RANGES['24h'];
    if (!span) {
      span = Math.max(3600, t.time - this.g.time);
      bucket = Math.max(900, Math.ceil(span / 60 / 900) * 900);
    } else {
      bucket = Math.max(bucket, Math.ceil(span / 60 / 900) * 900); // at most ~60 bars
    }
    const rows = await this.q('SELECT FLOOR(b.time / ?) * ? AS bk, a.address, COUNT(*) n, ' +
      'SUM(CAST(b.coinbase_out AS SIGNED) - FLOOR(b.reward * 5 / 100)) earned FROM blocks b ' +
      'JOIN addresses a ON a.id=b.miner_address_id WHERE b.time > ? AND b.height > 0 GROUP BY bk, a.address ORDER BY bk',
      [bucket, bucket, t.time - span]);
    return { bucket, rows: rows.map(r => ({ t: Number(r.bk), address: r.address, n: Number(r.n), earned: Number(r.earned) })) };
  }

  // latest transfers (coinbase transactions excluded)
  async transfers(limit = 10) {
    const rows = await this.q('SELECT t.txid, t.height, t.time, t.n_in, t.n_out, t.total_out, t.fee, ' +
      '(SELECT a.address FROM inputs i JOIN addresses a ON a.id=i.address_id WHERE i.tx_id=t.id ORDER BY i.n LIMIT 1) sender ' +
      'FROM txs t WHERE NOT t.is_coinbase ORDER BY t.id DESC LIMIT ?', [limit]);
    return rows.map(r => ({ txid: hex(r.txid), height: Number(r.height), time: Number(r.time), ins: Number(r.n_in),
      outs: Number(r.n_out), amount: r.total_out, fee: r.fee, from: r.sender }));
  }

  // per miner address over the last `seconds` (or all time)
  async miners(seconds) {
    const t = await this.tip();
    const since = seconds ? t.time - seconds : 0;
    const rows = await this.q('SELECT a.address, COUNT(*) n, SUM(CAST(b.coinbase_out AS SIGNED) - FLOOR(b.reward * 5 / 100)) earned, ' +
      'MAX(b.height) last, MAX(b.time) last_time, MIN(b.height) first FROM blocks b JOIN addresses a ON a.id=b.miner_address_id ' +
      'WHERE b.time > ? AND b.height > 0 GROUP BY a.address ORDER BY n DESC, last DESC', [since]);
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    return { total, rows: rows.map(r => ({ address: r.address, blocks: Number(r.n), earned: BigInt(r.earned),
      last: Number(r.last), lastTime: Number(r.last_time), first: Number(r.first) })) };
  }

  // blocks per payout address and model (slot = height mod K) over the last `seconds`
  async minersByModel(seconds, k = 2) {
    const t = await this.tip();
    const rows = await this.q('SELECT a.address, b.height % ? slot, COUNT(*) n FROM blocks b JOIN addresses a ' +
      'ON a.id=b.miner_address_id WHERE b.time > ? AND b.height > 0 GROUP BY a.address, slot', [k, seconds ? t.time - seconds : 0]);
    return rows.map(r => ({ address: r.address, slot: Number(r.slot), n: Number(r.n) }));
  }

  // ---------------------------------------------------------------- objects

  async block(id) {
    let rows;
    if (isHex64(id)) rows = await this.q('SELECT * FROM blocks WHERE hash=?', [unhex(id)]);
    else if (/^\d{1,10}$/.test(String(id))) rows = await this.q('SELECT * FROM blocks WHERE height=?', [Number(id)]);
    else return null;
    if (!rows.length) return null;
    const b = rows[0];
    const h = Number(b.height);
    const [nxt] = await this.q('SELECT hash FROM blocks WHERE height=?', [h + 1]);
    const t = await this.tip();
    const [miner] = b.miner_address_id ? await this.q('SELECT address FROM addresses WHERE id=?', [b.miner_address_id]) : [];
    return {
      height: h, hash: hex(b.hash), parent: h > 0 ? hex(b.parent) : null, next: nxt ? hex(nxt.hash) : null,
      time: Number(b.time), confirmations: t.height - h + 1, size: Number(b.size), txs: Number(b.tx_count),
      shares: Number(b.share_count), difficulty: Number(b.difficulty), bits: Number(b.bits).toString(16).padStart(8, '0'),
      nonce: Number(b.nonce), bodyRoot: hex(b.body_root), chainwork: String(b.chainwork), reward: b.reward, fees: b.fees,
      coinbaseOut: b.coinbase_out, destroyed: b.destroyed, volume: b.volume, supply: b.supply, miner: miner ? miner.address : null,
      coinbaseWitness: hex(b.coinbase_witness), version: Number(b.version),
    };
  }

  // transactions of a block with resolved inputs/outputs (capped for very large blocks)
  async blockTxs(height, limit = 500) {
    const txs = await this.q('SELECT id, txid, idx, is_coinbase, total_in, total_out, fee, n_in, n_out, flags FROM txs ' +
      'WHERE height=? ORDER BY idx LIMIT ?', [height, limit]);
    if (!txs.length) return [];
    const ids = txs.map(t => t.id);
    const outs = await this.q('SELECT o.tx_id, o.n, o.amount, a.address FROM outputs o JOIN addresses a ON a.id=o.address_id ' +
      'WHERE o.tx_id IN (?) ORDER BY o.tx_id, o.n', [ids]);
    const ins = await this.q('SELECT i.tx_id, i.amount, a.address FROM inputs i JOIN addresses a ON a.id=i.address_id ' +
      'WHERE i.tx_id IN (?) ORDER BY i.tx_id, i.n', [ids]);
    const group = rows => rows.reduce((m, r) => {
      const k = String(r.tx_id);
      (m[k] = m[k] || []).push({ address: r.address, amount: r.amount });
      return m;
    }, {});
    const o = group(outs), i = group(ins);
    return txs.map(t => ({ txid: hex(t.txid), coinbase: !!t.is_coinbase, totalIn: t.total_in, totalOut: t.total_out,
      fee: t.fee, flags: Number(t.flags), outputs: o[String(t.id)] || [], inputs: i[String(t.id)] || [] }));
  }

  async tx(txid) {
    if (!isHex64(txid)) return null;
    const rows = await this.q('SELECT t.*, b.hash FROM txs t JOIN blocks b ON b.height=t.height WHERE t.txid=?', [unhex(txid)]);
    if (!rows.length) return null;
    const t = rows[0];
    const inputs = t.is_coinbase ? [] : (await this.q('SELECT i.n, i.amount, a.address, pt.txid prev_txid, i.prev_n FROM inputs i ' +
      'JOIN addresses a ON a.id=i.address_id JOIN txs pt ON pt.id=i.prev_tx_id WHERE i.tx_id=? ORDER BY i.n', [t.id]))
      .map(r => ({ address: r.address, amount: r.amount, prevTxid: hex(r.prev_txid), prevN: Number(r.prev_n) }));
    const outputs = (await this.q('SELECT o.n, o.amount, a.address, o.spent_height, st.txid spent_txid FROM outputs o ' +
      'JOIN addresses a ON a.id=o.address_id LEFT JOIN txs st ON st.id=o.spent_tx_id WHERE o.tx_id=? ORDER BY o.n', [t.id]))
      .map(r => ({ address: r.address, amount: r.amount, spentHeight: r.spent_height == null ? null : Number(r.spent_height),
        spentTxid: hex(r.spent_txid) }));
    const tip = await this.tip();
    return { txid: txid.toLowerCase(), height: Number(t.height), blockHash: hex(t.hash), time: Number(t.time),
      confirmations: tip.height - Number(t.height) + 1, coinbase: !!t.is_coinbase, size: Number(t.size),
      totalIn: t.total_in, totalOut: t.total_out, fee: t.fee, flags: Number(t.flags), inputs, outputs };
  }

  async address(addr) {
    if (typeof addr !== 'string' || addr.length > 100) return null;
    const rows = await this.q('SELECT * FROM addresses WHERE address=?', [addr]);
    if (!rows.length) return null;
    const a = rows[0];
    let cluster = null;
    if (a.cluster_id != null) {
      const [c] = await this.q('SELECT * FROM clusters WHERE id=?', [a.cluster_id]);
      if (c) cluster = { size: Number(c.size), balance: c.balance, txs: Number(c.tx_count), label: c.label };
    }
    const [mined] = await this.q('SELECT COUNT(*) n, MAX(height) last FROM blocks WHERE miner_address_id=? AND height > 0', [a.id]);
    const [rank] = await this.q('SELECT COUNT(*) + 1 r FROM addresses WHERE balance > ?', [a.balance]);
    return { address: a.address, lockType: Number(a.lock_type), balance: a.balance, received: a.received, sent: a.sent,
      txs: Number(a.tx_count), utxos: Number(a.utxo_count), firstHeight: Number(a.first_height), lastHeight: Number(a.last_height),
      pubkey: hex(a.pubkey), autoLabel: a.label, cluster, blocksMined: Number(mined.n), lastMined: mined.last == null ? null : Number(mined.last),
      rank: BigInt(a.balance) > 0n ? Number(rank.r) : null };
  }

  async addressTxs(addr, limit = 25, offset = 0) {
    const [a] = await this.q('SELECT id, tx_count FROM addresses WHERE address=?', [addr]);
    if (!a) return { total: 0, rows: [] };
    const rows = await this.q('SELECT l.received, l.sent, l.balance_after, l.height, t.txid, t.time, t.is_coinbase FROM ledger l ' +
      'JOIN txs t ON t.id=l.tx_id WHERE l.address_id=? ORDER BY l.height DESC, l.tx_id DESC LIMIT ? OFFSET ?', [a.id, limit, offset]);
    return { total: Number(a.tx_count), rows: rows.map(r => ({ txid: hex(r.txid), time: Number(r.time), height: Number(r.height),
      coinbase: !!r.is_coinbase, received: r.received, sent: r.sent, balance: r.balance_after })) };
  }

  // balance over time from the ledger, thinned to at most ~400 points
  async balanceHistory(addr) {
    const [a] = await this.q('SELECT id, tx_count FROM addresses WHERE address=?', [addr]);
    if (!a) return [];
    const step = Math.max(1, Math.ceil(Number(a.tx_count) / 400));
    const rows = await this.q('SELECT time, bal FROM (SELECT t.time, l.balance_after bal, ' +
      'ROW_NUMBER() OVER (ORDER BY l.height, l.tx_id) rn, COUNT(*) OVER () cnt FROM ledger l JOIN txs t ON t.id=l.tx_id ' +
      'WHERE l.address_id=?) x WHERE MOD(rn - 1, ?) = 0 OR rn = cnt ORDER BY rn', [a.id, step]);
    return rows.map(r => ({ t: Number(r.time), balance: r.bal }));
  }

  async utxos(addr, limit = 100) {
    const rows = await this.q('SELECT t.txid, o.n, o.amount, o.height, o.is_coinbase FROM outputs o ' +
      'JOIN addresses a ON a.id=o.address_id JOIN txs t ON t.id=o.tx_id WHERE a.address=? AND o.spent_height IS NULL ' +
      'ORDER BY o.amount DESC LIMIT ?', [addr, limit]);
    return rows.map(r => ({ txid: hex(r.txid), n: Number(r.n), amount: r.amount, height: Number(r.height), coinbase: !!r.is_coinbase }));
  }

  // ---------------------------------------------------------------- rich list

  async richlist(limit = 100) {
    const rows = await this.q('SELECT address, balance, received, tx_count, last_height FROM addresses WHERE balance > 0 ' +
      'ORDER BY balance DESC LIMIT ?', [limit]);
    const [h] = await this.q('SELECT COUNT(*) n FROM addresses WHERE balance > 0');
    const tops = await this.q('SELECT ' +
      '(SELECT COALESCE(SUM(balance),0) FROM (SELECT balance FROM addresses ORDER BY balance DESC LIMIT 10) x) t10, ' +
      '(SELECT COALESCE(SUM(balance),0) FROM (SELECT balance FROM addresses ORDER BY balance DESC LIMIT 100) y) t100, ' +
      '(SELECT COALESCE(SUM(balance),0) FROM (SELECT balance FROM addresses ORDER BY balance DESC LIMIT 1000) z) t1000');
    return { holders: Number(h.n), rows: rows.map(r => ({ address: r.address, balance: r.balance, received: r.received,
      txs: Number(r.tx_count), lastHeight: Number(r.last_height) })), top10: tops[0].t10, top100: tops[0].t100, top1000: tops[0].t1000 };
  }

  // ---------------------------------------------------------------- misc

  async labels() {
    const auto = await this.q('SELECT address, label, NULL category, NULL url, NULL fee, NULL miner_fee, NULL fee_source ' +
      'FROM addresses WHERE label IS NOT NULL');
    let manual;
    try {
      manual = await this.q('SELECT address, label, category, url, fee, miner_fee, fee_source FROM labels');
    } catch (e) { // before the first labels sync added the fee columns
      manual = await this.q('SELECT address, label, category, url, NULL fee, NULL miner_fee, NULL fee_source FROM labels');
    }
    return [...auto, ...manual];
  }

  async search(q) {
    q = q.trim();
    if (isHex64(q)) {
      const h = q.toLowerCase();
      if ((await this.q('SELECT 1 FROM txs WHERE txid=?', [unhex(h)])).length) return { type: 'tx', id: h };
      if ((await this.q('SELECT 1 FROM blocks WHERE hash=?', [unhex(h)])).length) return { type: 'block', id: h };
      const [a] = await this.q('SELECT address FROM addresses WHERE lock_data=?', [unhex(h)]);
      return a ? { type: 'address', id: a.address } : null;
    }
    if (/^\d{1,10}$/.test(q)) {
      const [b] = await this.q('SELECT height FROM blocks WHERE height=?', [Number(q)]);
      return b ? { type: 'block', id: String(b.height) } : null;
    }
    const [a] = await this.q('SELECT address FROM addresses WHERE address=? OR address=?', [q, q.toLowerCase()]);
    if (a) return { type: 'address', id: a.address };
    // a label (pool, exchange) by name
    const [l] = await this.q('SELECT address FROM labels WHERE label=? LIMIT 1', [q]);
    return l ? { type: 'address', id: l.address } : null;
  }
}

module.exports = UtxoMysqlAdapter;
