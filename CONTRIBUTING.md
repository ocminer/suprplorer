# Contributing

## Add a label for your pool or exchange

Labels are the names shown next to addresses on the explorer: in the latest blocks ("found by"),
the pool list, the rich list and on address pages. They live in one JSON file per coin, for
example [`labels/neb.json`](labels/neb.json).

1. Fork this repository and add an entry to the file of your coin:

   ```json
   { "address": "neb1…", "name": "Your Pool", "category": "pool", "url": "https://yourpool.example" }
   ```

   | field | required | rules |
   |---|---|---|
   | `address` | yes | a valid address of that coin, lowercase; each address only once |
   | `name` | yes | 1–48 characters: letters, digits, spaces and `. , & + ' ( ) / : - _` |
   | `category` | yes | `pool`, `exchange`, `project`, `holder` or `other` |
   | `url` | no | a plain `https://` link to your site |

   Several addresses may share the same name (for example a pool with more than one payout address).

2. Check the file locally (optional, the pull request runs the same check):

   ```
   pip install blake3
   cd indexer && python label.py neb check ../labels/neb.json
   ```

3. Open a pull request and fill in the template. We only merge a label when we can verify that
   the address belongs to you, for example because your website lists it.

After the merge the label appears on the explorer with the next deploy.

## Code changes

Bug reports and pull requests are welcome. Never commit credentials, `.env` files or server
configuration with passwords; the pull request checks scan for secrets and will fail.
