# Contributing

## Add a label for your pool or exchange

Labels are the names shown next to addresses on the explorer: in the latest blocks ("found by"),
the pool list, the rich list and on address pages. They live in one JSON file per coin, for
example [`labels/neb.json`](labels/neb.json).

1. Fork this repository and add an entry to the file of your coin:

   ```json
   { "address": "neb1…", "name": "Your Pool", "category": "pool", "url": "https://yourpool.example",
     "fee": 1, "fee_source": "https://yourpool.example/fees" }
   ```

   | field | required | rules |
   |---|---|---|
   | `address` | yes | a valid address of that coin, lowercase; each address only once |
   | `name` | yes | 1–48 characters: letters, digits, spaces and `. , & + ' ( ) / : - _` |
   | `category` | yes | `pool`, `exchange`, `project`, `holder` or `other` |
   | `url` | no | a plain `https://` link to your site |
   | `fee` | no (pools) | pool fee in percent, e.g. `1` or `0.5` |
   | `miner_fee` | no (pools) | fee of your own miner software in percent, if miners must use it |
   | `fee_source` | no (pools) | `https://` link where the fee is published; without it the explorer marks the fee as not verified |

   Several addresses may share the same name (for example a pool with more than one payout address).

2. Check the file locally (optional, the pull request runs the same check):

   ```
   pip install blake3
   cd indexer && python label.py neb check ../labels/neb.json
   ```

3. Open a pull request and fill in the template. We only merge a label when we can verify that
   the address belongs to you, for example because your website lists it.

After the merge the label appears on the explorer with the next deploy.

## Add mining benchmarks (miner authors and miners)

The mining calculator compares cards using the rates in one JSON file per coin, for example
[`benchmarks/neb.json`](benchmarks/neb.json). Rates are evaluated attempts per second (H/s) on each
model of the coin: NEB alternates two models by block height (Kepler on even heights, TESS on odd),
and a card can be many times faster on one than on the other, so both are needed.

```json
{ "miner": "yourminer", "version": "2.1.0", "gpu": "RTX 4090", "vendor": "nvidia", "power_w": 450,
  "rates": { "kepler": 250000000, "tess": 2600000000 }, "date": "2026-11-21",
  "source": "https://github.com/you/yourminer#benchmarks", "fee": 1, "note": "stock clocks, Linux" }
```

| field | rules |
|---|---|
| `miner`, `gpu` | 1–64 characters: letters, digits, spaces and `. , + ( ) / _ -` |
| `version` | the miner version measured, e.g. `1.9.50` |
| `vendor` | `nvidia`, `amd`, `intel`, `cpu` or `other` |
| `power_w` | power limit in whole watts |
| `rates` | whole H/s for every model of the coin (`kepler` and `tess` for NEB) |
| `date` | day of the measurement, `YYYY-MM-DD` |
| `source` | an `https://` link to where the measurement is published |
| `fee` | the miner's own dev fee in percent (`0` if it has none); the calculator takes it off the yield together with the pool's fee |
| `note` | optional, one line, at most 160 characters: how it was measured (clocks, live or benchmark) |

Check the file with `python tools/benchmarks.py check benchmarks/neb.json` and open a pull request
with a link to the published measurement. suprminer's own release tables are also imported
automatically every day.

## Code changes

Bug reports and pull requests are welcome. Never commit credentials, `.env` files or server
configuration with passwords; the pull request checks scan for secrets and will fail.
