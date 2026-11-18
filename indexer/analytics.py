#!/usr/bin/env python3
"""Periodic analytics over the NEB index (run by a systemd timer).

1. Forensics: common-input-ownership clustering. Addresses spent together as
   inputs of one transaction are assumed to share an owner; the union-find
   result is written to addresses.cluster_id and the clusters table (clusters
   of two or more addresses; a NULL cluster_id is a singleton). Full rebuild:
   cheap at the current chain size, make it incremental when it is not.
2. Ledger calculations: daily_stats per UTC day, recomputed for the last two
   days (all days when the table is empty).
"""
import logging
import os
import sys
import time

import pymysql
import pymysql.cursors

log = logging.getLogger("neb-analytics")


def connect():
    return pymysql.connect(host=os.environ.get("MYSQL_HOST", "127.0.0.1"), user=os.environ["MYSQL_USER"],
                           password=os.environ["MYSQL_PASSWORD"], database=os.environ.get("NEB_DB", "explorer_neb"),
                           autocommit=False, init_command="SET time_zone='+00:00'")


def find(parent, x):
    while parent.get(x, x) != x:
        parent[x] = parent.get(parent[x], parent[x])
        x = parent[x]
    return x


def clusters(db):
    t0 = time.time()
    parent = {}
    with db.cursor(pymysql.cursors.SSCursor) as cur:
        cur.execute("SELECT tx_id, address_id FROM inputs WHERE address_id IS NOT NULL ORDER BY tx_id")
        last_tx = first = None
        for tx_id, aid in cur:
            if tx_id != last_tx:
                last_tx, first = tx_id, aid
                continue
            a, b = find(parent, first), find(parent, aid)
            if a != b:
                parent[max(a, b)] = min(a, b)
    members = {}
    for x in list(parent):
        members.setdefault(find(parent, x), []).append(x)
    for root, m in members.items():
        if root not in m:
            m.append(root)
    rows = [(aid, root) for root, m in members.items() for aid in m]
    with db.cursor() as cur:
        cur.execute("CREATE TEMPORARY TABLE IF NOT EXISTS tmp_cluster (id BIGINT UNSIGNED PRIMARY KEY, "
                    "cluster_id BIGINT UNSIGNED NOT NULL)")
        cur.execute("TRUNCATE tmp_cluster")
        for i in range(0, len(rows), 5000):
            cur.executemany("INSERT INTO tmp_cluster VALUES (%s,%s)", rows[i:i + 5000])
        cur.execute("UPDATE addresses a LEFT JOIN tmp_cluster t ON t.id=a.id SET a.cluster_id=t.cluster_id "
                    "WHERE NOT (a.cluster_id <=> t.cluster_id)")
        cur.execute("DELETE FROM clusters")
        # a cluster takes the manual label of any member (labels table), else an automatic one
        cur.execute("INSERT INTO clusters (id, size, balance, received, tx_count, first_height, last_height, label) "
                    "SELECT a.cluster_id, COUNT(*), SUM(a.balance), SUM(a.received), 0, MIN(a.first_height), "
                    "MAX(a.last_height), COALESCE(MAX(l.label), MAX(a.label)) FROM addresses a "
                    "LEFT JOIN labels l ON l.address=a.address WHERE a.cluster_id IS NOT NULL GROUP BY a.cluster_id")
        cur.execute("UPDATE clusters c JOIN (SELECT a.cluster_id, COUNT(DISTINCT l.tx_id) n FROM ledger l "
                    "JOIN addresses a ON a.id=l.address_id WHERE a.cluster_id IS NOT NULL GROUP BY a.cluster_id) x "
                    "ON x.cluster_id=c.id SET c.tx_count=x.n")
    db.commit()
    log.info("clusters: %d clusters over %d addresses in %.1fs", len(members), len(rows), time.time() - t0)


def daily(db):
    with db.cursor() as cur:
        cur.execute("SELECT MAX(day) FROM daily_stats")
        last = cur.fetchone()[0]
        where = "WHERE time >= UNIX_TIMESTAMP(%s - INTERVAL 1 DAY)" if last else ""
        cur.execute(f"SELECT DISTINCT DATE(FROM_UNIXTIME(time)) FROM blocks {where}", (last,) if last else ())
        days = [r[0] for r in cur.fetchall()]
        for day in days:
            rng = ("UNIX_TIMESTAMP(%s)", "UNIX_TIMESTAMP(%s + INTERVAL 1 DAY)")
            cur.execute(f"SELECT COUNT(*), SUM(tx_count), SUM(volume), SUM(fees), SUM(coinbase_out), SUM(destroyed), "
                        f"MIN(height), MAX(height), AVG(difficulty), MIN(time), MAX(time) FROM blocks "
                        f"WHERE time >= {rng[0]} AND time < {rng[1]}", (day, day))
            nb, ntx, vol, fees, minted, destroyed, hmin, hmax, diff, tmin, tmax = cur.fetchone()
            cur.execute("SELECT supply FROM blocks WHERE height=%s", (hmax,))
            supply = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM addresses WHERE first_height BETWEEN %s AND %s", (hmin, hmax))
            new = cur.fetchone()[0]
            cur.execute("SELECT COUNT(DISTINCT address_id) FROM ledger WHERE height BETWEEN %s AND %s", (hmin, hmax))
            active = cur.fetchone()[0]
            cur.execute("REPLACE INTO daily_stats VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (day, nb, ntx, vol, fees, minted, destroyed, new, active, supply, diff,
                         (tmax - tmin) / (nb - 1) if nb > 1 else None))
    db.commit()
    log.info("daily_stats: %d day(s) updated", len(days))


def main():
    logging.basicConfig(level="INFO", stream=sys.stdout, format="%(levelname)s %(message)s")
    db = connect()
    clusters(db)
    daily(db)


if __name__ == "__main__":
    main()
