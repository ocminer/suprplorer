#!/usr/bin/env python3
"""Mining benchmarks for the calculator: one JSON file per coin (benchmarks/<coin>.json).

  benchmarks.py check <file>                       validate a benchmarks file (runs on every pull request)
  benchmarks.py suprminer <coin> [--readme FILE]   read the newest suprminer rates per GPU from its README
                                                   (GitHub by default) and print them as a benchmarks file

Rates are evaluated attempts per second for each model of the coin (NEB: kepler, tess), because the
same card runs at very different speeds on each model and the chain alternates them by height.
No dependencies beyond the Python standard library.
"""
import json
import re
import sys
import urllib.request
from datetime import date

MODELS = {"neb": ("kepler", "tess")}
VENDORS = ("nvidia", "amd", "intel", "cpu", "other")
ENTRY_KEYS = {"miner", "version", "gpu", "vendor", "power_w", "rates", "date", "source", "fee", "note"}
REQUIRED = ENTRY_KEYS - {"note", "fee"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .,+()/_-]{0,63}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$")
URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]*)?$")
SUPRMINER_README = "https://raw.githubusercontent.com/ocminer/suprminer/main/README.md"
SUPRMINER_URL = "https://github.com/ocminer/suprminer"
UNITS = {"h/s": 1, "kh/s": 1e3, "mh/s": 1e6, "gh/s": 1e9, "th/s": 1e12}


def _no_dup(pairs):
    keys = [k for k, _ in pairs]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    if dup:
        raise ValueError(f"duplicate key(s) {', '.join(dup)}")
    return dict(pairs)


def check(path):
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f, object_pairs_hook=_no_dup)
    except (OSError, ValueError) as e:
        return [f"{path}: {e}"], 0
    if not isinstance(doc, dict) or set(doc) - {"$comment", "coin", "unit", "benchmarks"}:
        return [f"{path}: top level must be an object with 'coin', 'unit' and 'benchmarks'"], 0
    coin = doc.get("coin")
    if coin not in MODELS:
        return [f"{path}: unknown coin {coin!r} (known: {', '.join(MODELS)})"], 0
    models = set(MODELS[coin])
    rows = doc.get("benchmarks")
    if not isinstance(rows, list):
        return [f"{path}: 'benchmarks' must be a list"], 0
    errors, seen = [], set()
    for i, e in enumerate(rows):
        w = f"{path}: benchmarks[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{w}: must be an object")
            continue
        w += f" ({e.get('miner', '?')} {e.get('version', '?')}, {e.get('gpu', '?')})"
        if set(e) - ENTRY_KEYS:
            errors.append(f"{w}: unknown field(s) {', '.join(sorted(set(e) - ENTRY_KEYS))}")
        if REQUIRED - set(e):
            errors.append(f"{w}: missing field(s) {', '.join(sorted(REQUIRED - set(e)))}")
            continue
        for k in ("miner", "gpu"):
            if not isinstance(e[k], str) or not NAME_RE.match(e[k]):
                errors.append(f"{w}: {k} must be 1-64 characters of letters, digits, spaces and . , + ( ) / _ -")
        if not isinstance(e["version"], str) or not VERSION_RE.match(e["version"]):
            errors.append(f"{w}: version must be 1-32 characters like 1.9.50")
        if e["vendor"] not in VENDORS:
            errors.append(f"{w}: vendor must be one of {', '.join(VENDORS)}")
        if not isinstance(e["power_w"], int) or isinstance(e["power_w"], bool) or not 1 <= e["power_w"] <= 3000:
            errors.append(f"{w}: power_w must be a whole number of watts, 1-3000")
        r = e["rates"]
        if not isinstance(r, dict) or set(r) != models:
            errors.append(f"{w}: rates must give exactly {', '.join(sorted(models))}")
        elif not all(isinstance(v, int) and not isinstance(v, bool) and 0 < v < 10**15 for v in r.values()):
            errors.append(f"{w}: each rate must be a whole number of attempts per second (H/s), above 0")
        if not isinstance(e["date"], str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", e["date"]):
            errors.append(f"{w}: date must be YYYY-MM-DD")
        else:
            try:
                date.fromisoformat(e["date"])
            except ValueError:
                errors.append(f"{w}: date is not a real date")
        if not isinstance(e["source"], str) or len(e["source"]) > 255 or not URL_RE.match(e["source"]):
            errors.append(f"{w}: source must be an https:// link to the published measurement")
        if "fee" in e and (isinstance(e["fee"], bool) or not isinstance(e["fee"], (int, float)) or not 0 <= e["fee"] <= 50):
            errors.append(f"{w}: fee must be the miner's dev fee in percent, 0-50")
        if "note" in e and (not isinstance(e["note"], str) or len(e["note"]) > 160 or any(ord(c) < 32 for c in e["note"])):
            errors.append(f"{w}: note must be one line of at most 160 characters")
        key = (e.get("miner"), e.get("version"), e.get("gpu"), e.get("power_w"))
        if key in seen:
            errors.append(f"{w}: duplicate of another entry (same miner, version, GPU and power)")
        seen.add(key)
    return errors, len(rows)


# ------------------------------------------------------------------ suprminer README import
def _rate(text):
    """'362 MH/s / 5.37 GH/s' or '97.6 / 874 MH/s' -> (kepler H/s, tess H/s)."""
    t = text.replace("*", "").strip().lower()
    parts = [p.strip() for p in t.split("/ ") if p.strip()] if " / " in t else []
    m = re.match(r"^([\d.]+)\s*([kmgt]?h/s)?\s*/\s*([\d.]+)\s*([kmgt]?h/s)$", t)
    if not m:
        return None
    a, ua, b, ub = m.groups()
    ua = ua or ub
    return round(float(a) * UNITS[ua]), round(float(b) * UNITS[ub])


def _vkey(v):
    return tuple(int(x) for x in v.split("."))


def suprminer(coin, readme):
    """Newest Kepler/TESS rate per GPU from the release tables of the suprminer README."""
    if coin != "neb":
        sys.exit("suprminer import knows NEB only")
    best = {}
    blocks = re.findall(r"<!-- (NEB[0-9A-Z_]*):BEGIN -->(.*?)<!-- \1:END -->", readme, re.S)
    for name, body in blocks:
        dm = re.search(r"Measured on \w+ on ([0-9 and]+ \w+ \d{4})", body)
        day = None
        if dm:
            words = dm.group(1).replace(" and", "").split()
            try:  # "20 21 November 2026" -> last day mentioned
                day = date(int(words[-1]), ["january", "february", "march", "april", "may", "june", "july", "august",
                           "september", "october", "november", "december"].index(words[-2].lower()) + 1, int(words[-3]))
            except (ValueError, IndexError):
                day = None
        lines = [l for l in body.splitlines() if l.startswith("|")]
        if len(lines) < 3:
            continue
        head = [c.strip() for c in lines[0].strip("|").split("|")]
        vcols = [(i, re.match(r"^(\d+\.\d+\.\d+) Kepler / TESS$", h).group(1)) for i, h in enumerate(head)
                 if re.match(r"^(\d+\.\d+\.\d+) Kepler / TESS$", h)]
        if not vcols:
            continue
        col, version = max(vcols, key=lambda c: _vkey(c[1]))
        vendor = "amd" if "opencl" in head[0].lower() else "nvidia"
        pcol = next((i for i, h in enumerate(head) if "power" in h.lower()), None)
        for line in lines[2:]:
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) <= col:
                continue
            rate = _rate(cells[col])
            pm = re.match(r"^(\d+)\s*W$", cells[pcol]) if pcol is not None else None
            if not rate or not pm:
                continue
            gpu = cells[0].replace("*", "").strip()
            entry = {"miner": "suprminer", "version": version, "gpu": gpu, "vendor": vendor,
                     "power_w": int(pm.group(1)), "rates": {"kepler": rate[0], "tess": rate[1]},
                     "date": (day or date.today()).isoformat(), "source": f"{SUPRMINER_URL}/releases/tag/v{version}", "fee": 0}
            if _vkey(version) < (1, 9, 48):
                entry["note"] = "Older release, before attempt selection (1.9.48); current versions are faster."
            if gpu not in best or _vkey(version) > _vkey(best[gpu]["version"]):
                best[gpu] = entry
    return sorted(best.values(), key=lambda e: (-e["rates"]["tess"], e["gpu"]))


def main():
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "check":
        errors, n = check(a[1])
        if errors:
            print("\n".join(errors), file=sys.stderr)
            sys.exit(1)
        print(f"{a[1]}: {n} benchmarks OK")
    elif len(a) in (2, 4) and a[0] == "suprminer":
        if len(a) == 4 and a[2] == "--readme":
            text = open(a[3], encoding="utf-8").read()
        else:
            req = urllib.request.Request(SUPRMINER_README, headers={"User-Agent": "suprplorer-benchmarks"})
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read(4_000_000).decode("utf-8", "replace")
        rows = suprminer(a[1], text)
        if not rows:
            sys.exit("no benchmark table found in the suprminer README")
        json.dump({"coin": a[1], "unit": "evaluated attempts per second (H/s) per model",
                   "benchmarks": rows}, sys.stdout, indent=2)
        print()
    else:
        print(__doc__.strip())
        sys.exit(2)


if __name__ == "__main__":
    main()
