const { createHash } = require('node:crypto');

const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const monthStart = (date) => `${date.slice(0, 7)}-01`;
function addMonths(date, count) {
  const [year, month] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + count, 1)).toISOString().slice(0, 10);
}
function tradeDate(trade) { return String(trade.date || trade.filledAt || '').slice(0, 10); }
function percentile(sorted, fraction) { return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : 0; }

function summary(trades, extraCostPerContractUsd = 0) {
  let net = 0, grossProfit = 0, grossLoss = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...trades].sort((a, b) => tradeDate(a).localeCompare(tradeDate(b)) || String(a.filledAt || '').localeCompare(String(b.filledAt || '')))) {
    const pnl = Number(trade.realizedPnlUsd) - extraCostPerContractUsd * Number(trade.contracts || 1);
    net += pnl; grossProfit += Math.max(0, pnl); grossLoss += Math.max(0, -pnl);
    peak = Math.max(peak, net); maxDrawdown = Math.max(maxDrawdown, peak - net);
  }
  return { trades: trades.length, netPnlUsd: round(net), expectancyUsd: trades.length ? round(net / trades.length) : 0,
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit ? null : 0, maxDrawdownUsd: round(maxDrawdown) };
}

function distribution(trades) {
  const values = trades.map(trade => Number(trade.realizedPnlUsd)).filter(Number.isFinite).sort((a, b) => a - b);
  return { observations: values.length, minimumUsd: round(values[0] || 0), p05Usd: round(percentile(values, .05)),
    medianUsd: round(percentile(values, .5)), p95Usd: round(percentile(values, .95)), maximumUsd: round(values.at(-1) || 0) };
}

function sequenceRisk(trades, dates, seedText) {
  const daily = new Map(dates.map(date => [date, 0]));
  for (const trade of trades) daily.set(tradeDate(trade), (daily.get(tradeDate(trade)) || 0) + Number(trade.realizedPnlUsd));
  const values = dates.map(date => daily.get(date) || 0);
  const method = { method: 'circular-moving-block-bootstrap', replicates: 250, blockSessions: 5 };
  if (values.length < 10 || !trades.length) return { ...method, status: 'insufficient-data', observedSessions: values.length };
  let seed = Number.parseInt(createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16) || 1;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4_294_967_296; };
  const finals = [], drawdowns = [];
  for (let run = 0; run < method.replicates; run += 1) {
    let net = 0, peak = 0, drawdown = 0, count = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < method.blockSessions && count < values.length; offset += 1, count += 1) {
        net += values[(start + offset) % values.length]; peak = Math.max(peak, net); drawdown = Math.max(drawdown, peak - net);
      }
    }
    finals.push(net); drawdowns.push(drawdown);
  }
  finals.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
  return { ...method, status: 'retrospective-resampling', observedSessions: values.length,
    endingPnlUsd: { p05: round(percentile(finals, .05)), p50: round(percentile(finals, .5)), p95: round(percentile(finals, .95)) },
    maxDrawdownUsd: { p50: round(percentile(drawdowns, .5)), p95: round(percentile(drawdowns, .95)) } };
}

function walkForward(trades, dates, extraCost) {
  if (!dates.length) return { method: 'six-month-rolling-train-one-month-test', folds: [], status: 'insufficient-data' };
  const firstMonth = monthStart(dates[0]);
  const lastExclusive = addMonths(monthStart(dates.at(-1)), 1);
  const folds = [];
  for (let testStart = addMonths(firstMonth, 6); addMonths(testStart, 1) <= lastExclusive; testStart = addMonths(testStart, 1)) {
    const trainStart = addMonths(testStart, -6), testEnd = addMonths(testStart, 1);
    const training = trades.filter(t => tradeDate(t) >= trainStart && tradeDate(t) < testStart);
    const test = trades.filter(t => tradeDate(t) >= testStart && tradeDate(t) < testEnd);
    folds.push({ trainingStart: trainStart, testStart, testEndExclusive: testEnd, training: summary(training), test: summary(test), doubledCosts: summary(test, extraCost) });
  }
  const tested = folds.flatMap(fold => trades.filter(t => tradeDate(t) >= fold.testStart && tradeDate(t) < fold.testEndExclusive));
  const positiveFolds = folds.filter(fold => fold.test.expectancyUsd > 0).length;
  return { method: 'six-month-rolling-train-one-month-test', status: folds.length ? 'retrospective-walk-forward' : 'insufficient-data', folds,
    positiveFoldRate: folds.length ? round(100 * positiveFolds / folds.length) : 0, aggregate: summary(tested), doubledCosts: summary(tested, extraCost) };
}

function buildBacktestValidation(report, { tradingDates = [], config = {}, definitions = [] } = {}) {
  const dates = [...new Set(tradingDates)].sort();
  const extraCost = Number(config.commissionPerContractUsd || 0) + 2 * Number(config.slippageTicks || 0) * Number(config.tickValueUsd || 0);
  const strategies = (report.strategies || []).map(strategy => {
    const trades = strategy.research?.trades || [];
    const walk = walkForward(trades, dates, extraCost);
    return { slug: strategy.slug, evidenceType: 'retrospective-simulation', distribution: distribution(trades),
      walkForward: walk, sequenceRisk: sequenceRisk(trades, dates, `${strategy.slug}|${report.provenance?.dataFingerprint || ''}`),
      gates: { minimum50Trades: trades.length >= 50, walkForwardAvailable: walk.folds.length > 0,
        positiveWalkForward: walk.aggregate?.expectancyUsd > 0, survivesDoubledCosts: walk.doubledCosts?.expectancyUsd > 0,
        forwardPaperVerified: false } };
  });
  return { version: 'all-strategy-validation-v1', label: 'Retrospective validation diagnostics. These results are not untouched evidence and cannot authorize live trading.',
    controls: { chronologicalEvaluation: true, rollingWalkForward: true, doubledCostStress: true, blockBootstrap: true,
      parameterSearch: 'finite preregistered variants only', automaticOptimization: false, livePromotion: false },
    strategyDefinitions: definitions.length, strategies };
}

module.exports = { buildBacktestValidation, distribution, sequenceRisk, summary, walkForward };
