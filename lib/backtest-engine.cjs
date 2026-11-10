const { auditCandles, performanceMetrics, reviewBacktestEvidence } = require('./research-lab.cjs');
const { BACKTEST_STRATEGIES } = require('./strategy-registry.cjs');
const { createEmptyState, replayPlan, toJournalTrade } = require('./trader-core.cjs');
const { buildPlanFromSignal, detectSignalFromCandles } = require('./live-trader.cjs');


const TIME_ZONE = 'America/New_York';
const ZONED_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});

function zonedParts(value) {
  const parts = Object.fromEntries(ZONED_FORMATTER.formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: (Number(parts.hour) * 60) + Number(parts.minute) };
}

function groupTradingDays(candles) {
  const groups = new Map();
  candles.forEach((candle, index) => {
    const parts = zonedParts(candle.timestamp);
    if (!groups.has(parts.date)) groups.set(parts.date, []);
    groups.get(parts.date).push({ candle, index, minute: parts.minute });
  });
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function checkpointsForDay(slug, records) {
  if (slug === 'nq-vwap-stretch-reversion') return records.filter(r => r.minute >= 584 && r.minute <= 957);
  const cashEnd = records.filter((record) => record.minute <= 960);
  if (!cashEnd.length) return [];
  const windows = {
    'live-9am-sweep': [540, 960],
    'live-9am-sweep-min-stop': [540, 960]
  };
  const window = windows[slug] || null;
  if (!window) return cashEnd;
  return cashEnd.filter((record) => record.minute >= window[0] && record.minute <= window[1]);
}

function instrumentForDay(records) {
  return records.find((record) => record.candle.instrumentId != null)?.candle.instrumentId ?? null;
}

function simulatedTrade(plan, replay, signal, slug, sequence, detectedAt) {
  return {
    ...toJournalTrade(plan, replay),
    id: `backtest-${slug}-${signal.setup.date}-${sequence}`,
    createdAt: signal.triggerTimestamp,
    signalAt: signal.triggerTimestamp,
    detectedAt,
    evidenceType: 'historical-simulated'
  };
}

function runStrategyBacktest(candles, rawConfig, definition, dependencies = {}) {
  if (definition.slug === 'nq-fresh-level-retest') return require('./fresh-level-backtest.cjs').run(candles, rawConfig, definition, dependencies);
  if (definition.slug === 'nq-vwap-stretch-reversion') return require('./vwap-backtest.cjs').run(candles, rawConfig, definition, dependencies);
  const detectSignal = dependencies.detectSignal || detectSignalFromCandles;
  const buildPlan = dependencies.buildPlan || buildPlanFromSignal;
  const replay = dependencies.replay || replayPlan;
  const days = dependencies.groupedDays || groupTradingDays(candles);
  const config = {
    ...rawConfig,
    ...(definition.slug === 'nq-vwap-stretch-reversion' ? require('./vwap-stretch.cjs').ACCOUNT : {}),
    strategySlug: definition.slug,
    strategyFamily: definition.strategyFamily,
    live: { ...(rawConfig.live || {}), maxTradesPerDay: 1 }
  };
  const state = createEmptyState(config);
  // An independent sizing state per signal removes accumulated account loss limits
  // from research. Whole-contract sizing, per-trade risk and execution costs remain.
  const researchConfig = { ...config, maxAccountDrawdownPercent: 100,
    startingBalanceUsd: Math.max(config.startingBalanceUsd, config.maxRiskPerTradeUsd) };
  const researchRejections = {};
  const researchUnfilledReasons = {};
  const accountRejections = {};
  const trades = [];
  const researchTrades = [];
  let researchRejected = 0;
  let researchUnfilled = 0;
  const filterChecks = {};
  let signals = 0;
  let notFilled = 0;
  let rejectedSignals = 0;
  let rolloverDaysSkipped = 0;
  let incompleteDaysSkipped = 0;
  let previousInstrument = null;

  for (const [dayIndex, [date, records]] of days.entries()) {
    const cashSession = require('./orb-session.cjs').session(date);
    if (!cashSession.open) continue;
    if (dayIndex % 10 === 0) dependencies.onProgress?.({
      phase: 'simulating', strategy: definition.slug, date,
      daysCompleted: dayIndex, daysTotal: days.length, trades: researchTrades.length, accountTrades: trades.length
    });
    if (!require('./session-quality.cjs').cashCoverage(date, records.map(r=>r.candle)).complete) { incompleteDaysSkipped++; continue; }
    const instrument = [...records].reverse().find(r=>r.candle.instrumentId != null)?.candle.instrumentId ?? null;
    const mixedInstruments = new Set(records.map(r=>r.candle.instrumentId).filter(x=>x!=null)).size > 1;
    if (mixedInstruments || (previousInstrument !== null && instrument !== null && instrument !== previousInstrument)) {
      rolloverDaysSkipped += 1;
      previousInstrument = instrument;
      continue;
    }
    if (instrument !== null) previousInstrument = instrument;

    let signal = null;
    let detectedAt = null;
    for (const checkpoint of checkpointsForDay(definition.slug, records, config)) {
      const contextStart = Math.max(0, checkpoint.index - (require('./execution-policy.cjs').lookbackBars(rawConfig) - 1));
      const context = candles.slice(contextStart, checkpoint.index + 1);
      const candidate = detectSignal(context, config, createEmptyState(config));
      if (candidate.found) {
        signal = candidate;
        detectedAt = checkpoint.candle.timestamp;
        break;
      }
    }
    if (!signal) continue;
    signals += 1;
    signal = { ...signal, setup: { ...signal.setup, detectedAt,
      signalAvailableAt: new Date(Date.parse(detectedAt) + 60_000).toISOString() } };
    const detectionTime = Date.parse(detectedAt);
    const future = records
      .filter((record) => record.minute < 960 && Date.parse(record.candle.timestamp) > detectionTime)
      .map((record) => record.candle);
    if (!future.length) {
      researchUnfilledReasons['No candles after signal'] = (researchUnfilledReasons['No candles after signal'] || 0) + 1;
      notFilled += 1;
      researchUnfilled += 1;
      continue;
    }

    // Keep a fixed-dollar-risk diagnostic independent of the account's accumulated losses.
    // The account curve below continues enforcing its actual drawdown floor.
    {
      try {
        const researchPlan = buildPlan(signal, researchConfig, createEmptyState(researchConfig));
        const researchReplay = replay(researchPlan, future, researchConfig, {});
        if (researchReplay.status === 'not-filled') {
          researchUnfilled += 1;
          const reason = researchReplay.exitReason || 'Unfilled order';
          researchUnfilledReasons[reason] = (researchUnfilledReasons[reason] || 0) + 1;
        } else researchTrades.push(simulatedTrade(researchPlan, researchReplay, signal, definition.slug, researchTrades.length + 1, detectedAt));
      } catch (error) {
        if (/drawdown guard|No trade: minimum 1-contract risk/.test(error.message)) {
          researchRejected += 1;
          const reason = /minimum 1-contract risk/.test(error.message) ? 'One contract exceeds per-trade risk budget' : 'Sizing guard';
          researchRejections[reason] = (researchRejections[reason] || 0) + 1;
        }
        else throw error;
      }
    }

    try {
      const plan = buildPlan(signal, config, state);
      const result = replay(plan, future, config);
      if (result.status === 'not-filled') {
        notFilled += 1;
        continue;
      }
      const trade = simulatedTrade(plan, result, signal, definition.slug, trades.length + 1, detectedAt);
      trades.push(trade);
      state.trades.push(trade);
      state.realizedPnlUsd += trade.realizedPnlUsd;
      state.balanceUsd = state.startingBalanceUsd + state.realizedPnlUsd;
    } catch (error) {
      if (/drawdown guard|No trade: minimum 1-contract risk/.test(error.message)) {
        rejectedSignals += 1;
        const reason = /drawdown guard/.test(error.message) ? 'Account drawdown guard' : 'One contract exceeds remaining risk budget';
        accountRejections[reason] = (accountRejections[reason] || 0) + 1;
        continue;
      }
      throw error;
    }
  }

  return {
    slug: definition.slug,
    name: definition.name,
    family: definition.strategyFamilyName,
    ...(definition.researchRules ? { researchRules: definition.researchRules } : {}),
    ...(definition.forwardPaperEligible === false ? { forwardPaperEligible: false, researchStage: definition.researchStage } : {}),
    evidenceType: 'historical-simulated',
    signals,
    notFilled,
    rejectedSignals,
    rolloverDaysSkipped,
    incompleteDaysSkipped,
    rejectionReasons: accountRejections,
    trades,
    metrics: performanceMetrics(trades),
    review: reviewBacktestEvidence(trades),
    research: {
      mode: 'fixed-risk',
      sizing: { riskCapUsd: config.maxRiskPerTradeUsd, accountLossLimit: false },
      description: 'Same dollar risk ceiling per signal; no accumulated account drawdown lock. This is not a deployable account curve.',
      trades: researchTrades, metrics: performanceMetrics(researchTrades),
      review: reviewBacktestEvidence(researchTrades, { enforceAccountDrawdown: false }),
      rejectionReasons: researchRejections, unfilledReasons: researchUnfilledReasons,
      signals, rejectedSignals: researchRejected, notFilled: researchUnfilled, filterChecks
    }
  };
}

function runAllBacktests(candles, config, options = {}) {
  const quality = auditCandles(candles);
  if (!quality.ok) throw new Error(`Historical candle audit failed with ${quality.errors} errors.`);
  const groupedDays = groupTradingDays(candles);
  const definitions = options.strategies || BACKTEST_STRATEGIES;
  const strategies = definitions.map((definition, index) => {
    const onProgress = (progress) => options.onProgress?.({
      ...progress, strategyIndex: index + 1, strategyTotal: definitions.length
    });
    const result = runStrategyBacktest(candles, config, definition, {
      ...(options.dependencies || {}), groupedDays, onProgress
    });
    onProgress({ phase: 'strategy-completed', strategy: definition.slug,
      daysCompleted: groupedDays.length, daysTotal: groupedDays.length,
      trades: result.trades.length, netPnlUsd: result.metrics.netPnlUsd });
    return result;
  });
  return {
    generatedAt: new Date().toISOString(),
    evidenceType: 'historical-simulated',
    researchVersion: 'all-strategy-fixed-risk-v1',
    methodology: 'Research evaluates the full history without an accumulated account loss cutoff using fixed-dollar sizing. Separate guarded account results are retained. Completed-candle signals; next-bar market execution with adverse slippage and stop gaps. Limit entries require one-tick trade-through and adverse entry costs; all orders expire within three minutes and flatten at the final cash-session minute. Retrospective research, not untouched forward evidence.',
    costs: { riskPerTradeUsd: config.maxRiskPerTradeUsd, slippageTicks: config.slippageTicks, commissionPerContractUsd: config.commissionPerContractUsd },
    candleQuality: quality,
    candles: candles.length,
    tradingDays: groupedDays.length,
    strategies
  };
}

module.exports = { checkpointsForDay, groupTradingDays, runAllBacktests, runStrategyBacktest };
