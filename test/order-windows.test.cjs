const test = require('node:test');
const assert = require('node:assert/strict');
const { deadlines } = require('../lib/execution-policy.cjs');
const { bindForwardObservation } = require('../lib/watcher-observation.cjs');
const core = require('../lib/trader-core.cjs');
const config = core.normalizeConfig(require('../config.json'));
function plan(model, execution, expiry) {
  return { setup: { execution, side: 'long', entry: 100, stop: 95,
    signalAvailableAt: '2026-10-05T16:40:00Z', orderExpiresAt: expiry,
    setup: { entryModel: model } }, targets: [{ price: 110, closeFraction: 1 }],
    sizing: { maxContracts: 1, riskBudgetUsd: 500, actualRiskUsd: 110 } };
}
test('DMC retest can fill after minute three but before its original fifteen-minute deadline', () => {
  const p = plan('dmc-level-to-level', 'limit-touch', '2026-10-05T16:55:00Z');
  deadlines(p.setup);
  bindForwardObservation(p, Date.parse('2026-10-05T16:40:27Z'));
  assert.equal(p.setup.orderExpiresAt, '2026-10-05T16:55:00.000Z');
  const candle = { timestamp: '2026-10-05T16:46:00Z', open: 101, high: 102, low: 99.75, close: 101 };
  assert.equal(core.trackTradeLifecycle(p, [candle], config, { closeOpenAtEnd: false }).filledAt, candle.timestamp);
  assert.equal(core.trackTradeLifecycle(p, [{ ...candle, timestamp: '2026-10-05T16:55:00Z' }], config).status, 'not-filled');
});
test('Fresh Retest polling delay permits only its next observable minute, never earlier candles', () => {
  const p = plan('fresh-level-retest', 'next-bar-market', '2026-10-05T16:41:00Z');
  deadlines(p.setup);
  bindForwardObservation(p, Date.parse('2026-10-05T16:40:27Z'));
  assert.equal(p.setup.signalAvailableAt, '2026-10-05T16:41:00.000Z');
  assert.equal(p.setup.orderExpiresAt, '2026-10-05T16:42:00.000Z');
  const bars = ['16:40:00', '16:41:00'].map(t => ({ timestamp: `2026-10-05T${t}Z`, open: 101, high: 102, low: 100, close: 101 }));
  assert.equal(core.trackTradeLifecycle(p, bars, config, { closeOpenAtEnd: false }).filledAt, bars[1].timestamp);
  assert.throws(() => bindForwardObservation(p, Date.parse('2026-10-05T16:43:01Z')), /stale/i);
});
test('strategy timing does not bypass earlier DMC cutoffs or Fresh Retest session exit', () => {
  const dmc = plan('dmc-level-to-level', 'limit-touch', '2026-10-05T16:42:00Z');
  deadlines(dmc.setup);
  bindForwardObservation(dmc, Date.parse('2026-10-05T16:40:27Z'));
  assert.equal(dmc.setup.orderExpiresAt, '2026-10-05T16:42:00.000Z');
  const fresh = plan('fresh-level-retest', 'next-bar-market', '2026-10-05T16:41:00Z');
  fresh.setup.flattenAt = '2026-10-05T16:41:00Z';
  assert.throws(() => bindForwardObservation(fresh, Date.parse('2026-10-05T16:40:27Z')), /deadline/);
});
