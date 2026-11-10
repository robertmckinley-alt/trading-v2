const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBacktestValidation, distribution, sequenceRisk, walkForward } = require('../lib/backtest-validation.cjs');

function fixture() {
  const dates = [];
  for (let time = Date.parse('2025-01-01'); time < Date.parse('2025-10-01'); time += 86_400_000) {
    if (![0, 6].includes(new Date(time).getUTCDay())) dates.push(new Date(time).toISOString().slice(0, 10));
  }
  const trades = dates.map((date, index) => ({ date, filledAt: `${date}T15:00:00Z`, contracts: 1, realizedPnlUsd: index % 4 ? 100 : -50 }));
  return { dates, trades };
}

test('all-strategy validation reports chronological folds, distribution, doubled costs and deterministic sequence risk', () => {
  const { dates, trades } = fixture();
  const report = { provenance: { dataFingerprint: 'abc' }, strategies: [{ slug: 'alpha', research: { trades } }] };
  const options = { tradingDates: dates, config: { commissionPerContractUsd: 4.5, slippageTicks: 1, tickValueUsd: 5 }, definitions: [{ slug: 'alpha' }] };
  const first = buildBacktestValidation(report, options);
  const second = buildBacktestValidation(report, options);
  assert.deepEqual(first, second);
  assert.equal(first.controls.automaticOptimization, false);
  assert.equal(first.controls.livePromotion, false);
  assert.equal(first.strategies[0].walkForward.folds.length, 3);
  assert.ok(first.strategies[0].walkForward.doubledCosts.netPnlUsd < first.strategies[0].walkForward.aggregate.netPnlUsd);
  assert.equal(first.strategies[0].sequenceRisk.replicates, 250);
  assert.ok(first.strategies[0].sequenceRisk.maxDrawdownUsd.p95 >= first.strategies[0].sequenceRisk.maxDrawdownUsd.p50);
  assert.equal(first.strategies[0].gates.forwardPaperVerified, false);
});

test('validation helpers fail closed when history is too short and preserve chronological distributions', () => {
  const { dates, trades } = fixture();
  assert.equal(walkForward(trades, dates.slice(0, 20), 10).status, 'insufficient-data');
  assert.equal(sequenceRisk([], dates, 'empty').status, 'insufficient-data');
  const values = distribution([{ realizedPnlUsd: 50 }, { realizedPnlUsd: -100 }, { realizedPnlUsd: 25 }]);
  assert.deepEqual([values.minimumUsd, values.medianUsd, values.maximumUsd], [-100, 25, 50]);
});
