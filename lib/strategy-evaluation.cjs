function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function evaluateStrategyJournal(state = {}) {
  const trades = Array.isArray(state.trades) ? state.trades : [];
  const closedTrades = trades.filter((trade) => Number.isFinite(Number(trade.realizedPnlUsd)));
  const wins = closedTrades.filter((trade) => Number(trade.realizedPnlUsd) > 0);
  const losses = closedTrades.filter((trade) => Number(trade.realizedPnlUsd) < 0);
  const grossProfitUsd = wins.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0);
  const grossLossUsd = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd), 0));
  const tradingDays = new Set(closedTrades.map((trade) => trade.date).filter(Boolean)).size;
  const averageR = closedTrades.length
    ? closedTrades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / closedTrades.length
    : 0;
  const expectancyUsd = closedTrades.length
    ? (grossProfitUsd - grossLossUsd) / closedTrades.length
    : 0;
  const profitFactor = grossLossUsd > 0
    ? grossProfitUsd / grossLossUsd
    : grossProfitUsd > 0 ? null : 0;

  let runningPnl = 0;
  let peakPnl = 0;
  let maxDrawdownUsd = 0;
  for (const trade of closedTrades) {
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakPnl - (runningPnl - Math.abs(Number(trade.maeUsd || 0))));
    runningPnl += Number(trade.realizedPnlUsd || 0);
    peakPnl = Math.max(peakPnl, runningPnl);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakPnl - runningPnl);
  }

  const constantRisk = require('./constant-risk-metrics.cjs').metrics(closedTrades);
  const forward = closedTrades.filter(t => t.evidenceType === 'forward-paper');
  const forwardRisk = require('./constant-risk-metrics.cjs').metrics(forward);
  const forwardDays = new Set(forward.map(t => t.date).filter(Boolean)).size;
  const gates = {
    completeRiskEvidence: forwardRisk.complete,
    sampleSize: forward.length >= 50,
    tradingDays: forwardDays >= 20,
    profitFactor: forwardRisk.profitFactor !== null && forwardRisk.profitFactor >= 1.2,
    positiveExpectancy: forwardRisk.expectancyR > 0,
    positiveAverageR: forwardRisk.expectancyR > 0,
    drawdownContained: forwardRisk.complete && forwardRisk.maxDrawdownR <= 3
  };
  const passedGates = Object.values(gates).filter(Boolean).length;
  const status = forward.length < 20
    ? 'Warming up'
    : forward.length < 50
      ? 'Collecting evidence'
      : passedGates === Object.keys(gates).length
        ? 'Paper candidate'
        : 'Needs review';
  const boardGroup = closedTrades.length >= 20 && profitFactor !== null && profitFactor < 1
    ? 'watchlist'
    : 'focus';

  return {
    status,
    boardGroup,
    includedInFocusTotals: boardGroup === 'focus',
    execution: 'paper-only',
    trades: closedTrades.length,
    tradingDays,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length ? round((wins.length / closedTrades.length) * 100) : 0,
    profitFactor: profitFactor === null ? null : round(profitFactor),
    expectancyUsd: round(expectancyUsd),
    averageR: round(averageR),
    maxDrawdownUsd: round(maxDrawdownUsd),
    constantRisk,
    forwardEvidence: { evidenceType: 'forward-paper', trades: forward.length, tradingDays: forwardDays, excludedTrades: closedTrades.length - forward.length, constantRisk: forwardRisk },
    livePromotionAllowed: false,
    gates,
    passedGates,
    totalGates: Object.keys(gates).length,
    note: 'Account totals include all recorded outcomes. Candidate gates use only explicitly labelled forward-paper trades; no automatic live promotion.'
  };
}

module.exports = { evaluateStrategyJournal };
