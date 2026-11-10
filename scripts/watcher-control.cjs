// Exact checkout/argv matching; never use a broad process-name kill.
const fs = require('node:fs');
const { ROOT, matchingPids } = require('../lib/watcher-process.cjs');
const { runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');

function assertFlat(statePath) {
  if (fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath)).live?.openPlan) {
    throw new Error('Refusing watcher stop while a paper plan is open; wait for a flat account');
  }
}
async function main(args = process.argv.slice(2)) {
  const command = args[0], slug = args.find(arg => arg.startsWith('--strategy='))?.slice(11);
  const files = runtimeFilesForStrategy(ROOT, slug);
  const pids = matchingPids(slug);
  if (pids === null) throw new Error('Exact process discovery requires Linux /proc');
  if (command === 'pid') {
    if (pids.length !== 1) throw new Error(`Expected one ${slug} watcher, found ${pids.length}`);
    console.log(pids[0]); return;
  }
  if (command === 'status') { console.log(JSON.stringify({ slug, pids, count: pids.length })); return; }
  if (command !== 'stop') throw new Error('Usage: watcher-control.cjs <stop|pid|status> --strategy=SLUG');
  // An orphaned open plan must be allowed to resume when no writer exists.
  if (pids.length) assertFlat(files.statePath);
  for (const pid of pids) {
    if (pid === process.pid || !matchingPids(slug).includes(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // Only wait for original identities. A replacement must not be killed here.
  const deadline = Date.now() + 10000;
  while (matchingPids(slug).some(pid => pids.includes(pid))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${slug} watcher to stop`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(JSON.stringify({ slug, stopped: pids }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertFlat };
