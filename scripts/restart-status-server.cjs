#!/usr/bin/env node
// Run inside the existing Docker container. Only this checkout's status server is restarted.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const serverFile = path.join(__dirname, 'live-status-server.cjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function matchingPids() {
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const cwd = fs.readlinkSync(`/proc/${name}/cwd`);
      const args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const entry = args.slice(1).find(arg => !arg.startsWith('-'));
      return path.basename(args[0] || '') === 'node' && entry &&
        path.resolve(cwd,entry) === serverFile ? [Number(name)] : [];
    } catch { return []; }
  });
}

async function main() {
  process.chdir(root);
  const envFile = process.env.ENV_FILE || path.join(root, '.env.local');
  if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile, quiet: true });
  const bridgeSecurity = require('../lib/bridge-security.cjs');
  bridgeSecurity.settings(bridgeSecurity.listenerEnvironment(root));
  // Validate modules before interrupting the existing calculation.
  require('../lib/backtest-service.cjs');
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  const oldPids = matchingPids();
  console.log(`Restarting status server (${oldPids.length} existing). An in-progress backtest will restart; saved results and candles are retained.`);
  for (const pid of oldPids) process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 25 && matchingPids().length; attempt += 1) await wait(200);
  if (matchingPids().length) throw new Error('The old server did not stop. No duplicate was started.');
  const log = fs.openSync(path.join(root, 'runtime', 'live-status-server.log'), 'a');
  const child = spawn(process.execPath, ['scripts/live-status-server.cjs'], { cwd: root, detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  fs.closeSync(log);
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(250);
    // A supervisor may have restarted this same checkout before our child bound.
    const managedPids = matchingPids();
    if (!managedPids.length) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.LIVE_STATUS_PORT || 3210)}/healthz`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.ok && managedPids.includes(health.pid)) {
        console.log(`HEALTHY status PID ${health.pid}. The daily backtest worker starts automatically.`);
        console.log('Progress: runtime/backtest-results.json.progress.json');
        return;
      }
    } catch { /* Wait for bind. */ }
  }
  throw new Error('New status server did not become healthy. Check runtime/live-status-server.log.');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { matchingPids };
