const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/trader-core.cjs');

function fixture(overrides = {}, configOverrides = {}) {
  const config = core.normalizeConfig({
    startingBalanceUsd: 50000, maxAccountDrawdownPercent: 10,
    maxRiskPerTradeUsd: 500, tickSize: 0.25, tickValueUsd: 5,
    commissionPerContractUsd: 4.5, slippageTicks: 1,
    defaultScaleOuts: [{ targetIndex: 0, closeFraction: 0.5 }, { targetIndex: 1, closeFraction: 0.5 }],
    ...configOverrides
  });
  const setup = core.normalizeSetup({
    entry: 100, stop: 95, targets: [110, 115], side: 'long',
    execution: 'next-bar-market', detectedAt: '2026-01-02T15:00:00Z',
    thesis: 'Execution fixture', setup: {}, ...overrides
  }, config);
  return { config, plan: core.buildTradePlan(setup, config, core.createEmptyState(config)) };
}
const candle = (minute, open, high, low, close) => ({
  timestamp: `2026-01-02T15:${String(minute).padStart(2, '0')}:00Z`, open, high, low, close
});
test('an overdue session exit uses the first available open before later targets', () => {
  const { plan, config } = fixture();
  const result = core.trackTradeLifecycle(plan, [candle(1, 100, 101, 99, 100),
    { timestamp: '2026-01-02T22:00:00Z', open: 102, high: 120, low: 101, close: 119 }], config,
  { researchFixedContracts: 1, closeOpenAtEnd: false, flattenAt: '2026-01-02T21:00:00Z' });
  assert.equal(result.status, 'closed');
  assert.equal(result.finalExitPrice, 101.75);
  assert.deepEqual(result.targetsHit, []);
  assert.match(result.exitReason, /delayed session exit/);
});

test('market entry is after detection, sizes actual gap risk, and preserves structural stop', () => {
  const { plan, config } = fixture();
  const result = core.replayPlan(plan, [candle(0, 100, 115, 90, 100), candle(1, 103, 104, 102, 103)], config);
  assert.equal(plan.sizing.maxContracts, 4);
  assert.equal(result.contracts, 2);
  assert.equal(result.filledAt, '2026-01-02T15:01:00Z');
  assert.equal(result.filledEntryPrice, 103.25);
  assert.equal(result.actualRiskUsd, 349);
  assert.equal(result.realizedPnlUsd, -29); // Two adverse quarter-points and $4.50 round-trip per contract.
  assert.equal(result.slippageCostUsd, 20);
  assert.equal(result.remainingContracts, 0);
  assert.equal(result.unrealizedPnlUsd, 0);
  assert.equal(plan.setup.stop, 95);
  assert.equal(core.toJournalTrade(plan, result).entry, 103.25);
});

test('long stop gaps execute at worse opening price, with exit slippage', () => {
  const { plan, config } = fixture();
  const result = core.replayPlan(plan, [candle(1, 100, 101, 99, 100), candle(2, 90, 116, 89, 92)], config);
  assert.equal(result.exitReason, 'stop-loss gap');
  assert.equal(result.finalExitPrice, 89.75);
  assert.equal(result.realizedPnlUsd, -858);
  assert.equal(result.exitedAt, '2026-01-02T15:02:00Z');
  assert.deepEqual(result.targetsHit, []);
});

test('short market entries and adverse stop gap slippage are symmetric', () => {
  const { plan, config } = fixture({ side: 'short', stop: 105, targets: [90, 85] });
  const result = core.replayPlan(plan, [candle(1, 100, 101, 99, 100), candle(2, 110, 111, 84, 108)], config);
  assert.equal(result.filledEntryPrice, 99.75);
  assert.equal(result.finalExitPrice, 110.25);
  assert.equal(result.realizedPnlUsd, -858);
});

test('market orders reject crossed structural prices and unaffordable gap risk', () => {
  for (const open of [94, 110, 108]) {
    const { plan, config } = fixture({}, { maxRiskPerTradeUsd: 120 });
    const result = core.replayPlan(plan, [candle(1, open, open + 1, open - 1, open)], config);
    assert.equal(result.status, 'not-filled');
    assert.equal(result.realizedPnlUsd, 0);
    assert.equal(result.contracts, 0);
    assert.match(result.exitReason, /entry gap/);
  }
});

test('legacy flag: limit-touch retains its entry but charges exit slippage and one round-trip fee', () => {
  const { plan, config } = fixture({ execution: 'limit-touch' }, { maxRiskPerTradeUsd: 120, limitFillModel: 'legacy-touch' });
  const result = core.replayPlan(plan, [candle(1, 101, 102, 100, 101), candle(2, 102, 111, 101, 110)], config);
  assert.equal(result.filledEntryPrice, 100);
  assert.equal(result.finalExitPrice, 109.75);
  assert.equal(result.realizedPnlUsd, 190.5);
  assert.equal(result.contracts, 1);
  assert.deepEqual(result.targetsHit, [110]);
  assert.match(result.execution.scaleOutConvention, /whole-contract/);
});

test('availability boundary and expiry survive normalization and prevent late entries', () => {
  const { plan, config } = fixture({
    signalAvailableAt: '2026-01-02T15:01:00Z', orderExpiresAt: '2026-01-02T15:02:00Z'
  });
  assert.equal(core.replayPlan(plan, [candle(1, 100, 101, 99, 100)], config).filledAt, '2026-01-02T15:01:00Z');
  const expired = core.replayPlan(plan, [candle(2, 100, 101, 99, 100)], config);
  assert.equal(expired.status, 'not-filled');
  assert.equal(expired.exitReason, 'order expired');
});

test('same-bar stop and target remains conservative after market fill', () => {
  const { plan, config } = fixture();
  const result = core.replayPlan(plan, [candle(1, 100, 116, 94, 105)], config);
  assert.equal(result.finalExitPrice, 94.75);
  assert.equal(result.exitReason, 'stop-loss same-candle conflict');
  assert.equal(result.realizedPnlUsd, -458);
  assert.equal(result.actualRiskUsd, 458);
});

test('partial scale-outs charge each closed contract once and open PnL estimates remaining exit costs', () => {
  const { plan, config } = fixture();
  const result = core.trackTradeLifecycle(plan, [candle(1, 100, 101, 99, 100), candle(2, 102, 111, 101, 108)], config, { closeOpenAtEnd: false });
  assert.equal(result.status, 'open');
  assert.equal(result.contracts, 4);
  assert.equal(result.remainingContracts, 2);
  assert.equal(result.realizedPnlUsd, 371); // 2 * ((109.75 - 100.25) * 20 - 4.5).
  assert.equal(result.unrealizedPnlUsd, 291); // Estimated liquidation of remaining 2 at 107.75.
  assert.equal(result.slippageCostUsd, 30); // Four entries plus two executed exits, no hypothetical exit counted.
  assert.equal(result.exitedAt, null);
});
