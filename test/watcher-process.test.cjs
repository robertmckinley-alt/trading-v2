const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ROOT, isManagedWatcher, matchingPids, acquireWatcherLock } = require('../lib/watcher-process.cjs');
const { assertFlat } = require('../scripts/watcher-control.cjs');
const { buildLiveStrategy } = require('../lib/live-status.cjs');
const slug = 'nq-dmc-market-open';
const args = ['node', 'paper-trader.cjs', 'watch-live', '--provider=databento-live', '--interval=60000', `--strategy=${slug}`];


test('legacy lock with a live unrelated PID is recovered without killing that process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-reused-'));
  fs.mkdirSync(path.join(root, 'runtime'));
  const file = path.join(root, 'runtime', `${slug}-watch.lock`);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'legacy' }));
    const release = acquireWatcherLock(root, slug, { findPids: () => [] });
    assert.notEqual(JSON.parse(fs.readFileSync(file)).token, 'legacy');
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    release();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('watcher identity accepts absolute node and script paths but rejects another checkout or slug prefix', () => {
  assert.equal(isManagedWatcher(ROOT, args, slug), true);
  assert.equal(isManagedWatcher(ROOT, ['/usr/local/bin/node', path.join(ROOT, 'paper-trader.cjs'), ...args.slice(2)], slug), true);
  assert.equal(isManagedWatcher(path.join(ROOT, 'other'), args, slug), false);
  assert.equal(isManagedWatcher(ROOT, args.map(a => a.replace(slug, `${slug}-extra`)), slug), false);
  assert.equal(isManagedWatcher(ROOT, ['node', 'different.cjs', ...args.slice(2)], slug), false);
  assert.equal(matchingPids(slug, ROOT, path.join(ROOT, 'nonexistent-proc-directory')), null);
});

test('watcher ownership lock rejects a second writer, allows safe release and recovers a dead owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-lock-'));
  const options = { findPids: () => [], pidAlive: pid => pid === process.pid };
  try {
    const release = acquireWatcherLock(root, slug, options);
    assert.throws(() => acquireWatcherLock(root, slug, options), /already owns/);
    release();
    const file = path.join(root, 'runtime', `${slug}-watch.lock`);
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'old' }));
    const recovered = acquireWatcherLock(root, slug, options);
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    recovered();
    assert.throws(() => acquireWatcherLock(root, slug, { findPids: () => [99999] }), /already running/);
    assert.throws(() => acquireWatcherLock(root, '../escape', options), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('watcher stop refuses open plans and malformed journals without editing state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-stop-'));
  const file = path.join(root, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ live: { openPlan: { setup: {} } } }));
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => assertFlat(file), /paper plan is open/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    fs.writeFileSync(file, JSON.stringify({ live: { openPlan: null } }));
    assert.doesNotThrow(() => assertFlat(file));
    fs.writeFileSync(file, '{malformed');
    assert.throws(() => assertFlat(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live health rejects duplicate watchers even with a fresh successful heartbeat', () => {
  const base = { config: { startingBalanceUsd: 50000, live: {} }, slug, state: {
    trades: [], live: { heartbeat: { at: new Date().toISOString(), ok: true } }
  }, logText: '', pid: process.pid };
  const duplicate = buildLiveStrategy({ ...base, processCount: 2 });
  assert.equal(duplicate.watcher.isRunning, true);
  assert.equal(duplicate.watcher.isHealthy, false);
  assert.equal(duplicate.watcher.statusLabel, 'Duplicate watchers');
  assert.match(duplicate.watcher.staleStatusHint, /2 watcher processes/);
  assert.equal(buildLiveStrategy({ ...base, processCount: 1 }).watcher.isHealthy, true);
  assert.equal(buildLiveStrategy({ ...base, processCount: 0 }).watcher.isRunning, false);
});

test('lock ownership distinguishes zombies, reused PIDs, real writers and unreadable identities', () => {
  const { inspectLockOwner } = require('../lib/watcher-process.cjs');
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-proc-'));
  const dir = path.join(proc, '123'); fs.mkdirSync(dir);
  const writeStat = state => fs.writeFileSync(path.join(dir, 'stat'), `123 (node worker) ${[state, ...Array(18).fill('0'), '999'].join(' ')}`);
  const owner = { pid: 123, startTicks: '999' };
  try {
    writeStat('Z');
    assert.equal(inspectLockOwner(owner, ROOT, slug, proc).active, false);
    writeStat('S');
    fs.symlinkSync(ROOT, path.join(dir, 'cwd'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(dir, 'cmdline'), args.join('\0'));
    assert.equal(inspectLockOwner(owner, ROOT, slug, proc).active, true);
    assert.equal(inspectLockOwner({ pid: 123 }, ROOT, slug, proc).active, true);
    assert.equal(inspectLockOwner({ pid: 123, startTicks: '998' }, ROOT, slug, proc).active, false);
    fs.writeFileSync(path.join(dir, 'cmdline'), ['node', 'other.cjs'].join('\0'));
    assert.equal(inspectLockOwner({ pid: 123 }, ROOT, slug, proc).active, false);
    fs.writeFileSync(path.join(dir, 'cmdline'), ['node', 'scripts/live-status-server.cjs'].join('\0'));
    assert.equal(inspectLockOwner(owner, ROOT, 'status-server', proc, 'scripts/live-status-server.cjs').active, true);
    writeStat('Z');
    assert.equal(inspectLockOwner(owner, ROOT, 'status-server', proc, 'scripts/live-status-server.cjs').active, false);
    writeStat('S');
    fs.unlinkSync(path.join(dir, 'cmdline'));
    assert.equal(inspectLockOwner(owner, ROOT, slug, proc).active, true);
    assert.equal(inspectLockOwner({ pid: 456 }, ROOT, slug, proc).active, false);
  } finally { fs.rmSync(proc, { recursive: true, force: true }); }
});
