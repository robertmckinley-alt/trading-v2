// Short-lived cron entrypoint. Never starts or changes trading strategies.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env.local'), quiet: true });
const config = require('../config.json');
const result = spawnSync(config.live?.pythonBin || 'python3', ['scripts/feed-watchdog.py'], {
  cwd: root, env: process.env, stdio: 'inherit', timeout: 50000,
});
if (result.error) console.error(`Feed watchdog failed: ${result.error.message}`);
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const strategies = spawnSync(process.execPath, ['scripts/strategy-watchdog.cjs'], {
    cwd: root, env: process.env, stdio: 'inherit', timeout: 20000,
  });
  if (strategies.error) console.error(`Strategy watchdog failed: ${strategies.error.message}`);
  if (strategies.status !== 0) process.exitCode = strategies.status ?? 1;
}
