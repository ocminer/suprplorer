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

Labels are stored in the `labels` table of each coin database (never touched by reorgs), with
`source` = `repo` (from the file; sync adds, updates and removes them) or `local` (added by hand;
only `rm` removes them). A cluster takes the label of any labelled member (common-input-ownership).

## Configuration

Everything comes from environment variables; nothing is configured in the repository.

| variable | used by | meaning |
|---|---|---|
| `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` | indexer, web | MySQL access (give the web app a SELECT-only user) |
| `REDIS_URL` | indexer, web | e.g. `redis://default:…@127.0.0.1:6379/0` (password in the URL) |
| `NEB_RPC`, `NEB_DB`, `REDIS_PREFIX` | indexer | node RPC, coin database, Redis key prefix |
| `PORT`, `CANONICAL_ORIGIN` | web | listen port, origin used in canonical URLs and sitemaps |
| `GA4_ID`, `GOOGLE_SITE_VERIFICATION` | web | optional Google Analytics / Search Console |

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
