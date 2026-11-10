const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env.local'), quiet: true });
try {
  const report = JSON.parse(fs.readFileSync(process.env.BACKTEST_CACHE_PATH || path.join(root, 'runtime', 'backtest-results.json')));
  const config = require('../lib/trader-core.cjs').normalizeConfig(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))));
  const result = require('../lib/buy-hold.cjs').fromCache(root, report, config);
  const file = path.join(root, 'runtime', 'buy-hold-results.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(result)); fs.renameSync(`${file}.tmp`, file);
  console.log(`BENCHMARK READY: ${result.candles} candles, ${result.strategies.length} strategies, ${result.firstCandleAt} through ${result.lastCandleAt}. No download.`);
} catch (error) { console.error(`Benchmark not ready: ${error.message}`); process.exitCode = 1; }
