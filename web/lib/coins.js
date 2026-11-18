'use strict';
// Coin registry: one JSON file per coin (web/coins/<id>.json).
const fs = require('fs');
const path = require('path');

function loadCoins(dir) {
  const coins = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (c.enabled === false) continue;
    if (!/^[a-z0-9-]+$/.test(c.id)) throw new Error(`coin id must be lowercase [a-z0-9-]: ${f}`);
    coins.push({ decimals: 8, accent: '#38d5c3', ...c, base: '/' + c.id });
  }
  return coins;
}

module.exports = { loadCoins };
