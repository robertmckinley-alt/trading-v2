const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isManagedWatcher } = require('../scripts/strategy-watchdog.cjs');

const root = path.resolve(__dirname, '..');
const args = ['/usr/local/bin/node', 'paper-trader.cjs', 'watch-live', '--provider=databento-live', '--interval=60000', '--strategy=live-9am-sweep'];

test('recognizes only the exact managed strategy watcher in this project', () => {
  assert.equal(isManagedWatcher(root, args, 'live-9am-sweep'), true);
  assert.equal(isManagedWatcher(root, args, 'nq-fresh-level-retest'), false);
  assert.equal(isManagedWatcher('/tmp/other-project', args, 'live-9am-sweep'), false);
  assert.equal(isManagedWatcher(root, [...args, '--reset-state'], 'live-9am-sweep'), true);
  assert.equal(isManagedWatcher(root, args.map(x => x.replace('databento-live', 'mock')), 'live-9am-sweep'), false);
  assert.equal(isManagedWatcher(root, args.filter(x => x !== '--interval=60000'), 'live-9am-sweep'), false);
});
