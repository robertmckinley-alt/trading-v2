#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local'), quiet: true });
const {
  createEmptyState,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  parseCsvFile,
  printPlan,
  printReplay,
  printReport,
  replayPlan,
  saveJson,
  toJournalTrade,
  buildTradePlan,
  validateSetup
} = require('./lib/trader-core.cjs');
const {
  buildPlanFromSignal,
  clearTerminalUnfilledPlan,
  detectSignalFromCandles,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
} = require('./lib/live-trader.cjs');
const { getTelegramConfig, sendTelegramAlert } = require('./lib/telegram-alerts.cjs');
const { evaluateRiskGuard } = require('./lib/risk-guard.cjs');
const { reservePortfolioRisk } = require('./lib/portfolio-risk.cjs');
const { requireStrategyDefinition, runtimeFilesForStrategy } = require('./lib/strategy-registry.cjs');

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');

function statePathForStrategy(strategySlug) {
  return runtimeFilesForStrategy(BASE, strategySlug).statePath;
}

function loadConfig() {
  return normalizeConfig(loadJson(CONFIG_PATH));
}

function loadState(config, statePath) {
  try {
    return loadLiveState(hydrateState(require('./lib/portfolio-risk.cjs').readAccountState(statePath) || createEmptyState(config), config));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return loadLiveState(createEmptyState(config));
  }
}

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  return { command, rest };
}

function requireFile(filePath, label) {
  if (!filePath) {
    throw new Error(`${label} is required`);
  }
}

function parseWatchOptions(rest) {
  const fileArgs = [];
  let intervalMs = null;
  let provider = null;
  let strategySlug = 'live-9am-sweep';

  for (const arg of rest) {
    if (arg.startsWith('--interval=')) {
      intervalMs = Number(arg.slice('--interval='.length));
      continue;
    }
    if (arg.startsWith('--provider=')) {
      provider = String(arg.slice('--provider='.length));
      continue;
    }
    if (arg.startsWith('--strategy=')) {
      strategySlug = String(arg.slice('--strategy='.length));
      continue;
    }
    fileArgs.push(arg);
  }

  if (intervalMs !== null && (!Number.isFinite(intervalMs) || intervalMs < 250)) {
    throw new Error('watch interval must be at least 250ms');
  }

  return {
    fileArgs,
    intervalMs: Math.round(intervalMs),
    provider,
    strategySlug
  };
}

function applyLiveProviderOverride(config, provider) {
  if (!provider) {
    return config;
  }
  return {
    ...config,
    live: {
      ...(config.live || {}),
      provider
    }
  };
}

function reportTelegramAlertStatus() {
  const telegram = getTelegramConfig();
  if (!telegram.enabled) {
    console.warn('Telegram alerts: disabled — TELEGRAM_BOT_TOKEN was not found in .env.local or the process environment.');
    return;
  }
  if (!telegram.validTokenFormat) {
    console.warn('Telegram alerts: disabled — TELEGRAM_BOT_TOKEN has an invalid format.');
    return;
  }
  if (!telegram.chatId) {
    console.warn('Telegram alerts: incomplete — add TELEGRAM_CHAT_ID (or TELEGRAM_CHANNEL_ID).');
    return;
  }
  console.log('Telegram trade alerts: configured (trade opened/closed only).');
}

async function sendWatcherAlert(state, event) {
  const eventType = String(event.type || 'watcher');
  if (!['trade-opened', 'trade-closed'].includes(eventType)) return;
  const dedupeKey = String(event.dedupeKey || event.status || eventType);
  if (state.live.alertKeys?.[eventType] === dedupeKey) return;

  try {
    const result = await sendTelegramAlert({
      ...event,
      at: new Date().toISOString()
    });
    if (!result.sent) {
      if (result.reason === 'not-configured') return;
      const messages = {
        'invalid-token': 'Telegram alerts are disabled because TELEGRAM_BOT_TOKEN has an invalid format.',
        'missing-chat-id': 'Telegram alerts require TELEGRAM_CHAT_ID (or TELEGRAM_CHANNEL_ID).'
      };
      const message = messages[result.reason] || 'Telegram alerts are not fully configured.';
      if (state.live.lastAlertError !== message) {
        console.error(`[${new Date().toISOString()}] ${message}`);
      }
      state.live.lastAlertError = message;
      return;
    }
    state.live.alertKeys = { ...(state.live.alertKeys || {}), [eventType]: dedupeKey };
    state.live.lastAlertAt = new Date().toISOString();
    state.live.lastAlertError = null;
  } catch {
    state.live.lastAlertError = 'Telegram alert delivery failed. Check the bot token, chat ID, and network access.';
    console.error(`[${new Date().toISOString()}] ${state.live.lastAlertError}`);
  }
}

function runWatch(setupPath, csvPath, config, state, intervalMs) {
  const resolvedSetupPath = path.resolve(setupPath);
  const resolvedCsvPath = path.resolve(csvPath);
  let lastSignature = null;

  const tick = () => {
    const rawSetup = loadJson(resolvedSetupPath);
    const setup = normalizeSetup(rawSetup, config);
    const validation = validateSetup(setup, config);
    if (!validation.valid) {
      throw new Error(`Setup validation failed:\n- ${validation.errors.join('\n- ')}`);
    }

    const plan = buildTradePlan(setup, config, state);
    const candles = parseCsvFile(resolvedCsvPath);
    const replayResult = replayPlan(plan, candles, config);
    const lastCandle = candles[candles.length - 1];
    const signature = JSON.stringify({
      entry: plan.setup.entry,
      stop: plan.setup.stop,
      target: replayResult.targetsHit[replayResult.targetsHit.length - 1] || null,
      status: replayResult.status,
      exitReason: replayResult.exitReason,
      finalExitPrice: replayResult.finalExitPrice,
      lastTimestamp: lastCandle ? lastCandle.timestamp : null
    });

    if (signature !== lastSignature) {
      lastSignature = signature;
      const now = new Date().toISOString();
      console.log(`[${now}] watch tick`);
      console.log(`Last candle: ${lastCandle ? `${lastCandle.timestamp} O:${lastCandle.open} H:${lastCandle.high} L:${lastCandle.low} C:${lastCandle.close}` : 'none'}`);
      console.log(printReplay(plan, replayResult));
      console.log('');
    }
  };

  console.log(`Watching ${resolvedCsvPath} every ${intervalMs}ms using setup ${resolvedSetupPath}`);
  tick();
  setInterval(() => {
    try {
      tick();
    } catch (error) {
      const now = new Date().toISOString();
      console.error(`[${now}] watch error: ${error.message}`);
    }
  }, intervalMs);
}

async function runLivePlan(config, state) {
  const { candles, metadata } = await fetchLiveCandles(config);
  const signal = detectSignalFromCandles(candles, config, state);
  if (!signal.found) {
    console.log(`Live scan: no trade yet`);
    console.log(`Reason: ${signal.reason}`);
    if (signal.sessionRanges) {
      console.log(`Asia H/L: ${signal.sessionRanges.asia.high} / ${signal.sessionRanges.asia.low}`);
      console.log(`London H/L: ${signal.sessionRanges.london.high} / ${signal.sessionRanges.london.low}`);
    }
    console.log(`Feed: ${metadata.provider} ${metadata.ticker}`);
    return;
  }

  const plan = buildPlanFromSignal(signal, config, state);
  console.log(`Feed: ${metadata.provider} ${metadata.ticker}`);
  console.log(formatSignalSummary(signal, plan));
  console.log('');
  console.log(printPlan(plan));
}

function persistClosedTrade(statePath, state, config, strategyDefinition, plan, lifecycle) {
  const trade = { ...toJournalTrade(plan, lifecycle), evidenceType: 'forward-paper', executionPolicyVersion: plan.setup.executionPolicyVersion || 'legacy' };
  state.trades.push(trade);
  state.realizedPnlUsd = Math.round((state.realizedPnlUsd + trade.realizedPnlUsd) * 100) / 100;
  state.startingBalanceUsd = config.startingBalanceUsd;
  state.balanceUsd = Math.round((config.startingBalanceUsd + state.realizedPnlUsd) * 100) / 100;
  state.lastUpdatedAt = new Date().toISOString();
  state.live.openSignalKey = null;
  state.live.openPlan = null;
  state.live.openTriggeredAt = null;
  return trade;
}

async function runWatchLive(config, state, strategyDefinition, intervalMs, statePath) {
  const observation = require('./lib/watcher-observation.cjs');
  observation.initialize(state, config);
  const liveConfig = normalizeStrategyConfig(config);
  let lastSignature = null;
  const actualIntervalMs = intervalMs || liveConfig.pollIntervalMs;
  let inFlight = false;

  const tick = async () => {
    const { candles, metadata } = await fetchLiveCandles(config);
    const lastCandle = candles[candles.length - 1];
    state.live.heartbeat = {
      at: new Date().toISOString(),
      ok: true,
      pollIntervalMs: actualIntervalMs,
      provider: metadata.provider,
      ticker: metadata.ticker,
      lastCandle: lastCandle || null,
      error: null
    };
    const riskDecision = evaluateRiskGuard(candles, config, state);
    const detectedSignal = observation.evaluateFreshCandles({ candles, config, state, detect: detectSignalFromCandles });
    state.live.riskGuard = riskDecision;
    saveLiveState(statePath, state);
    let summaryLines = [
      `Feed: ${metadata.provider} ${metadata.ticker}`,
      `Last candle: ${lastCandle ? `${lastCandle.timestamp} O:${lastCandle.open} H:${lastCandle.high} L:${lastCandle.low} C:${lastCandle.close}` : 'none'}`
    ];

    if (state.live.openPlan) {
      const liveCandles = state.live.openTriggeredAt
        ? candles.filter((candle) => new Date(candle.timestamp).getTime() >= new Date(state.live.openTriggeredAt).getTime())
        : candles;
      const lifecycle = trackTradeLifecycle(state.live.openPlan, liveCandles, config, { closeOpenAtEnd: false, now: Date.now() });
      state.live.openLifecycle = lifecycle;
      if (clearTerminalUnfilledPlan(state, lifecycle)) {
        observation.record(state.live.scanAudit, 'unfilledOrders', lastCandle.timestamp, lifecycle.exitReason);
        summaryLines.push(`No trade: Paper order ${lifecycle.exitReason}; shared risk reservation released`);
        saveLiveState(statePath, state);
        const signature = JSON.stringify({
          mode: 'terminal-unfilled-order',
          exitReason: lifecycle.exitReason,
          lastTimestamp: lastCandle ? lastCandle.timestamp : null
        });
        if (signature !== lastSignature) {
          lastSignature = signature;
          console.log(`[${new Date().toISOString()}] live tick`);
          console.log(summaryLines.join('\n'));
          console.log('');
        }
        return;
      }
      summaryLines.push(formatOpenTradeSummary(state.live.openPlan, lifecycle));
      if (lifecycle.filledAt) {
        await sendWatcherAlert(state, {
          type: 'trade-opened',
          status: 'opened',
          dedupeKey: state.live.openSignalKey || lifecycle.filledAt,
          strategy: config.strategySlug,
          symbol: state.live.openPlan.setup.symbol,
          side: state.live.openPlan.setup.side,
          entry: state.live.openPlan.setup.entry,
          stop: state.live.openPlan.setup.stop,
          message: 'Paper entry filled.'
        });
        saveLiveState(statePath, state);
      }
      if (lifecycle.status === 'closed') {
        const trade = persistClosedTrade(statePath, state, config, strategyDefinition, state.live.openPlan, lifecycle);
        await sendWatcherAlert(state, {
          type: 'trade-closed',
          status: 'closed',
          dedupeKey: trade.id,
          strategy: config.strategySlug,
          symbol: trade.symbol,
          side: trade.side,
          realizedPnlUsd: trade.realizedPnlUsd,
          rMultiple: trade.rMultiple,
          message: 'Paper trade closed and journaled.'
        });
        summaryLines.push(`Closed and journaled: ${trade.id} PnL ${trade.realizedPnlUsd}`);
        saveLiveState(statePath, state);
      }
      const signature = JSON.stringify({
        mode: 'open-position',
        status: lifecycle.status,
        filledAt: lifecycle.filledAt,
        targetsHit: lifecycle.targetsHit,
        remainingContracts: lifecycle.remainingContracts,
        exitReason: lifecycle.exitReason,
        markPrice: lifecycle.markPrice,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    const signal = detectedSignal;
    state.live.researchContext = signal.metadata || null;
    saveLiveState(statePath, state);
    if (!signal.found) {
      summaryLines.push(`No trade: ${signal.reason}`);
      const signature = JSON.stringify({
        mode: 'idle',
        reason: signal.reason,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    const key = signalKey(signal);
    if (state.live.signalHistory.includes(key)) {
      summaryLines.push(`Signal already consumed: ${key}`);
      const signature = JSON.stringify({
        mode: 'duplicate-signal',
        key,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }

    let plan;
    try {
      if (!riskDecision.risk.allowed) {
        throw new Error(`Risk guard: ${riskDecision.risk.reason}`);
      }
      const entryConfig = require('./lib/execution-policy.cjs').entryRiskConfig(config, riskDecision);
      plan = buildPlanFromSignal(signal, entryConfig, state);
      observation.bindForwardObservation(plan);
      plan.signalContext = { ...(plan.signalContext || {}), rulesVersion: state.live.scanAudit.rulesVersion,
        observedAt: plan.setup.observedAt };
      plan.riskGuard = riskDecision.risk;
      const portfolioDecision = reservePortfolioRisk({
        rootDir: BASE,
        config,
        strategySlug: config.strategySlug,
        proposedRiskUsd: plan.sizing.actualRiskUsd,
        commit: (decision) => {
          plan.portfolioRisk = {
            capUsd: decision.capUsd,
            reservedBeforeUsd: decision.reservedRiskUsd,
            projectedRiskUsd: decision.projectedRiskUsd
          };
          const nextLiveState = {
            ...state.live,
            portfolioRisk: decision,
            openSignalKey: key,
            openPlan: plan,
            openLifecycle: { status: 'not-filled' },
            consumedOrderDay: plan.setup.date,
            openTriggeredAt: signal.triggerTimestamp,
            signalHistory: [...state.live.signalHistory, key]
          };
          saveLiveState(statePath, { ...state, live: nextLiveState });
          state.live = nextLiveState;
          observation.record(state.live.scanAudit, 'orders', signal.triggerTimestamp);
          saveLiveState(statePath, state);
        }
      });
      if (!portfolioDecision.allowed) {
        state.live.portfolioRisk = portfolioDecision;
        saveLiveState(statePath, state);
        throw new Error(`Shared portfolio risk guard: ${portfolioDecision.reason}`);
      }
    } catch (error) {
      observation.record(state.live.scanAudit, 'riskRejections', lastCandle.timestamp, error.message);
      saveLiveState(statePath, state);
      summaryLines.push(`No trade: ${error.message}`);
      const signature = JSON.stringify({
        mode: 'rejected-signal',
        reason: error.message,
        lastTimestamp: lastCandle ? lastCandle.timestamp : null
      });
      if (signature !== lastSignature) {
        lastSignature = signature;
        console.log(`[${new Date().toISOString()}] live tick`);
        console.log(summaryLines.join('\n'));
        console.log('');
      }
      return;
    }
    summaryLines.push(formatSignalSummary(signal, plan));
    const signature = JSON.stringify({
      mode: 'new-signal',
      key,
      lastTimestamp: lastCandle ? lastCandle.timestamp : null
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      console.log(`[${new Date().toISOString()}] live tick`);
      console.log(summaryLines.join('\n'));
      console.log('');
    }
  };

  const poll = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      observation.expirePending(state);
      const marketClosed = error.code === 'MARKET_CLOSED';
      if (!marketClosed) state.live.scanAudit.feedErrors++;
      state.live.heartbeat = {
        ...(state.live.heartbeat || {}),
        at: new Date().toISOString(),
        ok: marketClosed,
        marketClosed,
        pollIntervalMs: actualIntervalMs,
        error: marketClosed ? null : error.message
      };
      try {
        saveLiveState(statePath, state);
      } catch {
        // Preserve the original feed error in the watcher log.
      }
      if (!marketClosed) throw error;
    } finally {
      inFlight = false;
    }
  };

  console.log(`Watching live market every ${actualIntervalMs}ms using provider ${liveConfig.provider}`);
  try {
    await poll();
  } catch (error) {
    const now = new Date().toISOString();
    console.error(`[${now}] live watch error: ${error.message}`);
  }
  setInterval(() => {
    poll().catch((error) => {
      const now = new Date().toISOString();
      console.error(`[${now}] live watch error: ${error.message}`);
    });
  }, actualIntervalMs);
  await new Promise(() => {});
}

async function main() {
  const { command, rest } = parseArgs(process.argv);
  const { provider, strategySlug } = parseWatchOptions(rest);
  const strategyDefinition = requireStrategyDefinition(strategySlug, BASE);
  const statePath = statePathForStrategy(strategySlug);
  const detectorStrategySlug = strategyDefinition.detectorStrategySlug || strategyDefinition.parentStrategySlug || strategySlug;
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    ...(detectorStrategySlug === 'nq-fresh-level-retest' ? {...require('./lib/fresh-level-retest.cjs').ACCOUNT,live:{...baseConfig.live,lookbackBars:6000}} : {}),
    ...(detectorStrategySlug === 'nq-vwap-stretch-reversion' ? require('./lib/vwap-stretch.cjs').ACCOUNT : {}),
    strategySlug,
    detectorStrategySlug,
    strategyFamily: strategyDefinition.strategyFamily,
    accountType: 'baseline'
  };
  if (command === 'watch-live') {
    const release = require('./lib/watcher-process.cjs').acquireWatcherLock(BASE, strategySlug);
    process.once('exit', release);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
  }
  const state = loadState(config, statePath);

  if (!command) {
    throw new Error('Usage: node paper-trader.js <plan|replay|journal|report|live-plan|watch-live> [files]');
  }

  if (command === 'report') {
    console.log(printReport(state, config));
    return;
  }

  if (command === 'watch') {
    const { fileArgs, intervalMs } = parseWatchOptions(rest);
    const [setupPath, csvPath] = fileArgs;
    requireFile(setupPath, 'setup path');
    requireFile(csvPath, 'csv path');
    runWatch(setupPath, csvPath, config, state, intervalMs || 1000);
    return;
  }

  if (command === 'live-plan') {
    await runLivePlan({ ...applyLiveProviderOverride(config, provider), strategySlug }, state);
    return;
  }

  if (command === 'watch-live') {
    const { intervalMs } = parseWatchOptions(rest);
    reportTelegramAlertStatus();
    await runWatchLive({ ...applyLiveProviderOverride(config, provider), strategySlug }, state, strategyDefinition, intervalMs, statePath);
    return;
  }

  const [setupPath, csvPath] = rest;
  requireFile(setupPath, 'setup path');
  const rawSetup = loadJson(path.resolve(setupPath));
  const setup = normalizeSetup(rawSetup, config);
  const validation = validateSetup(setup, config);
  if (!validation.valid) {
    throw new Error(`Setup validation failed:\n- ${validation.errors.join('\n- ')}`);
  }

  const plan = buildTradePlan(setup, config, state);
  if (command === 'plan') {
    console.log(printPlan(plan));
    return;
  }

  requireFile(csvPath, 'csv path');
  const candles = parseCsvFile(path.resolve(csvPath));
  const replayResult = replayPlan(plan, candles, config);

  if (command === 'replay') {
    console.log(printReplay(plan, replayResult));
    return;
  }

  if (command === 'journal') {
    const trade = toJournalTrade(plan, replayResult);
    state.trades.push(trade);
    state.realizedPnlUsd = Math.round((state.realizedPnlUsd + trade.realizedPnlUsd) * 100) / 100;
    state.startingBalanceUsd = config.startingBalanceUsd;
    state.balanceUsd = Math.round((config.startingBalanceUsd + state.realizedPnlUsd) * 100) / 100;
    state.lastUpdatedAt = new Date().toISOString();
    saveJson(statePath, state);
    console.log(printReplay(plan, replayResult));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
