#!/usr/bin/env python3
"""Manage address labels shown in the explorer (richlist, blocks, front page).

  suprplorer-label <coin> list
  suprplorer-label <coin> add <address> <label> [category] [url]
  suprplorer-label <coin> rm <address>
  suprplorer-label <coin> check <labels.json>   validate a labels file (no database needed)
  suprplorer-label <coin> sync <labels.json>    make the database match the labels file

category: pool, exchange, project, holder, burn, other (default other).
Labels from the public labels file (labels/<coin>.json in the repository) are stored with
source 'repo'; `sync` adds, updates and removes those. Labels added with `add` are local
(source 'local') and only `rm` removes them.
Changes are visible on the site at once (the coin's cache generation is bumped).
"""
import json
import os
import re
import sys
import unicodedata

import nebcodec as nc

CATEGORIES = ("pool", "exchange", "project", "holder", "burn", "other")
FILE_CATEGORIES = ("pool", "exchange", "project", "holder", "other")
ENTRY_KEYS = {"address", "name", "category", "url"}
NAME_RE = re.compile(r"^[\w][\w .,&+'()/:-]*$")
URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d{1,5})?(?:/[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]*)?$")


def usage():
    print(__doc__.strip())
    sys.exit(2)


def valid_neb_address(addr):
    if addr.startswith("multisig:"):
        h = addr[len("multisig:"):]
        return len(h) == 64 and all(c in "0123456789abcdef" for c in h)
    return addr == addr.strip().lower() and nc.decode_address(addr) is not None


ADDRESS_CHECKS = {"neb": valid_neb_address}


def valid_address(coin, addr):
    check = ADDRESS_CHECKS.get(coin)
    if check is None:
        sys.exit(f"no address check for coin '{coin}' yet (add one to ADDRESS_CHECKS in label.py)")
    return check(addr)


# ------------------------------------------------------------------ labels file
def _no_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    dup = {k for k in keys if keys.count(k) > 1}
    if dup:
        raise ValueError(f"duplicate key(s) {', '.join(sorted(dup))}")
    return dict(pairs)


def load_file(coin, path):
    """Parse and validate a labels file. Returns (entries, errors)."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f, object_pairs_hook=_no_duplicate_keys)
    except (OSError, ValueError) as e:
        return [], [f"{path}: {e}"]
    errors = []
    if not isinstance(doc, dict) or set(doc) - {"$comment", "coin", "labels"}:
        return [], [f"{path}: top level must be an object with 'coin' and 'labels'"]
    if doc.get("coin") != coin:
        errors.append(f"{path}: 'coin' is {doc.get('coin')!r}, expected {coin!r}")
    labels = doc.get("labels")
    if not isinstance(labels, list):
        return [], errors + [f"{path}: 'labels' must be a list"]
    seen, entries = {}, []
    for i, e in enumerate(labels):
        where = f"{path}: labels[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{where}: must be an object")
            continue
        where += f" ({e.get('name', '?')})"
        extra = set(e) - ENTRY_KEYS
        missing = {"address", "name", "category"} - set(e)
        if extra:
            errors.append(f"{where}: unknown field(s) {', '.join(sorted(extra))}")
        if missing:
            errors.append(f"{where}: missing field(s) {', '.join(sorted(missing))}")
            continue
        addr, name, cat, url = e["address"], e["name"], e["category"], e.get("url")
        if not all(isinstance(v, str) for v in (addr, name, cat)) or (url is not None and not isinstance(url, str)):
            errors.append(f"{where}: all fields must be strings")
            continue
        if not valid_address(coin, addr):
            errors.append(f"{where}: not a valid lowercase {coin} address: {addr}")
        if addr in seen:
            errors.append(f"{where}: address already labelled as '{seen[addr]}'")
        seen[addr] = name
        if (name != name.strip() or not 1 <= len(name) <= 48 or not NAME_RE.match(name)
                or any(unicodedata.category(c) in ("Cc", "Cf") for c in name)):
            errors.append(f"{where}: name must be 1-48 characters of letters, digits, spaces and . , & + ' ( ) / : - _")
        if cat not in FILE_CATEGORIES:
            errors.append(f"{where}: category must be one of {', '.join(FILE_CATEGORIES)}")
        if url is not None and (len(url) > 255 or not URL_RE.match(url)):
            errors.append(f"{where}: url must be a plain https:// address (max 255 characters)")
        entries.append({"address": addr, "name": name, "category": cat, "url": url})
    return entries, errors


# ------------------------------------------------------------------ database
def connect(coin):
    import pymysql
    return pymysql.connect(host=os.environ.get("MYSQL_HOST", "127.0.0.1"), user=os.environ["MYSQL_USER"],
                           password=os.environ["MYSQL_PASSWORD"], database=f"explorer_{coin}", autocommit=True)


def ensure_source_column(cur):
    cur.execute("SHOW COLUMNS FROM labels LIKE 'source'")
    if not cur.fetchone():
        cur.execute("ALTER TABLE labels ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'local' AFTER note")


def bump_generation(coin):
    import redis
    try:
        redis.Redis.from_url(os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")).incr(f"{coin}:gen")
    except redis.RedisError as e:
        print(f"warning: cache not invalidated ({e}); the change shows within 5 minutes")


def sync(coin, cur, entries):
    """Upsert every file entry as source 'repo' and drop repo labels no longer in the file."""
    cur.execute("SELECT address, label, category, url, source FROM labels")
    have = {r[0]: r[1:] for r in cur.fetchall()}
    changes = 0
    for e in entries:
        if have.get(e["address"]) == (e["name"], e["category"], e["url"], "repo"):
            continue
        cur.execute("INSERT INTO labels (address, label, category, url, source) VALUES (%s,%s,%s,%s,'repo') "
                    "ON DUPLICATE KEY UPDATE label=VALUES(label), category=VALUES(category), url=VALUES(url), "
                    "source='repo'", (e["address"], e["name"], e["category"], e["url"]))
        print(f"{'updated' if e['address'] in have else 'added'}  {e['name']} ({e['category']}) {e['address']}")
        changes += 1
    keep = {e["address"] for e in entries}
    for addr, (label, _cat, _url, source) in have.items():
        if source == "repo" and addr not in keep:
            cur.execute("DELETE FROM labels WHERE address=%s AND source='repo'", (addr,))
            print(f"removed  {label} {addr}")
            changes += 1
    return changes


def main():
    if len(sys.argv) < 3 or not sys.argv[1].replace("-", "").isalnum():
        usage()
    coin, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]

    if cmd in ("check", "sync") and len(args) == 1:
        entries, errors = load_file(coin, args[0])
        if errors:
            print("\n".join(errors), file=sys.stderr)
            sys.exit(1)
        if cmd == "check":
            print(f"{args[0]}: {len(entries)} labels OK")
            return
        db = connect(coin)
        cur = db.cursor()
        ensure_source_column(cur)
        n = sync(coin, cur, entries)
        print(f"{coin}: {len(entries)} labels in file, {n} change(s)")
        if n:
            bump_generation(coin)
        return

    db = connect(coin)
    cur = db.cursor()
    ensure_source_column(cur)
    if cmd == "list":
        cur.execute("SELECT l.address, l.label, l.category, COALESCE(l.url,''), COALESCE(a.balance,0)/1e8, "
                    "(SELECT COUNT(*) FROM blocks b WHERE b.miner_address_id=a.id), l.source FROM labels l "
                    "LEFT JOIN addresses a ON a.address=l.address ORDER BY l.category, l.label")
        rows = cur.fetchall()
        for r in rows:
            print(f"{r[2]:<9} {r[1]:<24} {r[6]:<5} {r[0]}  balance {r[4]:,.8f}  blocks {r[5]}  {r[3]}")
        if not rows:
            print("no labels")
        return
    if cmd == "add" and len(args) >= 2:
        addr, label = args[0].strip(), args[1].strip()
        category = (args[2] if len(args) > 2 else "other").lower()
        url = args[3] if len(args) > 3 else None
        if not valid_address(coin, addr):
            sys.exit(f"not a valid {coin} address: {addr}")
        if category not in CATEGORIES:
            sys.exit(f"category must be one of {', '.join(CATEGORIES)}")
        if not label or len(label) > 128:
            sys.exit("label must be 1-128 characters")
        if url and not url.startswith(("https://", "http://")):
            sys.exit("url must start with http:// or https://")
        cur.execute("INSERT INTO labels (address, label, category, url, source) VALUES (%s,%s,%s,%s,'local') "
                    "ON DUPLICATE KEY UPDATE label=VALUES(label), category=VALUES(category), url=VALUES(url), "
                    "source='local'", (addr, label, category, url))
        cur.execute("SELECT COUNT(*) FROM addresses WHERE address=%s", (addr,))
        seen = cur.fetchone()[0]
        print(f"labelled {addr} as '{label}' ({category}, local)"
              + ("" if seen else "  [address not seen on chain yet]"))
    elif cmd == "rm" and len(args) == 1:
        cur.execute("DELETE FROM labels WHERE address=%s", (args[0],))
        print("removed" if cur.rowcount else "no such label")
    else:
        usage()
    bump_generation(coin)


if __name__ == "__main__":
    main()
