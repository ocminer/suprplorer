#!/usr/bin/env python3
"""Consistency checks of the NEB index.

  verify.py                 invariant checks (exit 1 on failure)
  verify.py --reorg-test N  disconnect the top N blocks, reconnect them from the
                            node, and check that the index is identical afterwards
                            (stop the indexer service first)
"""
import hashlib
import sys

import nebcodec as nc
from indexer import Indexer


def q(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchall()


def invariants(ix):
    ok = True
    with ix.db.cursor() as cur:
        tip = q(cur, "SELECT height, supply, utxo_count, address_count FROM blocks ORDER BY height DESC LIMIT 1")[0]
        h, supply, utxos, naddr = tip
        checks = {
            "blocks are contiguous": q(cur, "SELECT COUNT(*) = MAX(height)+1 FROM blocks")[0][0] == 1,
            "parent links": q(cur, "SELECT COUNT(*) FROM blocks b JOIN blocks p ON p.height+1=b.height "
                                   "WHERE b.parent<>p.hash")[0][0] == 0,
            "supply == sum(unspent outputs)": q(cur, "SELECT COALESCE(SUM(amount),0) FROM outputs "
                                                     "WHERE spent_tx_id IS NULL")[0][0] == supply,
            "supply == sum(address balances)": q(cur, "SELECT SUM(balance) FROM addresses")[0][0] == supply,
            "U + F == C (spec 6.7)": q(cur, "SELECT SUM(coinbase_out) - SUM(fees) FROM blocks")[0][0] == supply,
            "utxo_count == unspent outputs": q(cur, "SELECT COUNT(*) FROM outputs WHERE spent_tx_id IS NULL")[0][0] == utxos,
            "utxo_count == sum(address utxo_count)": q(cur, "SELECT SUM(utxo_count) FROM addresses")[0][0] == utxos,
            "address_count == addresses": q(cur, "SELECT COUNT(*) FROM addresses")[0][0] == naddr,
            "address balance == its unspent outputs": q(cur,
                "SELECT COUNT(*) FROM addresses a LEFT JOIN (SELECT address_id, SUM(amount) s FROM outputs "
                "WHERE spent_tx_id IS NULL GROUP BY address_id) u ON u.address_id=a.id "
                "WHERE a.balance <> COALESCE(u.s,0)")[0][0] == 0,
            "ledger last balance_after == balance": q(cur,
                "SELECT COUNT(*) FROM addresses a JOIN ledger l ON l.address_id=a.id AND l.height=a.last_height "
                "AND l.tx_id=(SELECT MAX(tx_id) FROM ledger WHERE address_id=a.id AND height=a.last_height) "
                "WHERE l.balance_after<>a.balance")[0][0] == 0,
            "every input spends an output marked spent by it": q(cur,
                "SELECT COUNT(*) FROM inputs i LEFT JOIN outputs o ON o.tx_id=i.prev_tx_id AND o.n=i.prev_n "
                "WHERE i.prev_tx_id IS NOT NULL AND (o.spent_tx_id IS NULL OR o.spent_tx_id<>i.tx_id "
                "OR o.spent_n<>i.n OR o.amount<>i.amount)")[0][0] == 0,
            "tx fee == in - out": q(cur, "SELECT COUNT(*) FROM txs WHERE NOT is_coinbase "
                                         "AND fee <> total_in - total_out")[0][0] == 0,
            "subsidy schedule": all(r == nc.reward(hh) for hh, r in q(cur, "SELECT height, reward FROM blocks "
                                                                            "WHERE height>0")),
        }
        # the node's tip must be ours (or ahead by a block or two while following)
        node_h = ix.rpc.call("getblockcount")
        our_hash = q(cur, "SELECT HEX(hash) FROM blocks WHERE height=%s", (min(h, node_h),))[0][0].lower()
        checks["tip hash matches node"] = ix.rpc.call("getblockhash", min(h, node_h)) == our_hash
    ix.db.commit()
    for name, passed in checks.items():
        print(("PASS " if passed else "FAIL ") + name)
        ok &= passed
    print(f"tip {h}  supply {supply / nc.COIN:,.8f} NEB  utxos {utxos}  addresses {naddr}  node {node_h}")
    return ok


def snapshot(ix, upto):
    """Content hash of everything up to a height, independent of auto-increment ids."""
    d = hashlib.sha256()
    with ix.db.cursor() as cur:
        for sql in (
            "SELECT height, HEX(hash), supply, utxo_count, address_count, fees, destroyed, volume, chainwork "
            "FROM blocks WHERE height<=%s ORDER BY height",
            "SELECT HEX(txid), height, idx, total_in, total_out, fee, flags FROM txs WHERE height<=%s ORDER BY txid",
            "SELECT HEX(t.txid), o.n, o.amount, a.address, o.spent_height FROM outputs o JOIN txs t ON t.id=o.tx_id "
            "JOIN addresses a ON a.id=o.address_id WHERE o.height<=%s ORDER BY t.txid, o.n",
            "SELECT address, balance, received, sent, tx_count, utxo_count, first_height, last_height, HEX(pubkey), "
            "label FROM addresses WHERE first_height<=%s ORDER BY address",
            "SELECT a.address, HEX(t.txid), l.received, l.sent, l.balance_after FROM ledger l JOIN addresses a "
            "ON a.id=l.address_id JOIN txs t ON t.id=l.tx_id WHERE l.height<=%s ORDER BY a.address, l.height, t.txid",
        ):
            for row in q(cur, sql, (upto,)):
                d.update(repr(row).encode())
    ix.db.commit()
    return d.hexdigest()


def reorg_test(ix, n):
    with ix.db.cursor() as cur:
        top = ix.our_tip(cur)[0]
    ix.db.commit()
    before = snapshot(ix, top)
    for hh in range(top, top - n, -1):
        with ix.db.cursor() as cur:
            ix.disconnect(cur, hh)
        ix.db.commit()
    mid_ok = invariants(ix)
    while True:
        with ix.db.cursor() as cur:
            cur_h = ix.our_tip(cur)[0]
        ix.db.commit()
        if cur_h >= top:
            break
        ix.step()
    after = snapshot(ix, top)
    same = before == after
    print(("PASS " if same else "FAIL ") + f"state identical after disconnecting and reconnecting {n} blocks")
    return mid_ok and same


if __name__ == "__main__":
    ix = Indexer()
    ix.ensure_schema()
    good = invariants(ix)
    if len(sys.argv) == 3 and sys.argv[1] == "--reorg-test":
        good = reorg_test(ix, int(sys.argv[2])) and invariants(ix) and good
    sys.exit(0 if good else 1)
