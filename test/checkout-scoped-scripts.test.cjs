const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Regression: on 2026-11-10 a name-only `pgrep -f` in these scripts stopped a sibling checkout's watchers.
test('operational shell scripts never match processes by name alone', () => {
  for (const name of ['start-live-watcher.sh', 'stop-live-watcher.sh', 'status-live-watcher.sh']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', name), 'utf8');
    assert.ok(!/\bpgrep\b|\bpkill\b|killall/.test(source), `${name} must use checkout-scoped process discovery`);
  }
});
