const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeBacktest, getBacktestStatus, requestBacktestRefresh } = require('../lib/backtest-service.cjs');

function session(date) {
  const start = Date.parse(`${date}T14:30:00Z`);
  return Array.from({ length: 390 }, (_, i) => {
    const price = i < 15 ? 20000 : i < 30 ? 20000 + (i - 15) * .4 : i < 40 ? 20006 + (i - 30) : 20016;
    return { timestamp: new Date(start + i * 60000).toISOString(), open: price,
      high: price + 1, low: price - 1, close: price + .5, volume: 100, instrumentId: 1 };
  });
}


test('queued bridge starts once, keeps authorization private and returns pending progress', async () => {
  const requests = [];
  const status = await requestBacktestRefresh({ startYear: 2025,
    env: { BACKTEST_SOURCE_URL: 'https://bridge.example/api/backtest', LIVE_STATUS_TOKEN: 'test-token' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true, pending: true, progress: { phase: 'starting' } }) }; } });
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { startYear: 2025, background: true });
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(status.pending, true);
  assert.equal(JSON.stringify(status).includes('test-token'), false);
});

test('status keeps last completed report while a new run is pending, including first-run empty state', async () => {
  for (const result of [null, { generatedAt: '2026-01-01T00:00:00Z' }]) {
    const status = await getBacktestStatus({ env: { BACKTEST_SOURCE_URL: 'https://bridge.example/api/backtest' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, pending: true, result, progress: { phase: 'simulating', strategyIndex: 2 } }) }) });
    assert.deepEqual(status.result, result);
    assert.equal(status.pending, true);
    assert.equal(status.progress.strategyIndex, 2);
  }
});
