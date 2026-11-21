#!/usr/bin/env python3
"""Price watch: reads the coin's market price from a JSON endpoint, keeps the history in MySQL and
publishes the current price in Redis (<prefix>:price) for the web app. Run every 2 minutes (timer).

The endpoint (PRICE_URL) returns {"usd", "btc", "change24hPct", "high24h", "low24h", "volume24hNeb",
"volume24hUsdt", "source", "market", "url", "fetchedAt", "ageSeconds", "stale"}; it gives no price when
its reading is too old. A reading is stored once (by its fetchedAt). Without a valid, fresh price the
Redis key is removed, so the site shows no price rather than an old one.

Environment: MYSQL_* NEB_DB REDIS_URL REDIS_PREFIX PRICE_URL NTFY_URL (optional, alerts when the feed
stops or resumes) COIN_NAME
"""
import json
import math
import os
import time
import urllib.request
from datetime import datetime

import pymysql
import redis

E = os.environ
PREFIX = E.get("REDIS_PREFIX", "neb")
URL = E.get("PRICE_URL", "https://neb.suprnova.cc/api/pools/neb/price")
COIN = E.get("COIN_NAME", "NEB")
MAX_AGE = 6 * 3600

SCHEMA = """CREATE TABLE IF NOT EXISTS prices (
  fetched_at    INT UNSIGNED NOT NULL PRIMARY KEY,  -- when the source read the market (unix)
  usd           DOUBLE NOT NULL,
  btc           DOUBLE NULL,
  change24h     DOUBLE NULL,                        -- percent
  high24h       DOUBLE NULL,
  low24h        DOUBLE NULL,
  volume_coin   DOUBLE NULL,                        -- 24h volume in coins
  volume_usd    DOUBLE NULL,                        -- 24h volume in USD(T)
  source        VARCHAR(64) NOT NULL,
  market        VARCHAR(32) NOT NULL
) ENGINE=InnoDB"""


def num(v, lo=0.0, hi=1e12, allow_none=True):
    if v is None and allow_none:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"out of range: {v!r}")
    return float(v)


def notify(title, body, tags):
    url = E.get("NTFY_URL")
    if not url:
        return
    try:
        urllib.request.urlopen(urllib.request.Request(url, body.encode(), {"Title": title, "Tags": tags}), timeout=15).read()
    except OSError:
        pass


def read():
    req = urllib.request.Request(URL, headers={"User-Agent": "suprplorer-explorer", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.loads(r.read(100_000))
    if d.get("usd") is None or d.get("stale"):
        return None, d
    fetched = int(datetime.fromisoformat(str(d["fetchedAt"]).replace("Z", "+00:00")).timestamp())
    if time.time() - fetched > MAX_AGE:
        return None, d
    text = lambda k, n: str(d.get(k) or "")[:n]
    p = {"usd": num(d["usd"], 1e-12, 1e9, False), "btc": num(d.get("btc"), 0, 1e6),
         "change24h": num(d.get("change24hPct"), -100, 1e6), "high24h": num(d.get("high24h"), 0, 1e9),
         "low24h": num(d.get("low24h"), 0, 1e9), "volume_coin": num(d.get("volume24hNeb")),
         "volume_usd": num(d.get("volume24hUsdt")), "source": text("source", 64) or "unknown",
         "market": text("market", 32), "url": text("url", 255), "fetched_at": fetched}
    if p["url"] and not p["url"].startswith("https://"):
        p["url"] = ""
    return p, d


def main():
    r = redis.Redis.from_url(E.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True)
    was_ok = r.get(f"{PREFIX}:price:ok") != "0"
    try:
        p, raw = read()
    except (OSError, ValueError, KeyError) as e:
        p, raw = None, {"error": str(e)[:200]}
    if not p:
        r.delete(f"{PREFIX}:price")
        r.set(f"{PREFIX}:price:ok", "0")
        if was_ok:
            notify(f"{COIN} price feed: no price", f"No fresh price from {URL}: {json.dumps(raw)[:300]}", "warning")
        print(f"no price: {json.dumps(raw)[:300]}", flush=True)
        return
    db = pymysql.connect(host=E.get("MYSQL_HOST", "127.0.0.1"), user=E["MYSQL_USER"], password=E["MYSQL_PASSWORD"],
                         database=E.get("NEB_DB", "explorer_neb"), autocommit=True)
    with db.cursor() as cur:
        cur.execute(SCHEMA)
        cur.execute("INSERT IGNORE INTO prices (fetched_at, usd, btc, change24h, high24h, low24h, volume_coin, volume_usd, "
                    "source, market) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (p["fetched_at"], p["usd"], p["btc"], p["change24h"], p["high24h"], p["low24h"], p["volume_coin"],
                     p["volume_usd"], p["source"], p["market"]))
        new = cur.rowcount
    pub = {"usd": p["usd"], "btc": p["btc"], "change24h": p["change24h"], "high24h": p["high24h"], "low24h": p["low24h"],
           "volumeCoin": p["volume_coin"], "volumeUsd": p["volume_usd"], "source": p["source"], "market": p["market"],
           "url": p["url"], "fetchedAt": p["fetched_at"], "sources": [p["source"] + (" " + p["market"] if p["market"] else "")],
           "via": URL.split("/")[2], "checked": int(time.time())}
    r.set(f"{PREFIX}:price", json.dumps(pub))
    r.set(f"{PREFIX}:price:ok", "1")
    if not was_ok:
        notify(f"{COIN} price feed back", f"{p['source']} {p['market']}: ${p['usd']}", "white_check_mark")
    print(f"{p['source']} {p['market']} ${p['usd']} ({'new' if new else 'unchanged'} reading)", flush=True)


if __name__ == "__main__":
    main()
