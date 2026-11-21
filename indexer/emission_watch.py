#!/usr/bin/env python3
"""Emission watch: checks every new block and the recent issuance against the reward schedule and
alerts at once (ntfy) when something is off. Run every minute (systemd timer).

Checks
  overpay      a coinbase pays more than reward + fees (impossible under the consensus rules)
  supply       the supply is above what the schedule allows at the tip (carry-over included)
  rate_1h      coins issued in the last hour vs the schedule (60 s blocks)      > EMISSION_1H_MAX
  rate_6h      coins issued in the last 6 hours vs the schedule                  > EMISSION_6H_MAX
  dominance    one miner (pool) found more than POOL_MAX_SHARE of the last POOL_WINDOW blocks
  fingerprint  a pool's recent blocks do not look like its own: at least FINGERPRINT_MIN blocks of the last
               POOL_WINDOW blocks of one labelled pool (or a miner with many blocks) break its fingerprint

Alerts go out when a check turns bad and when it recovers; a critical check that stays bad repeats
every 30 minutes. The status of every check is published in Redis (<prefix>:watch) for the web page.

Environment: MYSQL_HOST MYSQL_USER MYSQL_PASSWORD NEB_DB REDIS_URL REDIS_PREFIX NTFY_URL (optional)
             EMISSION_1H_MAX (1.5) EMISSION_6H_MAX (1.25) POOL_MAX_SHARE (0.51) POOL_WINDOW (360) COIN_NAME
             FINGERPRINT_MIN (2)

Pool fingerprints: the coinbase witness holds the height (4 bytes) and an extranonce that every pool's
software fills in its own way (some always start with the same byte, some use only the first few bytes).
For each block the fingerprint is learned from that miner's previous FP_TRAIN blocks: the longest
extranonce seen and, when at most two first-byte values cover 99% of them, those values. A block that
is longer, has another witness size or starts differently breaks it. One stray block happens when a pool
changes software, so the alert needs FINGERPRINT_MIN of them; it can mean the pool changed its setup or
that somebody else mines to its payout address.
"""
import collections
import json
import os
import time
import urllib.request

import pymysql
import redis

import nebcodec as nc

E = os.environ
PREFIX = E.get("REDIS_PREFIX", "neb")
COIN_NAME = E.get("COIN_NAME", "NEB")
TARGET = int(E.get("BLOCK_TIME", "60"))
LIMITS = {"rate_1h": float(E.get("EMISSION_1H_MAX", "1.5")), "rate_6h": float(E.get("EMISSION_6H_MAX", "1.25")),
          "dominance": float(E.get("POOL_MAX_SHARE", "0.51"))}
POOL_WINDOW = int(E.get("POOL_WINDOW", "360"))
FP_MIN = int(E.get("FINGERPRINT_MIN", "2"))
FP_TRAIN, FP_LEARN = 300, 50       # blocks a fingerprint is learned from, and the least it needs
FP_UNLABELLED = 100                # unlabelled miners get one from this many blocks on
REPEAT = 1800
CRITICAL = {"overpay", "supply"}


def coins(units):
    return f"{units / nc.COIN:,.2f}"


def notify(title, body, priority, tags):
    url = E.get("NTFY_URL")
    print(f"ALERT {title}: {body}", flush=True)
    if not url:
        return
    req = urllib.request.Request(url, body.encode(), {"Title": title, "Priority": priority, "Tags": tags})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except OSError as e:
        print(f"ntfy failed: {e}", flush=True)


def short(who):
    return who if len(who) < 30 else who[:12] + "…" + who[-6:]


def fingerprint(train):
    """(witness size, longest extranonce, allowed first bytes or None) from a miner's earlier witnesses."""
    sizes = collections.Counter(len(w) for w in train)
    size = sizes.most_common(1)[0][0]
    tails = [w[4:] for w in train if len(w) == size]
    first = collections.Counter(t[:1] for t in tails)
    top = [b for b, _ in first.most_common(2)]
    lead = set(top) if sum(first[b] for b in top) >= 0.99 * len(tails) else None
    return size, max(len(t.rstrip(b"\0")) for t in tails), lead


def breaks(fp, w):
    size, longest, lead = fp
    if len(w) != size:
        return f"witness of {len(w)} bytes, usually {size}"
    t = w[4:]
    if len(t.rstrip(b"\0")) > longest:
        return f"extranonce uses {len(t.rstrip(b"\0"))} bytes, at most {longest} before"
    if lead and t[:1] not in lead:
        return f"extranonce starts {t[:1].hex()}, usually {'/'.join(sorted(b.hex() for b in lead))}"
    return None


def fingerprints(cur):
    """Blocks of the last POOL_WINDOW that break their miner's fingerprint, per miner."""
    cur.execute("SELECT b.height, COALESCE(l.label, a.address), l.label IS NOT NULL, b.coinbase_witness FROM blocks b "
                "JOIN addresses a ON a.id = b.miner_address_id LEFT JOIN labels l ON l.address = a.address "
                "WHERE b.height > 0 ORDER BY b.height DESC LIMIT %s", (POOL_WINDOW + 20000,))
    rows = cur.fetchall()[::-1]
    start = rows[-POOL_WINDOW][0] if len(rows) >= POOL_WINDOW else rows[0][0] if rows else 0
    hist, bad, watched = collections.defaultdict(list), collections.defaultdict(list), set()
    for h, who, labelled, w in rows:
        w = bytes(w)
        train = hist[who][-FP_TRAIN:]
        if h >= start and len(train) >= (FP_LEARN if labelled else FP_UNLABELLED):
            watched.add(who)
            why = breaks(fingerprint(train), w)
            if why:
                bad[who].append((h, why))
        hist[who].append(w)
    return bad, watched


def run(cur):
    cur.execute("SELECT height, time, supply FROM blocks ORDER BY height DESC LIMIT 1")
    tip_h, tip_t, supply = cur.fetchone()
    # the genesis row stores the whole genesis coinbase as its reward: the carry-over of the test networks
    # is that coinbase less the scheduled reward of height 0
    cur.execute("SELECT coinbase_out FROM blocks WHERE height = 0")
    carry = int(cur.fetchone()[0]) - nc.reward(0)
    out = {}

    # every block's coinbase against reward + fees (fees can be 0, so this catches any overpay)
    cur.execute("SELECT height, coinbase_out, reward, fees FROM blocks WHERE height > 0 AND coinbase_out > reward + fees "
                "ORDER BY height DESC LIMIT 5")
    bad = cur.fetchall()
    out["overpay"] = {"ok": not bad, "value": len(bad),
                      "text": "No coinbase pays more than reward plus fees." if not bad else
                      "Coinbase above reward + fees at " + ", ".join(
                          f"#{h} ({coins(o)} > {coins(r + f)})" for h, o, r, f in bad)}

    allowed = carry + nc.cumulative_reward(tip_h)
    out["supply"] = {"ok": supply <= allowed, "value": supply, "limit": allowed,
                     "text": f"Supply {coins(supply)} {COIN_NAME}, schedule allows {coins(allowed)} at #{tip_h}."}

    for key, secs in (("rate_1h", 3600), ("rate_6h", 6 * 3600)):
        cur.execute("SELECT COUNT(*), COALESCE(SUM(coinbase_out - fees), 0) FROM blocks WHERE height > 0 AND time > %s",
                    (tip_t - secs,))
        n, issued = cur.fetchone()
        expected = secs / TARGET * nc.reward(tip_h)
        ratio = float(issued) / expected if expected else 0.0
        out[key] = {"ok": ratio <= LIMITS[key], "value": round(ratio, 4), "limit": LIMITS[key], "blocks": int(n),
                    "text": f"{coins(int(issued))} {COIN_NAME} in {int(n)} blocks, {ratio * 100:.0f}% of the schedule "
                            f"(alert above {LIMITS[key] * 100:.0f}%)."}

    # the same label counts as one miner (a pool with several payout addresses)
    cur.execute("SELECT COALESCE(l.label, a.address) who, COUNT(*) n FROM (SELECT miner_address_id FROM blocks "
                "WHERE height > 0 ORDER BY height DESC LIMIT %s) b LEFT JOIN addresses a ON a.id = b.miner_address_id "
                "LEFT JOIN labels l ON l.address = a.address GROUP BY who ORDER BY n DESC LIMIT 1", (POOL_WINDOW,))
    row = cur.fetchone()
    cur.execute("SELECT LEAST(COUNT(*), %s) FROM blocks WHERE height > 0", (POOL_WINDOW,))
    window = cur.fetchone()[0] or 1
    share = row[1] / window if row else 0.0
    who = row[0] if row else "-"
    who_short = short(who)
    out["dominance"] = {"ok": share <= LIMITS["dominance"], "value": round(share, 4), "limit": LIMITS["dominance"],
                        "who": who, "text": f"Largest miner {who_short}: {share * 100:.1f}% of the last {window} blocks "
                                            f"(alert above {LIMITS['dominance'] * 100:.0f}%)."}

    bad, watched = fingerprints(cur)
    hits = {who: v for who, v in bad.items() if len(v) >= FP_MIN}
    if hits:
        text = "; ".join(f"{short(who)}: {len(v)} of its last blocks differ (#{v[-1][0]}: {v[-1][1]})"
                         for who, v in sorted(hits.items(), key=lambda kv: -len(kv[1]))) + \
               ". The pool changed its setup, or somebody else mines to its payout address."
    else:
        single = sum(len(v) for v in bad.values())
        text = (f"{len(watched)} pools and large miners checked over the last {POOL_WINDOW} blocks: all match their "
                f"fingerprint" + (f" ({single} single stray block)." if single == 1 else
                                  f" ({single} single stray blocks)." if single else "."))
    out["fingerprint"] = {"ok": not hits, "value": sum(len(v) for v in hits.values()), "limit": FP_MIN,
                          "who": sorted(hits), "text": text}
    return tip_h, out


def main():
    db = pymysql.connect(host=E.get("MYSQL_HOST", "127.0.0.1"), user=E["MYSQL_USER"], password=E["MYSQL_PASSWORD"],
                         database=E.get("NEB_DB", "explorer_neb"), autocommit=True)
    r = redis.Redis.from_url(E.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True)
    with db.cursor() as cur:
        tip_h, checks = run(cur)
    now = int(time.time())
    prev = json.loads(r.get(f"{PREFIX}:watch") or "{}").get("checks", {})
    for key, c in checks.items():
        p = prev.get(key, {})
        c["since"] = p.get("since", now) if p.get("ok", True) == c["ok"] else now
        c["alerted"] = p.get("alerted", 0)
        critical = key in CRITICAL
        if not c["ok"] and (p.get("ok", True) or (critical and now - c["alerted"] >= REPEAT)):
            notify(f"{COIN_NAME} emission watch: {key.replace('_', ' ')} {'CRITICAL' if critical else 'alert'}",
                   c["text"] + f" Tip #{tip_h}.", "urgent" if critical else "high",
                   "rotating_light" if critical else "warning")
            c["alerted"] = now
        elif c["ok"] and not p.get("ok", True):
            notify(f"{COIN_NAME} emission watch: {key.replace('_', ' ')} back to normal", c["text"] + f" Tip #{tip_h}.",
                   "default", "white_check_mark")
    r.set(f"{PREFIX}:watch", json.dumps({"tip": tip_h, "checked": now, "checks": checks}))
    bad = [k for k, c in checks.items() if not c["ok"]]
    print(f"tip {tip_h}: " + ("all checks ok" if not bad else "ALERT " + ", ".join(bad)), flush=True)


if __name__ == "__main__":
    main()
