const { STRATEGIES } = require('./strategy-registry.cjs');

const MIN_PROMOTION_TRADES = 50;
const MIN_PROMOTION_DAYS = 20;
const MIN_HOLDOUT_TRADES = 15;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function tradeTimestamp(trade = {}) {
  const candidate = trade.filledAt || trade.createdAt || trade.date;
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectClosedTrades(strategy = {}) {
  const recaps = Array.isArray(strategy.journal?.dailyRecaps)
    ? strategy.journal.dailyRecaps
    : [];
  const seen = new Set();
  const trades = [];

  for (const recap of recaps) {
    for (const trade of Array.isArray(recap.tradesList) ? recap.tradesList : []) {
      const pnl = Number(trade.realizedPnlUsd);
      if (!Number.isFinite(pnl)) continue;
      const key = trade.id || [trade.date || recap.date, trade.createdAt, trade.symbol, trade.side, pnl].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      trades.push({ ...trade, date: trade.date || recap.date, realizedPnlUsd: pnl });
    }
  }

  return trades.sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));
}

function splitChronologically(trades = [], ratio = 0.7) {
  const ordered = [...trades].sort((a, b) => tradeTimestamp(a) - tradeTimestamp(b));
  if (ordered.length < 2) return { training: ordered, holdout: [] };
  const splitAt = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * ratio)));
  return { training: ordered.slice(0, splitAt), holdout: ordered.slice(splitAt) };
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function performanceMetrics(trades = []) {
  const closed = trades.filter((trade) => Number.isFinite(Number(trade.realizedPnlUsd)));
  const wins = closed.filter((trade) => Number(trade.realizedPnlUsd) > 0);
  const losses = closed.filter((trade) => Number(trade.realizedPnlUsd) < 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0);
  const grossLossUsd = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0));
  const netPnlUsd = grossProfitUsd - grossLossUsd;
  const expectancyUsd = closed.length ? netPnlUsd / closed.length : 0;
  const averageR = closed.length
    ? closed.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / closed.length
    : 0;
  const dailyPnl = new Map();
  for (const trade of closed) {
    const date = trade.date || 'unknown';
    dailyPnl.set(date, (dailyPnl.get(date) || 0) + Number(trade.realizedPnlUsd));
  }

  let running = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  for (const trade of closed) {
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - (running - Math.abs(Number(trade.maeUsd || 0))));
    running += Number(trade.realizedPnlUsd);
    peak = Math.max(peak, running);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - running);
  }

  const dailyValues = [...dailyPnl.values()];
  const dailyMean = dailyValues.length
    ? dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length
    : 0;
  const dailyVolatility = standardDeviation(dailyValues);
  const downsideValues = dailyValues.filter((value) => value < 0);
  const downsideDeviation = standardDeviation(downsideValues);

  return {
    constantRisk: require('./constant-risk-metrics.cjs').metrics(closed),
    trades: closed.length,
    tradingDays: dailyPnl.size,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100) : 0,
    netPnlUsd: round(netPnlUsd),
    profitFactor: grossLossUsd > 0 ? round(grossProfitUsd / grossLossUsd) : grossProfitUsd > 0 ? null : 0,
    expectancyUsd: round(expectancyUsd),
    averageR: round(averageR),
    maxDrawdownUsd: round(maxDrawdownUsd),
    sharpe: dailyVolatility > 0 ? round((dailyMean / dailyVolatility) * Math.sqrt(252)) : null,
    sortino: downsideDeviation > 0 ? round((dailyMean / downsideDeviation) * Math.sqrt(252)) : null
  };
}

function auditResearchTrades(trades = []) {
  const ids = new Set();
  const issues = [];
  let previousTimestamp = -Infinity;

  trades.forEach((trade, index) => {
    if (trade.id && ids.has(trade.id)) issues.push({ severity: 'error', code: 'duplicate-id', index, message: `Duplicate trade ID: ${trade.id}` });
    if (trade.id) ids.add(trade.id);
    if (!trade.date || !Number.isFinite(Date.parse(trade.date))) issues.push({ severity: 'error', code: 'invalid-date', index, message: 'Trade has no valid date.' });
    if (!Number.isFinite(Number(trade.realizedPnlUsd))) issues.push({ severity: 'error', code: 'invalid-pnl', index, message: 'Trade has no finite realized P&L.' });
    const timestamp = tradeTimestamp(trade);
    if (timestamp && timestamp < previousTimestamp) issues.push({ severity: 'warning', code: 'not-chronological', index, message: 'Trade records are not chronological.' });
    previousTimestamp = Math.max(previousTimestamp, timestamp);
  });

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return { ok: errors === 0, records: trades.length, errors, warnings: issues.length - errors, issues };
}

function auditCandles(candles = [], intervalMinutes = 1) {
  const issues = [];
  const timestamps = new Set();
  let previous = null;
  candles.forEach((candle, index) => {
    const timestamp = Date.parse(candle.timestamp || '');
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    if (!Number.isFinite(timestamp)) issues.push({ severity: 'error', code: 'invalid-timestamp', index });
    if ([open, high, low, close].some((value) => !Number.isFinite(value)) || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      issues.push({ severity: 'error', code: 'invalid-ohlc', index });
    }
    if (timestamps.has(timestamp)) issues.push({ severity: 'error', code: 'duplicate-candle', index });
    timestamps.add(timestamp);
    if (previous !== null && timestamp <= previous) issues.push({ severity: 'error', code: 'not-chronological', index });
    if (previous !== null && timestamp - previous > intervalMinutes * 60_000 * 1.5) issues.push({ severity: 'warning', code: 'time-gap', index });
    if (Number.isFinite(timestamp)) previous = timestamp;
  });
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return { ok: errors === 0, records: candles.length, errors, warnings: issues.length - errors, issues };
}

function groupPerformance(trades = [], field) {
  const groups = new Map();
  for (const trade of trades) {
    const key = trade[field] || 'Unlabeled';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()]
    .map(([label, records]) => ({ label, ...performanceMetrics(records) }))
    .sort((a, b) => b.trades - a.trades || b.netPnlUsd - a.netPnlUsd);
}

function reviewEvidence(trades = []) {
  const allJournal = performanceMetrics(trades);
  const excludedTrades = trades.filter(t => t.evidenceType !== 'forward-paper').length;
  trades = trades.filter(t => t.evidenceType === 'forward-paper');
  const total = performanceMetrics(trades);
  const { training, holdout } = splitChronologically(trades);
  const trainingMetrics = performanceMetrics(training);
  const holdoutMetrics = performanceMetrics(holdout);
  const redFlags = [];
  if (total.constantRisk.profitFactor === null) redFlags.push('Insufficient evidence: no finite R-based profit factor (zero observed losses).');
  if (!total.constantRisk.complete) redFlags.push('Initial risk or MAE is missing; evidence gates cannot pass.');

  if (total.trades < MIN_PROMOTION_TRADES) redFlags.push(`Only ${total.trades} of ${MIN_PROMOTION_TRADES} required closed trades.`);
  if (total.tradingDays < MIN_PROMOTION_DAYS) redFlags.push(`Only ${total.tradingDays} of ${MIN_PROMOTION_DAYS} required trading days.`);
  if (holdoutMetrics.trades < MIN_HOLDOUT_TRADES) redFlags.push(`Holdout contains ${holdoutMetrics.trades} of ${MIN_HOLDOUT_TRADES} required trades.`);
  if (holdoutMetrics.trades && holdoutMetrics.constantRisk.expectancyR <= 0) redFlags.push('Chronological trailing sample expectancy is not positive.');
  if (trainingMetrics.constantRisk.expectancyR > 0 && holdoutMetrics.trades && holdoutMetrics.constantRisk.expectancyR < trainingMetrics.constantRisk.expectancyR * 0.5) redFlags.push('Holdout expectancy fell more than 50% from training.');
  if (total.constantRisk.maxDrawdownR > 3) redFlags.push('Maximum drawdown exceeds the 3R constant-risk research limit.');

  const enoughEvidence = total.trades >= MIN_PROMOTION_TRADES && total.tradingDays >= MIN_PROMOTION_DAYS && holdoutMetrics.trades >= MIN_HOLDOUT_TRADES;
  const profitableEvidence = trainingMetrics.constantRisk.expectancyR > 0 && holdoutMetrics.constantRisk.expectancyR > 0 && total.constantRisk.expectancyR > 0 && (total.constantRisk.complete && total.constantRisk.profitFactor !== null && total.constantRisk.profitFactor >= 1.2);
  const riskContained = total.constantRisk.complete && total.constantRisk.maxDrawdownR <= 3;
  let verdict = 'COLLECT DATA';
  if (enoughEvidence && profitableEvidence && riskContained) verdict = 'PAPER CANDIDATE';
  else if (enoughEvidence && (holdoutMetrics.constantRisk.expectancyR <= 0 || total.constantRisk.expectancyR <= 0)) verdict = 'REJECT';
  else if (enoughEvidence) verdict = 'REVISE';

  return {
    verdict,
    execution: 'paper-only',
    evidenceType: 'forward-paper',
    excludedTrades,
    allJournal,
    validation: { method: 'rolling-chronological-70-30', sealed: false, livePromotionAllowed: false, note: 'Descriptive trailing sample recalculated as trades arrive. No untouched or locked holdout is established.' },
    total,
    training: trainingMetrics,
    holdout: holdoutMetrics,
    redFlags,
    gates: {
      closedTrades: total.trades >= MIN_PROMOTION_TRADES,
      tradingDays: total.tradingDays >= MIN_PROMOTION_DAYS,
      chronologicalSample: holdoutMetrics.trades >= MIN_HOLDOUT_TRADES,
      positiveHoldout: holdoutMetrics.constantRisk.expectancyR > 0,
      completeRiskEvidence: total.constantRisk.complete,
      profitFactor: total.constantRisk.profitFactor !== null && total.constantRisk.profitFactor >= 1.2,
      drawdown: riskContained
    }
  };
}

function reviewBacktestEvidence(trades = [], { enforceAccountDrawdown = true } = {}) {
  const total = performanceMetrics(trades);
  const { training, holdout } = splitChronologically(trades);
  const trainingMetrics = performanceMetrics(training);
  const holdoutMetrics = performanceMetrics(holdout);
  const redFlags = [];
  if (total.constantRisk.profitFactor === null) redFlags.push('Insufficient evidence: no finite R-based profit factor (zero observed losses).');
  if (!total.constantRisk.complete) redFlags.push('Initial risk or MAE is missing; evidence gates cannot pass.');
  if (total.trades < MIN_PROMOTION_TRADES) redFlags.push(`Only ${total.trades} of ${MIN_PROMOTION_TRADES} required simulated trades.`);
  if (holdoutMetrics.trades < MIN_HOLDOUT_TRADES) redFlags.push(`Holdout contains ${holdoutMetrics.trades} of ${MIN_HOLDOUT_TRADES} required simulated trades.`);
  if (holdoutMetrics.trades && holdoutMetrics.constantRisk.expectancyR <= 0) redFlags.push('Historical holdout expectancy is not positive.');
  if (trainingMetrics.constantRisk.expectancyR > 0 && holdoutMetrics.trades && holdoutMetrics.constantRisk.expectancyR < trainingMetrics.constantRisk.expectancyR * 0.5) redFlags.push('Historical holdout expectancy fell more than 50% from training.');
  if (total.constantRisk.maxDrawdownR > 10) redFlags.push('Historical MAE-inclusive drawdown exceeds the 10R evidence limit.');

  const enoughTrades = total.trades >= MIN_PROMOTION_TRADES && holdoutMetrics.trades >= MIN_HOLDOUT_TRADES;
  const profitable = trainingMetrics.constantRisk.expectancyR > 0 && holdoutMetrics.constantRisk.expectancyR > 0 && total.constantRisk.expectancyR > 0 && (total.constantRisk.complete && total.constantRisk.profitFactor !== null && total.constantRisk.profitFactor >= 1.2);
  let recommendation = 'MORE HISTORY NEEDED';
  if (enoughTrades && profitable && (total.constantRisk.complete && total.constantRisk.maxDrawdownR <= 10)) recommendation = 'ADVANCE TO FORWARD TEST';
  else if (enoughTrades && (holdoutMetrics.constantRisk.expectancyR <= 0 || total.constantRisk.expectancyR <= 0)) recommendation = 'REJECT CURRENT RULES';
  else if (enoughTrades) recommendation = 'REVISE AND RETEST';

  return {
    recommendation,
    evidenceType: 'historical-simulated',
    validation: { method: 'rolling-chronological-70-30', sealed: false, livePromotionAllowed: false, note: 'Historical trailing sample, not sealed validation. Forward testing is required.' },
    total,
    training: trainingMetrics,
    holdout: holdoutMetrics,
    redFlags,
    gates: {
      simulatedTrades: total.trades >= MIN_PROMOTION_TRADES,
      chronologicalSample: holdoutMetrics.trades >= MIN_HOLDOUT_TRADES,
      positiveHoldout: holdoutMetrics.constantRisk.expectancyR > 0,
      completeRiskEvidence: total.constantRisk.complete,
      profitFactor: total.constantRisk.profitFactor !== null && total.constantRisk.profitFactor >= 1.2,
      constantRiskDrawdown: total.constantRisk.complete && total.constantRisk.maxDrawdownR <= 10,
      ...(enforceAccountDrawdown ? { drawdown: total.constantRisk.complete && total.constantRisk.maxDrawdownR <= 10 } : {})
    }
  };
}

function strategyReport(strategy) {
  const trades = collectClosedTrades(strategy);
  return {
    slug: strategy.slug,
    name: strategy.name,
    family: strategy.strategyFamilyName,
    source: strategy.research?.source || null,
    review: reviewEvidence(trades),
    quality: auditResearchTrades(trades),
    postmortem: {
      byExitReason: groupPerformance(trades, 'exitReason').slice(0, 5),
      bySession: groupPerformance(trades, 'session').slice(0, 5),
      bySide: groupPerformance(trades, 'side').slice(0, 5)
    }
  };
}

function buildResearchLab(snapshot = {}) {
  const strategies = Array.isArray(snapshot.strategies) ? snapshot.strategies : [];
  const reports = strategies.map(strategyReport);
  const registry = STRATEGIES.map((definition) => {
    const report = reports.find((item) => item.slug === definition.slug);
    return {
      slug: definition.slug,
      name: definition.name,
      family: definition.strategyFamilyName,
      hypothesisStage: definition.researchStage,
      verdict: report?.review.verdict || 'COLLECT DATA',
      trades: report?.review.total.trades || 0,
      reason: report?.review.redFlags[0] || 'All research gates currently pass.'
    };
  });

  return {
    generatedAt: snapshot.generatedAt || new Date().toISOString(),
    source: snapshot.source || 'unknown',
    execution: 'paper-only advisory layer',
    reports,
    registry,
    summary: {
      strategies: reports.length,
      allJournalTrades: reports.reduce((sum, item) => sum + item.review.allJournal.trades, 0),
      closedTrades: reports.reduce((sum, item) => sum + item.review.total.trades, 0),
      paperCandidates: reports.filter((item) => item.review.verdict === 'PAPER CANDIDATE').length,
      rejected: reports.filter((item) => item.review.verdict === 'REJECT').length,
      qualityErrors: reports.reduce((sum, item) => sum + item.quality.errors, 0)
    }
  };
}

module.exports = {
  auditCandles,
  auditResearchTrades,
  buildResearchLab,
  collectClosedTrades,
  performanceMetrics,
  reviewBacktestEvidence,
  reviewEvidence,
  splitChronologically
};
