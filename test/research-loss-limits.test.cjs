const {businessDate,completeCash}=require('../test-support/session-fixtures.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runStrategyBacktest } = require('../lib/backtest-engine.cjs');
const { reviewBacktestEvidence } = require('../lib/research-lab.cjs');
const core = require('../lib/trader-core.cjs');
const config = core.normalizeConfig(require('../config.json'));

test('all-strategy research continues unchanged after losses exhaust the guarded account', () => {
  const candles = Array.from({ length: 30 }, (_, day) => {
    const time = Date.parse(businessDate(day,'2025-01-02')+'T15:00Z');
    return [
      { timestamp: new Date(time).toISOString(), open: 100, high: 101, low: 99, close: 100 },
      { timestamp: new Date(time + 60000).toISOString(), open: 100, high: 100, low: 75, close: 80 }
    ];
  }).flat();
  const result = runStrategyBacktest(completeCash(candles), config, { slug: 'test-losses', name: 'Loss sequence' }, {
    detectSignal(context) {
      const candle = context.at(-1);
      if(candle._padding)return {found:false};
      return { found: true, triggerTimestamp: candle.timestamp, setup: {
        symbol: 'NQ', date: candle.timestamp.slice(0, 10), session: 'test', side: 'long',
        entry: 100, stop: 76, targets: [124], thesis: 'loss regression', setup: {}
      } };
    }
  });
  assert.equal(result.research.trades.length, 30);
  assert.equal(result.research.rejectedSignals, 0);
  assert.ok(result.research.metrics.netPnlUsd < -5000);
  assert.ok(result.trades.length < 30);
  assert.ok(result.rejectedSignals > 0);
  assert.equal(new Set(result.research.trades.map(t => t.contracts)).size, 1);
  assert.equal(result.research.trades.at(-1).date, businessDate(29,'2025-01-02'));
  assert.equal('drawdown' in result.research.review.gates, false);
});

test('research gates MAE-inclusive R drawdown independently of the account loss floor', () => {
  const trades = Array.from({ length: 100 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    actualRiskUsd: 500, maeUsd: -500,
    realizedPnlUsd: i < 12 ? -500 : 300, rMultiple: i < 12 ? -1 : .6
  }));
  const research = reviewBacktestEvidence(trades, { enforceAccountDrawdown: false });
  assert.ok(research.total.maxDrawdownUsd > 5000);
  assert.equal(research.recommendation, 'REVISE AND RETEST');
  assert.equal(research.gates.constantRiskDrawdown, false);
  assert.equal(reviewBacktestEvidence(trades).recommendation, 'REVISE AND RETEST');
  assert.equal('drawdown' in research.gates, false);
});

const { buildOneContractResearchPlan } = require('../lib/backtest-engine.cjs');
const { buildPlanFromSignal } = require('../lib/live-trader.cjs');

function orbSignal(stop = 100, entry = 200) {
  return { found: true, triggerTimestamp: '2026-02-02T14:59:00Z', setup: {
    symbol: 'NQ', date: '2026-02-02', session: 'test', side: 'long', entry, stop,
    targets: [300, 350], thesis: 'one-contract regression', setup: {},
    execution: 'next-bar-market', signalAvailableAt: '2026-02-02T15:00:00Z'
  } };
}



