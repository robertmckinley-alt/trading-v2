'use client';

import Link from 'next/link';
import DailyTradingDashboard from './daily-trading-dashboard';
import { useCallback, useEffect, useMemo, useState } from 'react';

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric'
});

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatStamp(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timestampFormatter.format(date);
}

function formatShortDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : shortDateFormatter.format(date);
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function formatAge(value, nowMs) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs) || nowMs <= 0) return 'unknown age';
  const seconds = Math.max(0, Math.round((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadTradeCsv(strategies) {
  const trades = collectTrades(strategies);
  if (!trades.length) return;

  const columns = [
    ['Date', (trade) => trade.date],
    ['Strategy', (trade) => trade.strategyName],
    ['Symbol', (trade) => trade.symbol],
    ['Side', (trade) => trade.side],
    ['Session', (trade) => trade.session],
    ['Entry', (trade) => trade.entry],
    ['Stop', (trade) => trade.stop],
    ['Exit', (trade) => trade.finalExitPrice],
    ['Realized PnL', (trade) => Number(trade.realizedPnlUsd || 0).toFixed(2)],
    ['R Multiple', (trade) => Number(trade.rMultiple || 0).toFixed(2)],
    ['Exit Reason', (trade) => trade.exitReason],
    ['Filled At', (trade) => trade.filledAt],
    ['Targets Hit', (trade) => trade.targetsHit],
    ['Thesis', (trade) => trade.thesis]
  ];
  const csv = [
    columns.map(([heading]) => csvCell(heading)).join(','),
    ...trades.map((trade) => columns.map(([, read]) => csvCell(read(trade))).join(','))
  ].join('\n');
  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `doctortrades-history-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(blobUrl);
}

function buildPortfolioTotals(strategies) {
  return strategies.reduce(
    (totals, strategy) => {
      const journal = strategy.journal || {};
      totals.bankrollUsd += Number(strategy.bankrollUsd || 0);
      totals.balanceUsd += Number(journal.balanceUsd ?? strategy.bankrollUsd ?? 0);
      totals.realizedPnlUsd += Number(journal.realizedPnlUsd || 0);
      totals.trades += Number(journal.trades || 0);
      totals.wins += Number(journal.wins || 0);
      totals.losses += Number(journal.losses || 0);
      if (strategy.mode === 'live-watcher') {
        totals.automatedStrategies += 1;
        if (strategy.watcher?.isRunning) totals.runningWatchers += 1;
      }
      if (strategy.mode === 'paper-route') totals.manualRoutes += 1;
      return totals;
    },
    {
      bankrollUsd: 0,
      balanceUsd: 0,
      realizedPnlUsd: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      automatedStrategies: 0,
      runningWatchers: 0,
      manualRoutes: 0
    }
  );
}

function buildDailyTotals(strategies) {
  return strategies.reduce(
    (totals, strategy) => {
      const daily = strategy.journal?.daily || {};
      totals.realizedPnlUsd += Number(daily.realizedPnlUsd || 0);
      totals.activeRealizedPnlUsd += Number(daily.activeRealizedPnlUsd || 0);
      totals.activeUnrealizedPnlUsd += Number(daily.activeUnrealizedPnlUsd || 0);
      totals.activePnlUsd += Number(daily.activePnlUsd || 0);
      totals.trades += Number(daily.trades || 0);
      totals.wins += Number(daily.wins || 0);
      totals.losses += Number(daily.losses || 0);
      if (!totals.date && daily.date) totals.date = daily.date;
      if (daily.openTradeStatus === 'open') totals.openPositions += 1;
      if (daily.openTradeStatus === 'not-filled') totals.pendingOrders += 1;
      return totals;
    },
    {
      date: null,
      realizedPnlUsd: 0,
      activeRealizedPnlUsd: 0,
      activeUnrealizedPnlUsd: 0,
      activePnlUsd: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      openPositions: 0,
      pendingOrders: 0
    }
  );
}

function buildRecapDates(strategies) {
  return [...new Set(strategies.flatMap((strategy) => (
    Array.isArray(strategy.journal?.dailyRecaps)
      ? strategy.journal.dailyRecaps.map((recap) => recap.date)
      : []
  )).filter(Boolean))].sort().reverse();
}

function findStrategyRecap(strategy, date) {
  return Array.isArray(strategy.journal?.dailyRecaps)
    ? strategy.journal.dailyRecaps.find((recap) => recap.date === date) || null
    : null;
}

function buildRecapForDate(strategies, date) {
  return strategies.reduce(
    (recap, strategy) => {
      const strategyRecap = findStrategyRecap(strategy, date);
      if (!strategyRecap) {
        recap.strategyRows.push({
          slug: strategy.slug,
          name: strategy.paperAccountLabel,
          strategyName: strategy.name,
          activePnlUsd: 0,
          realizedPnlUsd: 0,
          trades: 0,
          wins: 0,
          losses: 0,
          openTradeStatus: null,
          tradesList: []
        });
        return recap;
      }

      recap.trades += Number(strategyRecap.trades || 0);
      recap.wins += Number(strategyRecap.wins || 0);
      recap.losses += Number(strategyRecap.losses || 0);
      recap.realizedPnlUsd += Number(strategyRecap.realizedPnlUsd || 0);
      recap.activePnlUsd += Number(strategyRecap.activePnlUsd || 0);
      recap.activeUnrealizedPnlUsd += Number(strategyRecap.activeUnrealizedPnlUsd || 0);
      recap.avgRTotal += Number(strategyRecap.avgR || 0) * Number(strategyRecap.trades || 0);
      recap.openTrades += strategyRecap.openTradeStatus ? 1 : 0;
      recap.tradesList.push(...(strategyRecap.tradesList || []).map((trade) => ({
        ...trade,
        strategyName: strategy.name,
        account: strategy.paperAccountLabel
      })));
      recap.strategyRows.push({
        slug: strategy.slug,
        name: strategy.paperAccountLabel,
        strategyName: strategy.name,
        activePnlUsd: Number(strategyRecap.activePnlUsd || 0),
        realizedPnlUsd: Number(strategyRecap.realizedPnlUsd || 0),
        trades: Number(strategyRecap.trades || 0),
        wins: Number(strategyRecap.wins || 0),
        losses: Number(strategyRecap.losses || 0),
        openTradeStatus: strategyRecap.openTradeStatus || null,
        tradesList: strategyRecap.tradesList || []
      });
      return recap;
    },
    {
      date,
      trades: 0,
      wins: 0,
      losses: 0,
      realizedPnlUsd: 0,
      activePnlUsd: 0,
      activeUnrealizedPnlUsd: 0,
      avgRTotal: 0,
      openTrades: 0,
      strategyRows: [],
      tradesList: []
    }
  );
}

function isWatchlistStrategy(strategy) {
  const evaluation = strategy?.research?.evaluation;
  if (evaluation?.boardGroup) return evaluation.boardGroup === 'watchlist';
  const profitFactor = Number(evaluation?.profitFactor);
  return Number(evaluation?.trades || 0) >= 20 && Number.isFinite(profitFactor) && profitFactor < 1;
}

function buildDailySeries(strategies) {
  let cumulativePnlUsd = 0;
  return buildRecapDates(strategies)
    .slice()
    .sort()
    .map((date) => {
      const recap = buildRecapForDate(strategies, date);
      cumulativePnlUsd += recap.realizedPnlUsd;
      return {
        ...recap,
        cumulativePnlUsd: Math.round(cumulativePnlUsd * 100) / 100
      };
    });
}

function collectTrades(strategies) {
  const trades = [];
  const seen = new Set();

  for (const strategy of strategies) {
    for (const recap of strategy.journal?.dailyRecaps || []) {
      for (const trade of recap.tradesList || []) {
        const key = `${strategy.slug}:${trade.id || `${recap.date}:${trade.filledAt}:${trade.entry}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        trades.push({ ...trade, strategySlug: strategy.slug, strategyName: strategy.name, date: recap.date });
      }
    }
  }

  return trades.sort((a, b) => String(a.filledAt || a.date).localeCompare(String(b.filledAt || b.date)));
}

function buildBreakdown(trades, labelForTrade) {
  const groups = new Map();
  for (const trade of trades) {
    const label = labelForTrade(trade) || 'Unspecified';
    const group = groups.get(label) || { label, trades: 0, wins: 0, pnlUsd: 0, rTotal: 0 };
    group.trades += 1;
    group.wins += Number(trade.realizedPnlUsd || 0) > 0 ? 1 : 0;
    group.pnlUsd += Number(trade.realizedPnlUsd || 0);
    group.rTotal += Number(trade.rMultiple || 0);
    groups.set(label, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    winRate: group.trades ? (group.wins / group.trades) * 100 : 0,
    avgR: group.trades ? group.rTotal / group.trades : 0,
    expectancyUsd: group.trades ? group.pnlUsd / group.trades : 0
  })).sort((a, b) => b.expectancyUsd - a.expectancyUsd || b.trades - a.trades);
}

function weekdayForTrade(trade) {
  const date = new Date(`${trade.date}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(date);
}

function buildStreaks(trades) {
  let currentType = null;
  let currentCount = 0;
  let maxWins = 0;
  let maxLosses = 0;

  for (const trade of trades) {
    const pnl = Number(trade.realizedPnlUsd || 0);
    const type = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat';
    if (type === currentType) currentCount += 1;
    else {
      currentType = type;
      currentCount = 1;
    }
    if (type === 'win') maxWins = Math.max(maxWins, currentCount);
    if (type === 'loss') maxLosses = Math.max(maxLosses, currentCount);
  }

  return { currentType, currentCount: trades.length ? currentCount : 0, maxWins, maxLosses };
}

function buildPerformanceAnalytics(strategies, dailySeries) {
  const trades = collectTrades(strategies);
  const wins = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) > 0);
  const losses = trades.filter((trade) => Number(trade.realizedPnlUsd || 0) < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0));
  const totalPnl = grossProfit - grossLoss;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgR = trades.length
    ? trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / trades.length
    : 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const day of dailySeries) {
    peak = Math.max(peak, day.cumulativePnlUsd);
    maxDrawdown = Math.max(maxDrawdown, peak - day.cumulativePnlUsd);
  }

  return {
    expectancyUsd: trades.length ? totalPnl / trades.length : 0,
    avgR,
    maxDrawdown,
    avgWin,
    avgLoss,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : null,
    recoveryFactor: maxDrawdown > 0 ? totalPnl / maxDrawdown : totalPnl > 0 ? Infinity : null,
    streaks: buildStreaks(trades),
    byStrategy: buildBreakdown(trades, (trade) => trade.strategyName || trade.strategySlug),
    bySession: buildBreakdown(trades, (trade) => trade.session),
    byWeekday: buildBreakdown(trades, weekdayForTrade),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    bestDay: dailySeries.length
      ? dailySeries.reduce((best, day) => day.realizedPnlUsd > best.realizedPnlUsd ? day : best, dailySeries[0])
      : null,
    worstDay: dailySeries.length
      ? dailySeries.reduce((worst, day) => day.realizedPnlUsd < worst.realizedPnlUsd ? day : worst, dailySeries[0])
      : null
  };
}

function BreakdownTable({ title, rows }) {
  return (
    <div className="breakdown-card">
      <h4>{title}</h4>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Trades</th>
                <th scope="col">Win rate</th>
                <th scope="col">Avg R</th>
                <th scope="col">PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.trades}</td>
                  <td>{formatPercent(row.winRate)}</td>
                  <td>{row.avgR.toFixed(2)}R</td>
                  <td className={row.pnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(row.pnlUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="empty-copy">No closed trades yet.</p>}
    </div>
  );
}

function PerformanceChart({ dailySeries }) {
  const chartData = dailySeries.slice(-30);
  if (!chartData.length) {
    return (
      <div className="chart-empty">
        <strong>No performance history yet</strong>
        <span>Daily realized PnL and the cumulative curve will appear after the first closed trade.</span>
      </div>
    );
  }

  const width = 760;
  const height = 250;
  const left = 44;
  const right = 16;
  const top = 20;
  const bottom = 42;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maxAbsoluteDaily = Math.max(1, ...chartData.map((day) => Math.abs(day.realizedPnlUsd)));
  const cumulativeValues = chartData.map((day) => day.cumulativePnlUsd);
  const cumulativeMin = Math.min(0, ...cumulativeValues);
  const cumulativeMax = Math.max(0, ...cumulativeValues);
  const cumulativeRange = Math.max(1, cumulativeMax - cumulativeMin);
  const step = innerWidth / chartData.length;
  const zeroY = top + (innerHeight / 2);
  const linePoints = chartData.map((day, index) => {
    const x = left + (step * index) + (step / 2);
    const y = top + ((cumulativeMax - day.cumulativePnlUsd) / cumulativeRange) * innerHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div className="performance-chart-wrap">
      <svg
        className="performance-chart"
        role="img"
        aria-label="Daily realized profit and loss bars with cumulative profit and loss line"
        viewBox={`0 0 ${width} ${height}`}
      >
        <line className="chart-zero" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
        {chartData.map((day, index) => {
          const magnitude = (Math.abs(day.realizedPnlUsd) / maxAbsoluteDaily) * ((innerHeight / 2) - 8);
          const x = left + (step * index) + Math.max(2, step * 0.14);
          const barWidth = Math.max(3, step * 0.72);
          const y = day.realizedPnlUsd >= 0 ? zeroY - magnitude : zeroY;
          return (
            <rect
              className={day.realizedPnlUsd >= 0 ? 'chart-bar chart-bar-positive' : 'chart-bar chart-bar-negative'}
              height={Math.max(1, magnitude)}
              key={day.date}
              rx="2"
              width={barWidth}
              x={x}
              y={y}
            >
              <title>{`${day.date}: ${formatUsd(day.realizedPnlUsd)}`}</title>
            </rect>
          );
        })}
        <polyline className="chart-line" fill="none" points={linePoints} />
        {chartData.map((day, index) => {
          const [x, y] = linePoints.split(' ')[index].split(',');
          return (
            <circle className="chart-point" cx={x} cy={y} key={`point-${day.date}`} r="3">
              <title>{`Cumulative through ${day.date}: ${formatUsd(day.cumulativePnlUsd)}`}</title>
            </circle>
          );
        })}
        <text className="chart-axis-label" x="4" y={zeroY - 7}>daily</text>
        <text className="chart-axis-label" x={left} y={height - 10}>{formatShortDate(chartData[0].date)}</text>
        {chartData.length > 2 ? (
          <text className="chart-axis-label" textAnchor="middle" x={left + (innerWidth / 2)} y={height - 10}>
            {formatShortDate(chartData[Math.floor(chartData.length / 2)].date)}
          </text>
        ) : null}
        <text className="chart-axis-label" textAnchor="end" x={width - right} y={height - 10}>
          {formatShortDate(chartData.at(-1).date)}
        </text>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span><i className="legend-bar" />Daily PnL</span>
        <span><i className="legend-line" />Cumulative PnL</span>
      </div>
    </div>
  );
}

function PerformancePanel({ strategies, dailySeries }) {
  const analytics = buildPerformanceAnalytics(strategies, dailySeries);
  const profitFactor = analytics.profitFactor === null
    ? '—'
    : Number.isFinite(analytics.profitFactor)
      ? analytics.profitFactor.toFixed(2)
      : '∞';
  const payoffRatio = analytics.payoffRatio === null
    ? '—'
    : Number.isFinite(analytics.payoffRatio)
      ? analytics.payoffRatio.toFixed(2)
      : '∞';
  const recoveryFactor = analytics.recoveryFactor === null
    ? '—'
    : Number.isFinite(analytics.recoveryFactor)
      ? analytics.recoveryFactor.toFixed(2)
      : '∞';
  const streakLabel = analytics.streaks.currentCount
    ? countLabel(
        analytics.streaks.currentCount,
        analytics.streaks.currentType,
        analytics.streaks.currentType === 'loss' ? 'losses' : `${analytics.streaks.currentType}s`
      )
    : '—';

  return (
    <section className="performance-panel" aria-labelledby="performance-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Performance</span>
          <h3 id="performance-title">Daily PnL and equity momentum</h3>
        </div>
        <p>Up to 30 trading days · bars show closed PnL</p>
      </div>
      <div className="performance-layout">
        <PerformanceChart dailySeries={dailySeries} />
        <dl className="analytics-list">
          <div>
            <dt>Profit factor</dt>
            <dd>{profitFactor}</dd>
          </div>
          <div>
            <dt>Expectancy / trade</dt>
            <dd>{formatUsd(analytics.expectancyUsd)}</dd>
          </div>
          <div>
            <dt>Average R</dt>
            <dd>{analytics.avgR.toFixed(2)}R</dd>
          </div>
          <div>
            <dt>Max drawdown</dt>
            <dd>{formatUsd(analytics.maxDrawdown)}</dd>
          </div>
          <div>
            <dt>Best day</dt>
            <dd>{analytics.bestDay ? `${formatUsd(analytics.bestDay.realizedPnlUsd)} · ${formatShortDate(analytics.bestDay.date)}` : '—'}</dd>
          </div>
          <div>
            <dt>Worst day</dt>
            <dd>{analytics.worstDay ? `${formatUsd(analytics.worstDay.realizedPnlUsd)} · ${formatShortDate(analytics.worstDay.date)}` : '—'}</dd>
          </div>
          <div>
            <dt>Payoff ratio</dt>
            <dd>{payoffRatio}</dd>
          </div>
          <div>
            <dt>Recovery factor</dt>
            <dd>{recoveryFactor}</dd>
          </div>
          <div>
            <dt>Current streak</dt>
            <dd>{streakLabel}</dd>
          </div>
          <div>
            <dt>Longest W / L</dt>
            <dd>{analytics.streaks.maxWins} / {analytics.streaks.maxLosses}</dd>
          </div>
        </dl>
      </div>
      <div className="analytics-breakdowns" aria-label="Performance breakdowns">
        <BreakdownTable title="By strategy" rows={analytics.byStrategy} />
        <BreakdownTable title="By session" rows={analytics.bySession} />
        <BreakdownTable title="By weekday" rows={analytics.byWeekday} />
      </div>
    </section>
  );
}

function DailyLedger({ dailySeries, activeDate, onDateChange }) {
  const rows = dailySeries.slice().reverse().slice(0, 14);
  return (
    <section className="daily-ledger" aria-labelledby="daily-ledger-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Trade history</span>
          <h3 id="daily-ledger-title">Trades by day</h3>
        </div>
        <p>Select a day to open its full trade detail.</p>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Trades</th>
                <th scope="col">W–L</th>
                <th scope="col">Win rate</th>
                <th scope="col">Avg R</th>
                <th scope="col">Realized PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((day) => {
                const winRate = day.trades ? (day.wins / day.trades) * 100 : 0;
                const avgR = day.trades ? day.avgRTotal / day.trades : 0;
                return (
                  <tr className={day.date === activeDate ? 'is-selected' : ''} key={day.date}>
                    <th scope="row">
                      <button type="button" onClick={() => onDateChange(day.date)}>{day.date}</button>
                    </th>
                    <td>{day.trades}</td>
                    <td>{day.wins}–{day.losses}</td>
                    <td>{formatPercent(winRate)}</td>
                    <td>{avgR.toFixed(2)}R</td>
                    <td className={day.realizedPnlUsd >= 0 ? 'number-positive' : 'number-negative'}>
                      {formatUsd(day.realizedPnlUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-copy">No closed trading days yet.</p>
      )}
    </section>
  );
}

function PerformanceCalendar({ dailySeries, activeDate, onDateChange }) {
  if (!dailySeries.length) return null;

  const byDate = new Map(dailySeries.map((day) => [day.date, day]));
  const latestDate = new Date(`${dailySeries.at(-1).date}T12:00:00Z`);
  const latestDay = latestDate.getUTCDay();
  const calendarEnd = new Date(latestDate);
  calendarEnd.setUTCDate(calendarEnd.getUTCDate() + (6 - latestDay));
  const calendarStart = new Date(calendarEnd);
  calendarStart.setUTCDate(calendarStart.getUTCDate() - 41);
  const dates = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const maxAbsolutePnl = Math.max(1, ...dailySeries.map((day) => Math.abs(day.realizedPnlUsd)));

  return (
    <section className="performance-calendar" aria-labelledby="performance-calendar-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Calendar view</span>
          <h3 id="performance-calendar-title">Six-week PnL heatmap</h3>
        </div>
        <p>Choose a recorded day to open its trades.</p>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-grid">
        {dates.map((date) => {
          const day = byDate.get(date);
          const pnl = Number(day?.realizedPnlUsd || 0);
          const tone = !day ? 'empty' : pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'flat';
          const strength = day ? Math.abs(pnl) / maxAbsolutePnl : 0;
          const intensity = strength >= 0.66 ? 'high' : strength >= 0.33 ? 'medium' : 'low';
          return (
            <button
              aria-label={day ? `${date}, ${formatUsd(pnl)}, ${countLabel(day.trades, 'trade')}` : `${date}, no data`}
              className={`calendar-day calendar-day-${tone} calendar-day-${intensity}${date === activeDate ? ' calendar-day-active' : ''}`}
              disabled={!day}
              key={date}
              onClick={() => day && onDateChange(date)}
              type="button"
            >
              <span>{Number(date.slice(-2))}</span>
              <strong>{day ? (pnl === 0 ? '$0' : `${pnl > 0 ? '+' : '-'}$${Math.round(Math.abs(pnl))}`) : '—'}</strong>
            </button>
          );
        })}
      </div>
      <div className="calendar-legend" aria-hidden="true">
        <span><i className="calendar-key calendar-key-negative" />Loss</span>
        <span><i className="calendar-key calendar-key-flat" />Flat</span>
        <span><i className="calendar-key calendar-key-positive" />Profit</span>
      </div>
    </section>
  );
}

function outcomeTone(strategy) {
  if (strategy.mode === 'paper-route') return 'neutral';
  if ((strategy.watcher?.isHealthy ?? strategy.watcher?.isRunning) && !strategy.live?.latestError) return 'good';
  if (strategy.live?.latestError) return 'warn';
  if (strategy.watcher?.hasLiveEvidence || strategy.watcher?.staleStatusHint) return 'warn';
  return 'neutral';
}

function DailyTracker({ strategies, selectedDate, onDateChange }) {
  const daily = buildDailyTotals(strategies);
  const recapDates = buildRecapDates(strategies);
  const activeDate = selectedDate || recapDates[0] || daily.date || new Date().toISOString().slice(0, 10);
  const chronologicalDates = recapDates.slice().sort();
  const activeIndex = chronologicalDates.indexOf(activeDate);
  const previousDate = activeIndex > 0 ? chronologicalDates[activeIndex - 1] : null;
  const nextDate = activeIndex >= 0 && activeIndex < chronologicalDates.length - 1
    ? chronologicalDates[activeIndex + 1]
    : null;
  const selectedRecap = buildRecapForDate(strategies, activeDate);
  const selectedWinRate = selectedRecap.trades > 0 ? (selectedRecap.wins / selectedRecap.trades) * 100 : 0;
  const selectedAvgR = selectedRecap.trades > 0 ? selectedRecap.avgRTotal / selectedRecap.trades : 0;
  const hasDailyActivity = daily.trades > 0 || daily.openTrades > 0 || daily.activePnlUsd !== 0;
  const hasSelectedActivity = selectedRecap.trades > 0 || selectedRecap.openTrades > 0 || selectedRecap.activePnlUsd !== 0;

  return (
    <div className="daily-tracker" aria-label="Daily active PnL tracker">
      <div className="daily-tracker-head">
        <div>
          <span>Daily tracker</span>
          <strong>{daily.date || 'Current session'}</strong>
        </div>
        <p>{hasDailyActivity ? `${daily.openTrades} open / ${daily.trades} closed today` : 'No trades recorded for the current trading date yet'}</p>
      </div>

      <div className="daily-tracker-grid">
        <div className="daily-tracker-metric daily-tracker-primary">
          <span>Active PnL</span>
          <strong className={daily.activePnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(daily.activePnlUsd)}</strong>
          <p>Realized plus open-position mark</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Today realized</span>
          <strong className={daily.realizedPnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(daily.realizedPnlUsd)}</strong>
          <p>{countLabel(daily.wins, 'win')} / {countLabel(daily.losses, 'loss', 'losses')}</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Open unrealized</span>
          <strong>{formatUsd(daily.activeUnrealizedPnlUsd)}</strong>
          <p>{daily.openTrades} active position{daily.openTrades === 1 ? '' : 's'}</p>
        </div>
        <div className="daily-tracker-metric">
          <span>Today trades</span>
          <strong>{daily.trades}</strong>
          <p>Closed journal entries</p>
        </div>
      </div>

      <div className="daily-strategy-list">
        {strategies.map((strategy) => {
          const item = strategy.journal?.daily || {};
          return (
            <div className="daily-strategy-row" key={strategy.slug}>
              <span>{strategy.paperAccountLabel}</span>
              <strong>{formatUsd(item.activePnlUsd || 0)}</strong>
              <p>{countLabel(item.trades || 0, 'trade')} / {item.openTradeStatus || 'no open trade'}</p>
            </div>
          );
        })}
      </div>

      <div className="daily-recap">
        <div className="daily-recap-head">
          <div>
            <span>Selected session</span>
            <strong>{activeDate}</strong>
          </div>
          <div className="date-search-controls">
            <button disabled={!previousDate} onClick={() => previousDate && onDateChange(previousDate)} type="button">
              Previous
            </button>
            <label>
              <span>Search trading date</span>
              <input
                max={chronologicalDates.at(-1)}
                min={chronologicalDates[0]}
                type="date"
                value={activeDate}
                onChange={(event) => onDateChange(event.target.value)}
              />
            </label>
            <button disabled={!nextDate} onClick={() => nextDate && onDateChange(nextDate)} type="button">
              Next
            </button>
          </div>
        </div>

        {recapDates.length ? (
          <div className="recap-date-strip" aria-label="Recent recap dates">
            {recapDates.slice(0, 8).map((date) => (
              <button
                className={date === activeDate ? 'recap-date-button recap-date-button-active' : 'recap-date-button'}
                key={date}
                type="button"
                onClick={() => onDateChange(date)}
              >
                {date}
              </button>
            ))}
          </div>
        ) : null}

        <div className="daily-tracker-grid">
          <div className="daily-tracker-metric daily-tracker-primary">
            <span>Recap PnL</span>
            <strong className={selectedRecap.activePnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(selectedRecap.activePnlUsd)}</strong>
            <p>{hasSelectedActivity ? `${selectedRecap.openTrades} open / ${selectedRecap.trades} closed` : 'No trades found for this date'}</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Closed PnL</span>
            <strong className={selectedRecap.realizedPnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(selectedRecap.realizedPnlUsd)}</strong>
            <p>{countLabel(selectedRecap.wins, 'win')} / {countLabel(selectedRecap.losses, 'loss', 'losses')}</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Win rate</span>
            <strong>{formatPercent(selectedWinRate)}</strong>
            <p>{selectedRecap.trades} closed trade{selectedRecap.trades === 1 ? '' : 's'}</p>
          </div>
          <div className="daily-tracker-metric">
            <span>Avg R</span>
            <strong>{selectedAvgR.toFixed(2)}R</strong>
            <p>{formatUsd(selectedRecap.activeUnrealizedPnlUsd)} open mark</p>
          </div>
        </div>

        <div className="daily-strategy-list">
          {selectedRecap.strategyRows.map((row) => (
            <div className="daily-strategy-row" key={row.slug}>
              <span>{row.name}</span>
              <strong>{formatUsd(row.activePnlUsd)}</strong>
              <p>{countLabel(row.trades, 'trade')} / {row.openTradeStatus || 'no open trade'}</p>
            </div>
          ))}
        </div>

        <div className="recap-trade-list">
          {selectedRecap.tradesList.length ? selectedRecap.tradesList.map((trade) => (
            <article className="recap-trade-row" key={trade.id}>
              <div className="recap-trade-main">
                <div>
                  <span>{trade.account}</span>
                  <strong>{trade.symbol} {String(trade.side || '').toUpperCase()}</strong>
                </div>
                <p>{trade.thesis || `${trade.strategyName} trade`}</p>
              </div>

              <div className="recap-trade-facts">
                <div>
                  <span>Entry</span>
                  <strong>{trade.entry ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Stop</span>
                  <strong>{trade.stop ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Exit</span>
                  <strong>{trade.finalExitPrice ?? 'n/a'}</strong>
                </div>
                <div>
                  <span>Result</span>
                  <strong>{formatUsd(trade.realizedPnlUsd)} / {Number(trade.rMultiple || 0).toFixed(2)}R</strong>
                </div>
              </div>

              <div className="recap-trade-tags">
                <span>{trade.exitReason || 'closed'}</span>
                {trade.entryModel ? <span>{trade.entryModel}</span> : null}
                {trade.gapType ? <span>{trade.gapType}</span> : null}
                {trade.liquidityLabel ? <span>{trade.liquidityLabel}</span> : null}
              </div>

              <div className="recap-trade-foot">
                <span>Filled {trade.filledAt ? formatStamp(trade.filledAt) : 'n/a'}</span>
                <span>Targets hit: {trade.targetsHit?.length ? trade.targetsHit.join(', ') : 'none'}</span>
                <span>Draw: {trade.drawOnLiquidity?.length ? trade.drawOnLiquidity.join(', ') : 'n/a'}</span>
              </div>
            </article>
          )) : (
            <p className="empty-copy">No journaled trades for {activeDate}.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PortfolioTotals({ strategies, allStrategies }) {
  const totals = buildPortfolioTotals(strategies);
  const fullTotals = buildPortfolioTotals(allStrategies);
  const winRate = totals.trades > 0 ? (totals.wins / totals.trades) * 100 : 0;
  const returnPercent = totals.bankrollUsd > 0 ? (totals.realizedPnlUsd / totals.bankrollUsd) * 100 : 0;
  const watchlistCount = allStrategies.length - strategies.length;

  return (
    <div className="portfolio-totals" aria-label="Promising and collecting strategy totals">
      <div className="portfolio-total-card portfolio-total-card-primary">
        <span>Focus-group balance</span>
        <strong>{formatUsd(totals.balanceUsd)}</strong>
        <p className={totals.realizedPnlUsd >= 0 ? 'number-positive' : 'number-negative'}>{formatUsd(totals.realizedPnlUsd)} realized · watchlist excluded</p>
      </div>
      <div className="portfolio-total-card">
        <span>Focus-group trades</span>
        <strong>{totals.trades}</strong>
        <p>{countLabel(totals.wins, 'win')} / {countLabel(totals.losses, 'loss', 'losses')}</p>
      </div>
      <div className="portfolio-total-card">
        <span>Focus-group win rate</span>
        <strong>{formatPercent(winRate)}</strong>
        <p>{formatPercent(returnPercent)} realized return</p>
      </div>
      <div className="portfolio-total-card">
        <span>Full-system balance</span>
        <strong>{formatUsd(fullTotals.balanceUsd)}</strong>
        <p>{formatUsd(fullTotals.realizedPnlUsd)} realized · {watchlistCount} watchlist account{watchlistCount === 1 ? '' : 's'} included</p>
      </div>
    </div>
  );
}

function StrategyOutcome({ strategy, isBridgeFallback }) {
  if (strategy.mode === 'paper-route') {
    return (
      <div className="strategy-outcome">
        <p className="outcome-label">Current outcome</p>
        <strong>Not live automated yet</strong>
        <span>
          {strategy.setupSummary?.outcome || 'Separate manual paper route; no VPS watcher attached.'}
        </span>
      </div>
    );
  }

  const candle = strategy.live?.lastCandle;
  const primaryOutcome = strategy.live?.latestReason
    || (candle ? 'Watching live candle stream' : null)
    || (isBridgeFallback ? 'Waiting on fresh bridge snapshot' : null)
    || strategy.watcher?.statusLabel
    || 'Unknown';
  const secondaryOutcome = candle
    ? `Last close ${candle.close} at ${formatStamp(candle.timestamp)}`
    : isBridgeFallback
      ? 'Remote bridge timed out; showing local fallback only'
      : 'No live candle yet';

  return (
    <div className="strategy-outcome">
      <p className="outcome-label">Current outcome</p>
      <strong>{primaryOutcome}</strong>
      <span>{secondaryOutcome}</span>
    </div>
  );
}

function PortfolioRiskGuard({ risk }) {
  if (!risk) return null;
  const atCap = ['cap-reached', 'family-cap-reached'].includes(risk.status);
  return (
    <div className="portfolio-risk-stack" aria-label="Shared portfolio and strategy-family risk guards">
      <div className={`portfolio-risk-strip ${atCap ? 'portfolio-risk-strip-warn' : ''}`}>
        <div>
          <span>Shared open-risk guard</span>
          <strong>{formatUsd(risk.reservedRiskUsd)} of {formatUsd(risk.capUsd)} reserved</strong>
        </div>
        <p>{formatUsd(risk.availableRiskUsd)} available · {Number(risk.utilizationPercent || 0).toFixed(1)}% utilized · paper only</p>
      </div>
      <div className="family-risk-list" aria-label="Correlated strategy family limits">
        {(risk.families || []).map((family) => (
          <div className={family.status === 'cap-reached' ? 'family-risk-item family-risk-item-warn' : 'family-risk-item'} key={family.family}>
            <span>{family.name}</span>
            <strong>{formatUsd(family.reservedRiskUsd)} / {formatUsd(family.capUsd)}</strong>
          </div>
        ))}
      </div>
      {(risk.reservations || []).length ? (
        <div className="risk-reservation-list" aria-label="Current paper risk reservations">
          {(risk.reservations || []).map((reservation) => (
            <div key={reservation.strategySlug}>
              <span>{reservation.strategyName} · {reservation.paperAccountLabel}</span>
              <strong>{formatUsd(reservation.riskUsd)} reserved · {formatStamp(reservation.reservedAt)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ResearchScorecard({ research }) {
  const evaluation = research?.evaluation;
  if (!evaluation) return null;
  const gateLabels = {
    sampleSize: '50 trades',
    tradingDays: '20 days',
    profitFactor: 'PF ≥ 1.20',
    positiveExpectancy: '+ expectancy',
    positiveAverageR: '+ average R',
    drawdownContained: 'DD ≤ $1,500'
  };
  const profitFactor = evaluation.profitFactor === null
    ? evaluation.wins > 0 && evaluation.losses === 0 ? '∞' : '—'
    : Number(evaluation.profitFactor).toFixed(2);

  return (
    <div className="research-scorecard" aria-label={`${research.stage || 'Research'} evaluation`}>
      <div className="research-scorecard-head">
        <div>
          <span>Evidence status</span>
          <strong>{evaluation.status}</strong>
        </div>
        <span>{evaluation.passedGates}/{evaluation.totalGates} gates</span>
      </div>
      <dl className="research-metrics">
        <div><dt>Sample</dt><dd>{evaluation.trades} trades / {evaluation.tradingDays} days</dd></div>
        <div><dt>Profit factor</dt><dd>{profitFactor}</dd></div>
        <div><dt>Expectancy</dt><dd>{formatUsd(evaluation.expectancyUsd)}</dd></div>
        <div><dt>Max drawdown</dt><dd>{formatUsd(evaluation.maxDrawdownUsd)}</dd></div>
      </dl>
      <div className="research-gates" aria-label="Research qualification gates">
        {Object.entries(evaluation.gates).map(([key, passed]) => (
          <span className={passed ? 'research-gate research-gate-pass' : 'research-gate'} key={key}>
            {passed ? '✓' : '—'} {gateLabels[key] || key}
          </span>
        ))}
      </div>
      <p>{research.evidenceLabel}</p>
      {research.source?.url ? (
        <a href={research.source.url} rel="noreferrer" target="_blank">
          {research.source.label} · {research.source.license}
        </a>
      ) : <span className="research-source">{research.source?.label || 'Internal baseline'}</span>}
    </div>
  );
}

function StrategyCard({ strategy, isBridgeFallback }) {
  const tone = outcomeTone(strategy);
  const journal = strategy.journal || {};
  const riskGuard = strategy.live?.riskGuard;
  const amdContext = strategy.live?.researchContext?.amdContext;

  return (
    <article className={`live-card live-card-${tone}`}>
      <div className="live-card-head">
        <div>
          <p className="eyebrow">{strategy.research?.stage || 'Strategy'}</p>
          <h3>{strategy.name}</h3>
          <p className="live-inline-meta">{strategy.paperAccountLabel}</p>
        </div>
        <a className="ghost-link" href={strategy.route}>
          Open route
        </a>
      </div>

      <div className="live-pill-row">
        <span>{formatUsd(strategy.bankrollUsd)} bankroll</span>
        <span>{strategy.maxDrawdownPercent}% max DD</span>
        <span>{strategy.ticker}</span>
        {strategy.strategyFamilyName ? <span>{strategy.strategyFamilyName}</span> : null}
        <span>Paper only</span>
      </div>


      <div className="live-mini-grid">
        <div>
          <span>Mode</span>
          <strong>{strategy.mode === 'live-watcher' ? 'Live watcher' : 'Manual only'}</strong>
        </div>
        <div>
          <span>Provider</span>
          <strong>{strategy.provider}</strong>
        </div>
        <div>
          <span>Trades</span>
          <strong>{journal.trades ?? 0}</strong>
        </div>
        <div>
          <span>Realized</span>
          <strong>{formatUsd(journal.realizedPnlUsd ?? 0)}</strong>
        </div>
      </div>

      <ResearchScorecard research={strategy.research} />

      {strategy.mode === 'live-watcher' ? (
        <div className="adaptive-bots" aria-label="Fixed-risk guard">
          <div className="adaptive-bots-head">
            <strong>Risk guard</strong>
            <span>Fixed risk per trade · fixed entry rules</span>
          </div>
          <div className="adaptive-bots-grid">
            <div>
              <span>Risk per trade</span>
              <strong>{riskGuard ? formatUsd(riskGuard.configuredRiskUsd || 0) : 'Standby'}</strong>
              <small>{riskGuard ? (riskGuard.allowed ? 'Guards clear' : 'New trades paused') : 'No live decision yet'}</small>
            </div>
            <div>
              <span>Today realized</span>
              <strong>{riskGuard ? formatUsd(riskGuard.dailyPnlUsd || 0) : '—'}</strong>
              <small>{riskGuard ? `Daily loss limit ${formatUsd(riskGuard.dailyLossLimitUsd || 0)}` : 'Waiting for live bars'}</small>
            </div>
            <div>
              <span>Account floor</span>
              <strong>{riskGuard ? formatUsd(riskGuard.accountFloorUsd || 0) : '—'}</strong>
              <small>{riskGuard?.reason || 'No live decision yet'}</small>
            </div>
          </div>
          {amdContext ? (
            <div className="adaptive-bots-note">
              <strong>Asia / London context: {String(amdContext.classification || 'unknown').replaceAll('-', ' ')}</strong>
              <span>{amdContext.reason} This is logged for comparison and does not change the entry rule yet.</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {strategy.mode === 'live-watcher' ? (
        <div className="live-status-strip">
          <span className={`live-dot ${(strategy.watcher?.isHealthy ?? strategy.watcher?.isRunning) ? 'live-dot-good' : 'live-dot-warn'}`} />
          <strong>{strategy.watcher?.statusLabel || 'Unknown'}</strong>
          <span>PID {strategy.watcher?.pid || 'n/a'}</span>
        </div>
      ) : (
        <div className="live-status-strip">
          <span className="live-dot live-dot-warn" />
          <strong>No live watcher</strong>
          <span>Manual journal only</span>
        </div>
      )}

      <StrategyOutcome strategy={strategy} isBridgeFallback={isBridgeFallback} />
      <ScanEvidence strategy={strategy} />

      {strategy.mode === 'live-watcher' && strategy.live?.latestError ? (
        <p className="live-inline-error">Latest feed issue: {strategy.live.latestError.message}</p>
      ) : null}
      {strategy.mode === 'live-watcher' && strategy.watcher?.staleStatusHint ? (
        <p className="live-inline-warning">{strategy.watcher.staleStatusHint}</p>
      ) : null}
      {strategy.mode === 'live-watcher' && !strategy.live?.latestError && strategy.live?.activationTime ? (
        <p className="live-inline-meta">Activation gate: {strategy.live.activationTime}</p>
      ) : null}
      {strategy.journalScope ? (
        <p className="live-inline-meta">{strategy.journalScope}</p>
      ) : null}
      {strategy.mode === 'paper-route' && strategy.setupSummary?.targets?.length ? (
        <p className="live-inline-meta">
          Sample model: {strategy.setupSummary?.entryModel || 'manual'} / {strategy.setupSummary?.gapType || 'n/a'}.
          Targets: {strategy.setupSummary.targets.join(', ')}
        </p>
      ) : null}
    </article>
  );
}

function ScanEvidence({ strategy, compact = false }) {
  const scan = strategy.live?.scanAudit;
  if (!scan) return null;
  return (
    <span className="live-inline-meta" aria-label={`${strategy.name} scan evidence`}>
      <span>Scanning every {Math.round(scan.pollIntervalMs / 1000)}s · {scan.candleChecks} candles checked · {scan.observedSessions} eligible sessions</span>
      <br />
      <span>{scan.setupChecks} eligible checks · {scan.signals} setups · {scan.orders} paper orders</span>
      {!compact ? <><br /><span>{scan.unfilledOrders} unfilled orders · {scan.riskRejections} order blocks · {scan.feedErrors} feed/run errors</span>
        <br /><span>Tracking since {formatStamp(scan.startedAt)} · {scan.rulesVersion === 'baseline' ? 'Baseline rules' : 'Unvalidated paper collection v2'}</span>
        {scan.lastSetupReason ? <><br /><span>Last eligible check: {scan.lastSetupReason} ({formatStamp(scan.lastSetupCheckAt)})</span></> : null}</> : null}
    </span>
  );
}

export default function LiveStrategyBoard({ initialData, compact = false }) {
  const [data, setData] = useState(initialData);
  const [nowMs, setNowMs] = useState(() => Date.parse(initialData?.generatedAt || '') || 0);
  const [selectedDate, setSelectedDate] = useState('');
  const [refreshState, setRefreshState] = useState({ busy: false, error: '' });

  const refreshData = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setRefreshState({ busy: true, error: '' });

    try {
      const response = await fetch('/api/live-status', { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload?.strategies) {
        throw new Error(payload?.error || 'Status service did not return strategy data');
      }
      setData(payload);
      setNowMs(Date.now());
      setRefreshState({ busy: false, error: '' });
    } catch (error) {
      setRefreshState({
        busy: false,
        error: error.name === 'AbortError' ? 'Status refresh timed out. The last good snapshot is still shown.' : error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const response = await fetch('/api/live-status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        const payload = await response.json();
        if (!cancelled && response.ok && payload?.strategies) {
          setData(payload);
          setNowMs(Date.now());
          setRefreshState({ busy: false, error: '' });
        } else if (!cancelled) {
          setRefreshState({ busy: false, error: 'Status refresh failed. Showing the last good snapshot.' });
        }
      } catch {
        if (!cancelled) setRefreshState({ busy: false, error: 'Status refresh failed. Showing the last good snapshot.' });
      }
    }

    const timer = setInterval(refresh, 30000);
    const clock = setInterval(() => setNowMs(Date.now()), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);

  const strategies = useMemo(() => Array.isArray(data?.strategies) ? data.strategies : [], [data]);
  const watchlistStrategies = useMemo(() => strategies.filter(isWatchlistStrategy), [strategies]);
  const focusStrategies = useMemo(() => strategies.filter((strategy) => !isWatchlistStrategy(strategy)), [strategies]);
  const isBridgeFallback = data?.source === 'remote-bridge-fallback';
  const dailySeries = useMemo(() => buildDailySeries(strategies), [strategies]);
  const activeDate = selectedDate || dailySeries.at(-1)?.date || buildDailyTotals(strategies).date || '';
  const runningWatchers = strategies.filter((strategy) => strategy.mode === 'live-watcher' && strategy.watcher?.isRunning === true).length;
  const healthyWatchers = strategies.filter((strategy) => strategy.mode === 'live-watcher' && strategy.watcher?.isHealthy === true).length;
  const watcherCount = strategies.filter((strategy) => strategy.mode === 'live-watcher').length;

  if (compact) {
    return <DailyTradingDashboard data={data} strategies={strategies} refreshData={refreshData} refreshState={refreshState} />;
  }

  return (
    <section className="live-board">
      <div className="live-board-head">
        <div>
          <p className="eyebrow">Portfolio overview</p>
          <h2>Daily trading control center</h2>
        </div>
        <div className="live-board-meta">
          <span className={runningWatchers === watcherCount && healthyWatchers === watcherCount && watcherCount ? 'source-status source-status-good' : 'source-status source-status-warn'}>
            {runningWatchers}/{watcherCount} processes · {healthyWatchers} healthy
          </span>
          <span>{isBridgeFallback ? 'Fallback snapshot' : data?.source === 'remote-bridge-cache' ? 'Last good VPS snapshot' : data?.source === 'remote-bridge' ? 'Live VPS bridge' : 'Local runtime'} · {formatStamp(data?.generatedAt)}</span>
          <button className="refresh-button" disabled={refreshState.busy} onClick={refreshData} type="button">
            {refreshState.busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {refreshState.error ? <p className="live-inline-warning" role="status">{refreshState.error}</p> : null}
      {data?.error ? (
        <p className="live-inline-warning">
          The live bridge is unavailable, so this board is showing the safest available fallback snapshot.
        </p>
      ) : null}

      <PortfolioTotals strategies={focusStrategies} allStrategies={strategies} />
      <PortfolioRiskGuard risk={data?.portfolioRisk} />
      <PerformancePanel strategies={strategies} dailySeries={dailySeries} />
      <div className="history-actions">
        <button
          className="secondary-button"
          disabled={!collectTrades(strategies).length}
          onClick={() => downloadTradeCsv(strategies)}
          type="button"
        >
          Export all trades (.csv)
        </button>
      </div>
      <PerformanceCalendar dailySeries={dailySeries} activeDate={activeDate} onDateChange={setSelectedDate} />
      <DailyLedger dailySeries={dailySeries} activeDate={activeDate} onDateChange={setSelectedDate} />
      <DailyTracker strategies={strategies} selectedDate={activeDate} onDateChange={setSelectedDate} />

      <div className="strategy-group">
        <div className="strategy-group-head">
          <div><span>Primary board</span><h3>Promising and collecting evidence</h3></div>
          <p>{focusStrategies.length} account{focusStrategies.length === 1 ? '' : 's'} · losing strategies move down only after 20 closed trades</p>
        </div>
        <div className="live-board-grid">
          {focusStrategies.map((strategy) => (
            <StrategyCard key={strategy.slug} strategy={strategy} isBridgeFallback={isBridgeFallback} />
          ))}
        </div>
      </div>

      {watchlistStrategies.length ? (
        <div className="strategy-group strategy-group-watchlist">
          <div className="strategy-group-head">
            <div><span>Still monitored</span><h3>Watchlist · profit factor below 1.00</h3></div>
            <p>Excluded from focus-group totals. Included in the full-system balance and ledger.</p>
          </div>
          <div className="live-board-grid">
            {watchlistStrategies.map((strategy) => (
              <StrategyCard key={strategy.slug} strategy={strategy} isBridgeFallback={isBridgeFallback} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
