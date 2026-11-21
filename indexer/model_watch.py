#!/usr/bin/env python3
"""Model watch: records the neural-network models of the chain and their published accuracy.

1. Every few seconds it asks our own node for the model of every slot at the tip (RPC getmodel) and stores
   one row per slot and block: the weights hash, and the packed weights when they changed. The node only
   reports the tip, so the history starts when this service started.
2. Every 10 minutes it imports the accuracy history the NEB project publishes (model-history.json on the
   official site: accuracy on samples the model never trained on, training steps, neuron and link summary)
   and verifies it: the weights hash the file gives for its tip must equal the hash our node reported for
   that block. The result is published in Redis (<prefix>:models) and shown on the Models page.

Environment: MYSQL_HOST MYSQL_USER MYSQL_PASSWORD NEB_DB NEB_RPC REDIS_URL REDIS_PREFIX
             MODEL_HISTORY_URL (default https://neuralenginebyte.org/model-history.json)
"""
import base64
import json
import os
import time
import urllib.request

import pymysql
import redis
from blake3 import blake3

E = os.environ
RPC = E.get("NEB_RPC", "http://127.0.0.1:8432")
PREFIX = E.get("REDIS_PREFIX", "neb")
HISTORY_URL = E.get("MODEL_HISTORY_URL", "https://neuralenginebyte.org/model-history.json")
POLL, IMPORT_EVERY = 5, 600

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS model_states (
      slot          TINYINT UNSIGNED NOT NULL,
      height        INT UNSIGNED NOT NULL,
      blockhash     BINARY(32) NOT NULL,
      weights_hash  BINARY(32) NOT NULL,
      dataset       VARCHAR(32) NOT NULL,
      weights       MEDIUMBLOB NULL,             -- packed weights, stored when they changed
      PRIMARY KEY (slot, height)
    ) ENGINE=InnoDB""",
    """CREATE TABLE IF NOT EXISTS model_frames (
      slot          TINYINT UNSIGNED NOT NULL,
      height        INT UNSIGNED NOT NULL,
      steps         SMALLINT UNSIGNED NOT NULL,  -- training steps (shares) applied at this block
      accuracy      DECIMAL(5,1) NOT NULL,       -- percent, on samples the model never trained on
      neurons       BINARY(32) NOT NULL,         -- hidden neuron summary (0-255)
      links         VARBINARY(64) NOT NULL,      -- hidden -> output link weights, offset by 16
      PRIMARY KEY (slot, height)
    ) ENGINE=InnoDB""",
]


def rpc(method, *params):
    req = urllib.request.Request(RPC, json.dumps({"method": method, "params": list(params)}).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.load(r)
    if res.get("error"):
        raise RuntimeError(res["error"])
    return res["result"]


def record(cur, slots, last):
    """Store the tip models when the tip changed; returns the new tip hash."""
    models = [rpc("getmodel", s) for s in range(slots)]
    tip = models[0]["blockhash"]
    if tip == last or any(m["blockhash"] != tip for m in models):
        return last  # unchanged, or the tip moved between the calls: try again next round
    for m in models:
        cur.execute("SELECT weights_hash FROM model_states WHERE slot=%s AND height<%s ORDER BY height DESC LIMIT 1",
                    (m["slot"], m["height"]))
        prev = cur.fetchone()
        wh = bytes.fromhex(m["weightshash"])
        weights = None if prev and prev[0] == wh else bytes.fromhex(m["weights"])
        cur.execute("REPLACE INTO model_states (slot, height, blockhash, weights_hash, dataset, weights) "
                    "VALUES (%s,%s,%s,%s,%s,%s)", (m["slot"], m["height"], bytes.fromhex(tip), wh, m["dataset"], weights))
    return tip


def import_history(cur, r):
    req = urllib.request.Request(HISTORY_URL, headers={"User-Agent": "suprplorer-explorer"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        doc = json.loads(resp.read(20_000_000))
    n = 0
    for slot, s in enumerate(doc.get("slots", [])):
        for f in s.get("frames", []):
            neurons, links = base64.b64decode(f["n"]), base64.b64decode(f["w"])
            if len(neurons) != 32 or len(links) > 64:
                continue
            cur.execute("REPLACE INTO model_frames (slot, height, steps, accuracy, neurons, links) VALUES (%s,%s,%s,%s,%s,%s)",
                        (slot, int(f["h"]), int(f["s"]), int(f["a"]) / 10, neurons, links))
            n += 1
    # verification: the file gives the hash of all models at its tip (spec: BLAKE3("neb-models" || the weights
    # hash of every slot in order)); it must equal the hash of the models our node reported for that block
    tip, wh, bh = int(doc.get("tip", -1)), doc.get("weightshash", ""), doc.get("blockhash", "")
    cur.execute("SELECT slot, weights_hash FROM model_states WHERE height=%s AND blockhash=%s ORDER BY slot",
                (tip, bytes.fromhex(bh) if len(bh) == 64 else b""))
    rows = cur.fetchall()
    ours = blake3(b"neb-models" + b"".join(r[1] for r in rows)).hexdigest() if len(rows) > 1 else (rows[0][1].hex() if rows else None)
    status = "unchecked" if ours is None else ("verified" if ours == wh.lower() else "mismatch")
    match = (0,) if status == "verified" else None
    meta = {s.get("name"): s.get("labels") for s in doc.get("slots", [])}
    r.set(f"{PREFIX}:models", json.dumps({"source": HISTORY_URL, "fetched": int(time.time()), "tip": tip,
                                          "status": status, "slot": match[0] if match else None, "frames": n,
                                          "labels": meta}))
    print(f"imported {n} frames, tip {tip}: {status}", flush=True)


def main():
    db = pymysql.connect(host=E.get("MYSQL_HOST", "127.0.0.1"), user=E["MYSQL_USER"], password=E["MYSQL_PASSWORD"],
                         database=E.get("NEB_DB", "explorer_neb"), autocommit=True)
    r = redis.Redis.from_url(E.get("REDIS_URL", "redis://127.0.0.1:6379/0"))
    with db.cursor() as cur:
        for stmt in SCHEMA:
            cur.execute(stmt)
    slots = int(rpc("getmodel", 0)["slots"])
    last, next_import = None, 0
    while True:
        try:
            db.ping()
            with db.cursor() as cur:
                last = record(cur, slots, last)
                if time.time() >= next_import:
                    next_import = time.time() + IMPORT_EVERY
                    try:
                        import_history(cur, r)
                    except (OSError, ValueError, KeyError) as e:
                        print(f"history import failed: {e}", flush=True)
        except (OSError, RuntimeError, pymysql.MySQLError) as e:
            print(f"model watch: {e}", flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
