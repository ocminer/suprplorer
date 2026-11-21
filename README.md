# suprplorer

Multi-coin block explorer for suprplorer.cc, communistexplorer.com and communistexplorer.net
(all identical; every coin lives at `/<coin>/` on each domain).

## Architecture

```
coin node ──RPC──> indexer (per coin, Python) ──> MySQL explorer_<coin>  ──┐
                        │                                                  │
                        └── Redis: <coin>:tip, <coin>:gen, <coin>:events ──┼──> suprplorer-web (one Node app,
                                                                           │     4 workers, all coins)
                                                       nginx (TLS, micro-cache, static) <──┘
```

- **One web app for all coins** (`web/`): Express + Pug templates (`web/views/`), our own design
  system (`web/public/css/app.css`, Geist fonts, uPlot charts, all self-hosted), data from each coin's
  MySQL index through an adapter (`web/adapters/`). No public API: pages are server-rendered, the
  browser only fetches the live tip (`/<coin>/_/tip`) and overview fragments.
- **SEO**: canonical URLs on https://suprplorer.cc (all three domains serve the same pages),
  `robots.txt`, `sitemap.xml` (pages, every block, labelled and top-1,000 addresses), Open Graph
  images, JSON-LD (Organization, WebSite search, breadcrumbs). Google Analytics and Search Console
  turn on with the `GA4_ID=G-…` and `GOOGLE_SITE_VERIFICATION=…` environment variables.
- **One indexer per coin** writing a shared schema (`indexer/schema.sql`): blocks, txs, inputs,
  outputs (= UTXO index), addresses (balances = richlist), ledger (running balance per address),
  shares, clusters (common-input-ownership), daily_stats.
- **Caching**: the indexer bumps `<coin>:gen` in Redis on every connected/disconnected block, and the
  web app caches whole responses in Redis keyed by that generation (so caches are never stale across
  blocks or reorgs). nginx adds a 5 s micro-cache and serves stale content if the app is down.

## Adding a coin

1. Run its node with a systemd unit (RPC on localhost only).
2. Create `explorer_<coin>` in MySQL (the `explorer` user already has rights on `explorer_%`).
3. Indexer:
   - **UTXO chain with linear blocks**: write a decoder like `indexer/nebcodec.py` (or use the node's
     JSON RPC), reuse `indexer.py` with `NEB_DB` / `NEB_RPC` / `REDIS_PREFIX` set for the coin.
   - **DAG / very high-throughput chain (Kaspa-like, e.g. Keryx)**: use a dedicated indexer that
     follows the virtual chain (accepted transactions per chain block) and writes the same tables
     (`blocks` = chain blocks by blue score). For very high volume, put that coin on its own
     database server or partitioned tables; the web adapter interface stays the same.
4. Add `web/coins/<coin>.json` (copy `neb.json`), drop a logo into `web/public/img/coins/`.
5. Deploy and restart `suprplorer-web`. No nginx change is needed (`/<coin>/` routes are generic).

## Address labels (pools, exchanges, known holders)

Public labels live in [`labels/<coin>.json`](labels/neb.json). Pool operators add theirs with a pull
request (see [CONTRIBUTING.md](CONTRIBUTING.md)); after a merge the operator's deploy validates every
labels file and syncs it into the coin database.

```
python indexer/label.py neb check labels/neb.json   # validate a file (also runs on every pull request)
python indexer/label.py neb sync labels/neb.json    # make the database match the file
python indexer/label.py neb add <address> "<label>" [pool|exchange|project|holder|burn|other] [url]
python indexer/label.py neb list | rm <address>
```

Pool entries can carry `fee`, `miner_fee` and `fee_source`; the Pools page and the mining calculator use them.

Labels are stored in the `labels` table of each coin database (never touched by reorgs), with
`source` = `repo` (from the file; sync adds, updates and removes them) or `local` (added by hand;
only `rm` removes them). A cluster takes the label of any labelled member (common-input-ownership).

## Emission watch

`indexer/emission_watch.py` runs every minute. It checks every coinbase against reward plus fees, the
supply against the reward schedule (carry-over included), issuance over the last 1 and 6 hours, and
the share of the largest miner, publishes the result for the Emission page and sends an alert when a
check turns bad or recovers.

## Mining benchmarks

[`benchmarks/<coin>.json`](benchmarks/neb.json) holds per-card rates for the mining calculator, per
model of the coin (see [CONTRIBUTING.md](CONTRIBUTING.md)). `tools/benchmarks.py suprminer neb`
imports the newest rates from the suprminer README; run it daily to pick up new releases.

## Mining calculator

`/<coin>/calculator` merges the benchmarks file of the repository with automatic imports
(`SUPRPLORER_BENCHMARK_DIRS`, default `/opt/suprplorer/benchmarks:/var/lib/suprplorer/benchmarks`; newer
miner version wins, the repository file wins on the same version). For each model it takes the network
hashrate and blocks per day of the last 24 hours; a card's expected blocks per day are the sum over the
models of `blocks per day x card rate / network rate`, times the miner reward (reward less the project
share, plus average fees), less the pool fee and the fee of the pool's miner. Price fields stay empty
until a price is published in Redis as `<coin>:price` (`{"usd": …, "sources": […]}`).

## Activity and forecasts

`/<coin>/activity` shows transfers (coinbase excluded), value moved to other addresses (change excluded:
ledger rows of a transaction that received without spending), fees, active and new addresses, top net
senders and receivers grouped by labelled entity or address cluster, the largest transfers, and unspent
value by output age. The Mining page adds a trend projection for hashrate and difficulty: a straight
line through the last 24 hours, extended 24 hours, with a band of 1.64 residual standard deviations
(`web/lib/forecast.js`).

## Models and finality

`indexer/model_watch.py` (a service) records, for every block, the weights hash of each model our node
reports (`getmodel`), and every 10 minutes imports the accuracy history the NEB project publishes
(`MODEL_HISTORY_URL`, default `https://neuralenginebyte.org/model-history.json`). The import is verified:
the file's hash of all models at its tip (BLAKE3 of `"neb-models"` and the weights hash of every slot)
must equal the hash computed from our own records for that block. The Models page shows the accuracy
of each model on held-out samples, its training steps and a diagram of its hidden neurons and output
links. Blocks show their finality: pending, final at 60 confirmations (deeper than any allowed
reorganisation) and spendable at 100 (coinbase maturity), and list their training share records.

## Price and market

`indexer/price_watch.py` (every 2 minutes) reads a price endpoint (`PRICE_URL`, JSON with `usd`, `btc`,
`change24hPct`, `high24h`, `low24h`, `volume24hNeb`, `volume24hUsdt`, `source`, `market`, `url`, `fetchedAt`,
`stale`), stores each new reading in the `prices` table and publishes the current one in Redis
(`<coin>:price`). Without a fresh price (none, stale, older than six hours) the key is removed and the
site shows no price. The Market page shows price, 24h range and volume, market cap, fully diluted value,
miner income in dollars, hashprice (USD per TH/s per day) and GPU profit at the current price; the header,
overview, address pages, rich list and calculator use the same price.

## Configuration

Everything comes from environment variables; nothing is configured in the repository.

| variable | used by | meaning |
|---|---|---|
| `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` | indexer, web | MySQL access (give the web app a SELECT-only user) |
| `REDIS_URL` | indexer, web | e.g. `redis://default:…@127.0.0.1:6379/0` (password in the URL) |
| `NEB_RPC`, `NEB_DB`, `REDIS_PREFIX` | indexer | node RPC, coin database, Redis key prefix |
| `PORT`, `CANONICAL_ORIGIN` | web | listen port, origin used in canonical URLs and sitemaps |
| `GA4_ID`, `GOOGLE_SITE_VERIFICATION` | web | optional Google Analytics / Search Console |
| `NTFY_URL` | emission watch | optional ntfy topic URL for alerts |
| `MODEL_HISTORY_URL` | model watch | published model accuracy history to import and verify |
| `PRICE_URL` | price watch | market price endpoint |
| `EMISSION_1H_MAX`, `EMISSION_6H_MAX`, `POOL_MAX_SHARE`, `POOL_WINDOW` | emission watch | alert thresholds (defaults 1.5, 1.25, 0.51, 360 blocks) |

Run the node, the indexer (`python indexer/indexer.py`) and the web app (`cd web && npm ci && node
server.js`) behind a reverse proxy that terminates TLS.

## Secrets

Nothing secret is in this repository, and it must stay that way:

- `.gitignore` excludes env files, keys, dumps and local notes.
- `.githooks/pre-commit` (enable with `git config core.hooksPath .githooks`) refuses commits that
  contain your real passwords (list the files holding them with
  `git config --add suprplorer.secretfile <path>`), secret-looking files or anything gitleaks flags,
  and requires a GitHub noreply commit email.
- The `checks` workflow runs gitleaks over the full history on every push and pull request, and
  GitHub secret scanning with push protection is enabled.

## License

[MIT](LICENSE). Bundled: uPlot (MIT, `web/public/vendor/uPlot.LICENSE`), Geist fonts (SIL OFL 1.1,
`web/public/fonts/OFL.txt`).
