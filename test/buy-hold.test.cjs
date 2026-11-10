const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, fingerprint } = require('../lib/buy-hold.cjs');
const config = { tickValueUsd: 5, tickSize: .25, commissionPerContractUsd: 4.5, slippageTicks: 1 };
const candles = [
  { timestamp: '2026-01-02T14:30:00.000Z', open: 100, close: 110, instrumentId: 1 },
  { timestamp: '2026-01-02T14:31:00.000Z', open: 110, close: 120, instrumentId: 1 },
  { timestamp: '2026-01-03T14:30:00.000Z', open: 200, close: 220, instrumentId: 2 }
];
function report(data = candles) { return { generatedAt: '2026-01-04T00:00:00Z', window: { start: '2026-01-01T00:00:00Z', end: '2026-01-04T00:00:00Z' }, provenance: { dataFingerprint: fingerprint(data) }, strategies: [{ slug: 'test', name: 'Test', research: { sizing: {}, trades: [{ date: '2026-01-02', exitedAt: '2026-01-02T20:00:00Z', realizedPnlUsd: 100 }], review: { total: { trades: 1, netPnlUsd: 100, maxDrawdownUsd: 0 } } } }] }; }
test('buy and hold excludes roll gaps and applies one round-trip cost per contract segment', () => {
  const result = calculate(candles, report(), config);
  assert.equal(result.rolls, 1);
  assert.equal(result.nq.netPnlUsd, 800 - 29);
  assert.equal(result.cashProxy.netPnlUsd, 16000);
  assert.equal(result.strategies[0].vsNqUsd, 100 - 771);
});
test('comparison rejects cached candles that differ from the completed backtest', () => {
  assert.throws(() => calculate(candles.slice(1), report(), config), /exactly match/);
});
