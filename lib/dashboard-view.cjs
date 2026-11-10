// Presentation-only model. No execution, sizing, or strategy decisions.
function sessionDate(timestamp) {
  const date = new Date(timestamp || 0);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : '';
}
function dashboardView(strategies, date) {
  const positive = [], negative = [], flat = [], idle = [], active = [], unavailable = [];
  let realized = 0, partial = 0, unrealized = 0;
  for (const strategy of strategies) {
    if (!strategy.journal || ((strategy.activationTime || strategy.createdAt) && sessionDate(strategy.activationTime || strategy.createdAt) > date)) {
      unavailable.push(strategy);
      continue;
    }
    const recap = strategy.journal.dailyRecaps?.find(row => row.date === date);
    const daily = recap || (strategy.journal.daily?.date === date ? strategy.journal.daily : null);
    realized += Number(daily?.realizedPnlUsd || 0);
    partial += Number(daily?.activeRealizedPnlUsd || 0);
    unrealized += Number(daily?.activeUnrealizedPnlUsd || 0);
    const seen = new Set();
    for (const trade of recap?.tradesList || []) {
      const key = trade.id || `${trade.filledAt}:${trade.entry}:${trade.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = { ...trade, strategy, key: `${strategy.slug}:${key}` };
      const pnl = Number(trade.realizedPnlUsd);
      if (!Number.isFinite(pnl)) continue;
      (pnl > 0 ? positive : pnl < 0 ? negative : flat).push(row);
    }
    if (daily?.openTradeStatus) active.push({ strategy, daily });
    if (!Number(daily?.trades || 0) && !daily?.openTradeStatus) idle.push(strategy);
  }
  positive.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  negative.sort((a, b) => a.realizedPnlUsd - b.realizedPnlUsd);
  return { positive, negative, flat, idle, active, unavailable, realized, partial, unrealized };
}
function dashboardHistory(strategies) {
  const dates = [...new Set(strategies.flatMap(s => (s.journal?.dailyRecaps || []).map(r => r.date)))].sort();
  let cumulative = 0;
  return dates.map(date => {
    const realized = strategies.reduce((sum, s) => sum + Number(s.journal?.dailyRecaps?.find(r => r.date === date)?.realizedPnlUsd || 0), 0);
    cumulative += realized;
    return { date, realized, cumulative };
  });
}
module.exports = { dashboardView, dashboardHistory, sessionDate };

function lifetimeView(strategies) {
  const groups = { positive: [], negative: [], flat: [], idle: [], unavailable: [] };
  for (const s of strategies) {
    const j = s.journal;
    if (!j || !Number.isFinite(j.realizedPnlUsd) || !Number.isFinite(j.trades)) { groups.unavailable.push(s); continue; }
    const group = j.trades === 0 ? 'idle' : j.realizedPnlUsd > 0 ? 'positive' : j.realizedPnlUsd < 0 ? 'negative' : 'flat';
    groups[group].push(s);
  }
  groups.positive.sort((a,b) => b.journal.realizedPnlUsd - a.journal.realizedPnlUsd);
  groups.negative.sort((a,b) => a.journal.realizedPnlUsd - b.journal.realizedPnlUsd);
  return groups;
}
module.exports.lifetimeView = lifetimeView;
