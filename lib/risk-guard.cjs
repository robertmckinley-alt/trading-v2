// v2 fixed-risk admission guard. Replaces the retired adaptive-bots sizing with two hard rules:
// pause new entries at the configured daily loss limit, and at the account drawdown floor.
// Risk per trade is the configured amount; no multipliers.
const { zonedParts } = require('./ny-time.cjs');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function tradingDateFor(candle) {
  return zonedParts(candle?.timestamp || Date.now()).date;
}

function dailyPnl(state, tradingDate) {
  return (state.trades || [])
    .filter((trade) => trade.date === tradingDate)
    .reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
}

function evaluateRiskGuard(candles, config, state) {
  const lastCandle = candles[candles.length - 1];
  const tradingDate = tradingDateFor(lastCandle);
  const dailyPnlUsd = round(dailyPnl(state, tradingDate));
  const dailyLossLimitUsd = Math.max(0, Number(config.maxDailyLossUsd || 0));
  const atDailyLossLimit = dailyLossLimitUsd > 0 && dailyPnlUsd <= -dailyLossLimitUsd;
  const floorUsd = Number(config.startingBalanceUsd || 0) * (1 - (Number(config.maxAccountDrawdownPercent || 0) / 100));
  const atAccountFloor = Number(state.balanceUsd || 0) <= floorUsd;
  const allowed = !atDailyLossLimit && !atAccountFloor;
  const reasons = [];
  if (atDailyLossLimit) reasons.push('Daily loss limit reached. New trades are paused for this trading date.');
  if (atAccountFloor) reasons.push('Account drawdown floor reached. New trades are paused.');
  if (!reasons.length) reasons.push('Fixed-risk guards are clear.');
  return {
    version: 'fixed-risk-guard-v1',
    evaluatedAt: new Date().toISOString(),
    tradingDate,
    risk: {
      name: 'risk-guard',
      status: allowed ? 'clear' : 'paused',
      allowed,
      riskMultiplier: 1,
      configuredRiskUsd: round(config.maxRiskPerTradeUsd),
      adjustedRiskUsd: round(config.maxRiskPerTradeUsd),
      dailyPnlUsd,
      dailyLossLimitUsd: round(dailyLossLimitUsd),
      accountFloorUsd: round(floorUsd),
      reason: reasons.join(' ')
    }
  };
}

module.exports = { evaluateRiskGuard, dailyPnl, tradingDateFor };
