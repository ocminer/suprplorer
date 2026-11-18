#!/usr/bin/env python3
"""NEB -> MySQL indexer.

Follows the best chain of the local neb-node over JSON-RPC and maintains in
MySQL: blocks, transactions, inputs, outputs (the UTXO index), addresses
(balances = richlist), a per-address ledger with running balances, and the
share records. One MySQL transaction per block; reorgs are rolled back block
by block by height. After every commit the tip is published to Redis and the
cache generation is bumped so the web layer can invalidate.

Config comes from the environment:
  MYSQL_HOST MYSQL_USER MYSQL_PASSWORD  NEB_DB (default explorer_neb)
  NEB_RPC (default http://127.0.0.1:8432)  REDIS_URL  REDIS_PREFIX (default neb)
"""
import json
import logging
import os
import signal
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pymysql
import redis

import nebcodec as nc

log = logging.getLogger("neb-indexer")

# forensic flags on txs.flags
FLAG_SELF_CHANGE = 1      # an output pays back to one of the input addresses
FLAG_ROUND_PAYMENT = 2    # exactly one of >=2 outputs is a round amount (change heuristic applies)
FLAG_CONSOLIDATION = 4    # >=3 inputs into 1 output
FLAG_FANOUT = 8           # >=10 outputs (batch payout / pool)
FLAG_MULTISIG_SPEND = 16  # spends a multisig output
FLAG_COINBASE_SPEND = 32  # spends a coinbase output
FLAG_SINGLE_ADDR_IN = 64  # all inputs from one address
FLAG_MULTI_ADDR_IN = 128  # inputs from >=2 addresses (common-input-ownership applies)

ROUND_UNIT = nc.COIN // 100  # 0.01 NEB

GENESIS_ZERO_LABEL = "genesis burn (unspendable)"
PROJECT_LABEL = "project share (1-of-1 multisig)"


class Reorg(Exception):
    pass


class Rpc:
    def __init__(self, url):
        self.url = url

    def call(self, method, *params):
        body = json.dumps({"method": method, "params": list(params)}).encode()
        req = urllib.request.Request(self.url, body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.load(r)
        if res.get("error"):
            raise RuntimeError(f"rpc {method}: {res['error']}")
        return res["result"]


def in_clause(n):
    return ",".join(["%s"] * n)


class Indexer:
    def __init__(self):
        self.rpc = Rpc(os.environ.get("NEB_RPC", "http://127.0.0.1:8432"))
        self.db = pymysql.connect(
            host=os.environ.get("MYSQL_HOST", "127.0.0.1"),
            user=os.environ["MYSQL_USER"],
            password=os.environ["MYSQL_PASSWORD"],
            database=os.environ.get("NEB_DB", "explorer_neb"),
            autocommit=False,
            charset="utf8mb4",
            init_command="SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
        )
        self.redis = redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"))
        self.rp = os.environ.get("REDIS_PREFIX", "neb")
        self.addr_cache = {}
        self.genesis_target = None
        self.project_lock = None
        self.pool = ThreadPoolExecutor(8)
        self.stop = False

    # ------------------------------------------------------------ helpers

    def ensure_schema(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "schema.sql")) as f:
            sql = "\n".join(l.split("--", 1)[0] for l in f.read().splitlines())
        with self.db.cursor() as cur:
            for stmt in [s.strip() for s in sql.split(";")]:
                if stmt:
                    cur.execute(stmt)
            cur.execute("INSERT IGNORE INTO meta VALUES ('schema_version','1')")
        self.db.commit()

    def our_tip(self, cur):
        cur.execute("SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1")
        row = cur.fetchone()
        return (row[0], row[1]) if row else (-1, None)

    def fetch(self, height):
        h = self.rpc.call("getblockhash", height)
        raw = bytes.fromhex(self.rpc.call("getblock", h))
        blk = nc.decode_block(raw)
        if blk.id.hex() != h:
            raise nc.DecodeError(f"block id mismatch at {height}")
        return blk

    def address_id(self, cur, lock_type, lock_data, height, new_ids):
        key = (lock_type, lock_data)
        aid = self.addr_cache.get(key)
        if aid is not None:
            return aid
        cur.execute("SELECT id FROM addresses WHERE lock_type=%s AND lock_data=%s", key)
        row = cur.fetchone()
        if row:
            aid = row[0]
        else:
            label = None
            if lock_type == nc.LOCK_SINGLE and lock_data == b"\x00" * 32:
                label = GENESIS_ZERO_LABEL
            elif lock_type == nc.LOCK_MULTISIG and lock_data == self.project_lock:
                label = PROJECT_LABEL
            cur.execute(
                "INSERT INTO addresses (lock_type, lock_data, address, first_height, last_height, label) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (lock_type, lock_data, nc.lock_display(lock_type, lock_data), height, height, label))
            aid = cur.lastrowid
            new_ids.add(aid)
        if len(self.addr_cache) > 500_000:
            self.addr_cache.clear()
        self.addr_cache[key] = aid
        return aid

    # ------------------------------------------------------------ connect

    def connect(self, cur, blk, height):
        if height == 0:
            prev = None
            self.genesis_target = nc.bits_to_target(blk.bits)
            if len(blk.txs[0].outputs) > 1:
                self.project_lock = blk.txs[0].outputs[1].lock_data
        else:
            cur.execute("SELECT hash, supply, utxo_count, address_count, chainwork FROM blocks WHERE height=%s",
                        (height - 1,))
            prev = cur.fetchone()
            if prev is None or prev[0] != blk.parent:
                raise Reorg(f"parent of {height} is not our block {height - 1}")
        new_ids = set()

        # resolve every spent outpoint in one go (a block cannot spend its own outputs)
        spends = [(ti, ii, inp) for ti, tx in enumerate(blk.txs) if not tx.is_coinbase
                  for ii, inp in enumerate(tx.inputs)]
        prev_txids = list({inp.prev_txid for _, _, inp in spends})
        txid_to_id = {}
        for i in range(0, len(prev_txids), 1000):
            chunk = prev_txids[i:i + 1000]
            cur.execute(f"SELECT txid, id FROM txs WHERE txid IN ({in_clause(len(chunk))})", chunk)
            txid_to_id.update(dict(cur.fetchall()))
        prevouts = {}
        keys = []
        for _, _, inp in spends:
            tid = txid_to_id.get(inp.prev_txid)
            if tid is None:
                raise RuntimeError(f"block {height}: input spends unknown tx {inp.prev_txid.hex()}")
            keys.append((tid, inp.prev_index))
        for i in range(0, len(keys), 500):
            chunk = keys[i:i + 500]
            cur.execute(
                "SELECT tx_id, n, amount, address_id, lock_type, is_coinbase, spent_tx_id FROM outputs "
                f"WHERE (tx_id, n) IN ({','.join(['(%s,%s)'] * len(chunk))})",
                [v for k in chunk for v in k])
            for tid, n, amount, aid, lt, cb, spent in cur.fetchall():
                if spent is not None:
                    raise RuntimeError(f"block {height}: double spend of {tid}:{n}")
                prevouts[(tid, n)] = (amount, aid, lt, cb)

        # transactions
        rows_in, rows_out, rows_spend = [], [], []
        ledger = []          # (tx_id, {aid: [recv, sent, outs, ins]})
        pubkeys, msig = {}, {}
        fees_total = volume = spent_total = created_total = 0
        coinbase_out = 0
        miner_aid = None
        k = 0
        for ti, tx in enumerate(blk.txs):
            per = {}
            in_addrs = set()
            flags = 0
            total_in = 0
            ins_resolved = []
            if not tx.is_coinbase:
                for ii, inp in enumerate(tx.inputs):
                    amount, aid, lt, cb = prevouts[keys[k]]
                    k += 1
                    total_in += amount
                    ins_resolved.append((inp, keys[k - 1], amount, aid))
                    in_addrs.add(aid)
                    e = per.setdefault(aid, [0, 0, 0, 0])
                    e[1] += amount
                    e[3] += 1
                    if lt == nc.LOCK_SINGLE and inp.pubkey():
                        pubkeys.setdefault(aid, inp.pubkey())
                    if lt == nc.LOCK_MULTISIG:
                        flags |= FLAG_MULTISIG_SPEND
                        ms = inp.multisig()
                        if ms:
                            msig.setdefault(aid, ms[:2])
                    if cb:
                        flags |= FLAG_COINBASE_SPEND
            out_aids = []
            total_out = 0
            for o in tx.outputs:
                aid = self.address_id(cur, o.lock_type, o.lock_data, height, new_ids)
                out_aids.append(aid)
                total_out += o.amount
                e = per.setdefault(aid, [0, 0, 0, 0])
                e[0] += o.amount
                e[2] += 1
            if tx.is_coinbase:
                fee = 0
                coinbase_out = total_out
                miner_aid = out_aids[0] if out_aids else None
            else:
                if total_out > total_in:
                    raise RuntimeError(f"block {height}: tx {tx.txid.hex()} creates value")
                fee = total_in - total_out
                fees_total += fee
                volume += total_out
                spent_total += total_in
                if in_addrs & set(out_aids):
                    flags |= FLAG_SELF_CHANGE
                if len(tx.outputs) >= 2 and sum(1 for o in tx.outputs if o.amount % ROUND_UNIT == 0) == 1:
                    flags |= FLAG_ROUND_PAYMENT
                if len(tx.inputs) >= 3 and len(tx.outputs) == 1:
                    flags |= FLAG_CONSOLIDATION
                flags |= FLAG_SINGLE_ADDR_IN if len(in_addrs) == 1 else FLAG_MULTI_ADDR_IN
            if len(tx.outputs) >= 10:
                flags |= FLAG_FANOUT
            created_total += total_out

            cur.execute(
                "INSERT INTO txs (txid, height, idx, time, version, size, is_coinbase, n_in, n_out, "
                "total_in, total_out, fee, flags) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (tx.txid, height, ti, blk.time, tx.version, len(tx.raw), tx.is_coinbase, len(tx.inputs),
                 len(tx.outputs), total_in, total_out, fee, flags))
            tx_id = cur.lastrowid
            if tx.is_coinbase:
                rows_in.append((tx_id, 0, height, None, None, None, 0, tx.inputs[0].witness))
            for ii, (inp, (ptid, pn), amount, aid) in enumerate(ins_resolved):
                rows_in.append((tx_id, ii, height, ptid, pn, aid, amount, inp.witness))
                rows_spend.append((tx_id, ii, height, ptid, pn))
            for n, (o, aid) in enumerate(zip(tx.outputs, out_aids)):
                rows_out.append((tx_id, n, height, o.amount, o.lock_type, aid, tx.is_coinbase))
            ledger.append((tx_id, per))

        if rows_in:
            cur.executemany("INSERT INTO inputs (tx_id, n, height, prev_tx_id, prev_n, address_id, amount, witness) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", rows_in)
        cur.executemany("INSERT INTO outputs (tx_id, n, height, amount, lock_type, address_id, is_coinbase) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s)", rows_out)
        if rows_spend:
            changed = cur.executemany(
                "UPDATE outputs SET spent_tx_id=%s, spent_n=%s, spent_height=%s "
                "WHERE tx_id=%s AND n=%s AND spent_tx_id IS NULL", rows_spend)
            if changed != len(rows_spend):
                raise RuntimeError(f"block {height}: marked {changed} of {len(rows_spend)} outputs spent")

        # ledger with running balances
        touched = sorted({aid for _, per in ledger for aid in per})
        balances = {}
        for i in range(0, len(touched), 1000):
            chunk = touched[i:i + 1000]
            cur.execute(f"SELECT id, balance FROM addresses WHERE id IN ({in_clause(len(chunk))}) FOR UPDATE", chunk)
            balances.update(dict(cur.fetchall()))
        agg = {}
        rows_ledger = []
        for tx_id, per in ledger:
            for aid, (recv, sent, outs, ins) in per.items():
                balances[aid] += recv - sent
                if balances[aid] < 0:
                    raise RuntimeError(f"block {height}: negative balance for address {aid}")
                rows_ledger.append((aid, tx_id, height, recv, sent, outs, ins, balances[aid]))
                a = agg.setdefault(aid, [0, 0, 0, 0])
                a[0] += recv
                a[1] += sent
                a[2] += 1
                a[3] += outs - ins
        cur.executemany("INSERT INTO ledger (address_id, tx_id, height, received, sent, outs, ins, balance_after) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", rows_ledger)
        cur.executemany(
            "UPDATE addresses SET balance=%s, received=received+%s, sent=sent+%s, tx_count=tx_count+%s, "
            "utxo_count=utxo_count+%s, last_height=%s, pubkey=COALESCE(pubkey,%s), "
            "multisig_m=COALESCE(multisig_m,%s), multisig_n=COALESCE(multisig_n,%s) WHERE id=%s",
            [(balances[aid], r, s, c, u, height, pubkeys.get(aid), msig.get(aid, (None, None))[0],
              msig.get(aid, (None, None))[1], aid) for aid, (r, s, c, u) in agg.items()])

        if blk.shares:
            cur.executemany("INSERT INTO shares (height, idx, body_root, time, nonce) VALUES (%s,%s,%s,%s,%s)",
                            [(height, i, br, t, nn) for i, (br, t, nn) in enumerate(blk.shares)])

        # block row and running chain statistics
        if height == 0:
            subsidy, destroyed = coinbase_out, 0
            supply_prev = utxo_prev = addr_prev = 0
            chainwork_prev = 0
        else:
            subsidy = nc.reward(height)
            destroyed = subsidy + fees_total - coinbase_out
            if destroyed < 0:
                raise RuntimeError(f"block {height}: coinbase pays more than reward + fees")
            _, supply_prev, utxo_prev, addr_prev, cw = prev
            chainwork_prev = int(cw)
        supply = supply_prev + created_total - spent_total
        utxo_count = utxo_prev + len(rows_out) - len(rows_spend)
        if self.genesis_target is None:
            cur.execute("SELECT bits FROM blocks WHERE height=0")
            self.genesis_target = nc.bits_to_target(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO blocks (height, hash, parent, version, time, bits, nonce, body_root, size, tx_count, "
            "share_count, difficulty, chainwork, reward, fees, coinbase_out, destroyed, volume, miner_address_id, "
            "coinbase_witness, supply, utxo_count, address_count) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (height, blk.id, blk.parent, blk.version, blk.time, blk.bits, blk.nonce, blk.body_root, len(blk.raw),
             len(blk.txs), len(blk.shares), self.genesis_target / nc.bits_to_target(blk.bits),
             str(chainwork_prev + nc.work_of(blk.bits)), subsidy, fees_total, coinbase_out, destroyed, volume,
             miner_aid, blk.txs[0].inputs[0].witness, supply, utxo_count, addr_prev + len(new_ids)))
        return len(blk.txs)

    # ------------------------------------------------------------ disconnect

    def disconnect(self, cur, height):
        cur.execute("SELECT address_id, SUM(received), SUM(sent), COUNT(*), SUM(outs) - SUM(ins) "
                    "FROM ledger WHERE height=%s GROUP BY address_id", (height,))
        agg = cur.fetchall()
        cur.executemany("UPDATE addresses SET balance=balance-(%s-%s), received=received-%s, sent=sent-%s, "
                        "tx_count=tx_count-%s, utxo_count=utxo_count-%s WHERE id=%s",
                        [(r, s, r, s, c, u, aid) for aid, r, s, c, u in agg])
        cur.execute("UPDATE outputs SET spent_tx_id=NULL, spent_n=NULL, spent_height=NULL WHERE spent_height=%s",
                    (height,))
        for t in ("inputs", "outputs", "ledger", "shares", "txs", "blocks"):
            cur.execute(f"DELETE FROM {t} WHERE height=%s", (height,))
        touched = [a[0] for a in agg]
        for aid in touched:
            cur.execute("SELECT tx_count FROM addresses WHERE id=%s", (aid,))
            if cur.fetchone()[0] == 0:
                cur.execute("DELETE FROM addresses WHERE id=%s", (aid,))
                continue
            cur.execute("UPDATE addresses SET last_height=(SELECT MAX(height) FROM ledger WHERE address_id=%s), "
                        "pubkey=NULL, multisig_m=NULL, multisig_n=NULL WHERE id=%s", (aid, aid))
            cur.execute("SELECT witness FROM inputs WHERE address_id=%s ORDER BY height LIMIT 1", (aid,))
            row = cur.fetchone()
            if row:
                inp = nc.TxIn(b"", 0, row[0])
                ms = inp.multisig()
                cur.execute("UPDATE addresses SET pubkey=%s, multisig_m=%s, multisig_n=%s WHERE id=%s",
                            (inp.pubkey(), ms[0] if ms else None, ms[1] if ms else None, aid))
        self.addr_cache.clear()
        log.warning("disconnected block %d (reorg)", height)

    # ------------------------------------------------------------ loop

    def publish(self, cur, event):
        cur.execute("SELECT height, HEX(hash), time, supply, utxo_count, address_count, difficulty FROM blocks "
                    "ORDER BY height DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            return
        tip = {"height": row[0], "hash": row[1].lower(), "time": row[2], "supply": row[3], "utxo_count": row[4],
               "address_count": row[5], "difficulty": row[6], "event": event}
        try:
            p = self.redis.pipeline()
            p.set(f"{self.rp}:tip", json.dumps(tip))
            p.incr(f"{self.rp}:gen")
            p.publish(f"{self.rp}:events", json.dumps(tip))
            p.execute()
        except redis.RedisError as e:
            log.warning("redis publish failed: %s", e)

    def sync_mempool(self):
        try:
            ids = self.rpc.call("getrawmempool")
            p = self.redis.pipeline()
            p.delete(f"{self.rp}:mempool")
            if ids:
                p.sadd(f"{self.rp}:mempool", *ids)
            p.execute()
        except Exception as e:  # mempool is best effort
            log.debug("mempool sync: %s", e)

    def step(self):
        """Advance as far as possible; return the number of blocks connected."""
        with self.db.cursor() as cur:
            our_h, our_hash = self.our_tip(cur)
        self.db.commit()
        node_h = self.rpc.call("getblockcount")

        # roll back while our tip is not on the node's best chain
        while our_h >= 0:
            node_hash = bytes.fromhex(self.rpc.call("getblockhash", our_h)) if our_h <= node_h else None
            if node_hash == our_hash:
                break
            with self.db.cursor() as cur:
                self.disconnect(cur, our_h)
                self.db.commit()
                our_h, our_hash = self.our_tip(cur)
                self.publish(cur, "disconnect")
            self.db.commit()

        connected = 0
        h = our_h + 1
        while h <= node_h and not self.stop:
            batch = list(range(h, min(node_h, h + 63) + 1))
            blocks = list(self.pool.map(self.fetch, batch)) if len(batch) > 1 else [self.fetch(h)]
            for height, blk in zip(batch, blocks):
                t0 = time.time()
                try:
                    with self.db.cursor() as cur:
                        ntx = self.connect(cur, blk, height)
                    self.db.commit()
                except Reorg as e:
                    self.db.rollback()
                    log.info("%s; rechecking", e)
                    return connected
                except Exception:
                    self.db.rollback()
                    raise
                connected += 1
                if node_h - height < 5 or height % 1000 == 0:
                    log.info("block %d %s txs=%d %.0fms", height, blk.id.hex()[:16], ntx, (time.time() - t0) * 1000)
                if self.stop:
                    break
            h = batch[-1] + 1
            with self.db.cursor() as cur:
                self.publish(cur, "connect")
            self.db.commit()
        return connected

    def run(self):
        self.ensure_schema()
        with self.db.cursor() as cur:
            cur.execute("SELECT bits FROM blocks WHERE height=0")
            row = cur.fetchone()
            if row:
                self.genesis_target = nc.bits_to_target(row[0])
            cur.execute("SELECT lock_data FROM addresses WHERE label=%s", (PROJECT_LABEL,))
            row = cur.fetchone()
            if row:
                self.project_lock = row[0]
        self.db.commit()
        backoff = 1
        while not self.stop:
            try:
                n = self.step()
                self.sync_mempool()
                backoff = 1
                if n == 0:
                    time.sleep(2)
            except (OSError, RuntimeError, pymysql.err.OperationalError) as e:
                log.error("%s; retrying in %ds", e, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                try:
                    self.db.ping(reconnect=True)
                except Exception:
                    pass


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), stream=sys.stdout,
                        format="%(levelname)s %(message)s")
    ix = Indexer()

    def _stop(*_):
        ix.stop = True
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    ix.run()


if __name__ == "__main__":
    main()
