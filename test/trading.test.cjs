const {businessDate,completeCash}=require('../test-support/session-fixtures.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../lib/trader-core.cjs');
const {
  computeAmdContext,
  clearTerminalUnfilledPlan,
  detectSignalFromCandles,
  fetchLiveCandles,
  normalizeStrategyConfig,
  saveLiveState
} = require('../lib/live-trader.cjs');
const { parseLiveStatus, sanitizeRemoteSnapshot, summarizeJournal } = require('../lib/live-status.cjs');
const { formatTelegramAlert, getTelegramConfig, sendTelegramAlert } = require('../lib/telegram-alerts.cjs');
const { evaluateStrategyJournal } = require('../lib/strategy-evaluation.cjs');
const { getPortfolioRiskSnapshot, reservePortfolioRisk } = require('../lib/portfolio-risk.cjs');
const { BACKTEST_STRATEGIES, STRATEGIES, STRATEGY_RESEARCH_VARIANTS, getStrategyDefinitions, runtimeFilesForStrategy } = require('../lib/strategy-registry.cjs');
const {
  auditCandles,
  auditResearchTrades,
  buildResearchLab,
  performanceMetrics,
  reviewEvidence,
  reviewBacktestEvidence,
  splitChronologically
} = require('../lib/research-lab.cjs');
const { checkpointsForDay, runAllBacktests, runStrategyBacktest } = require('../lib/backtest-engine.cjs');
const { fetchDatabentoHistoricalCandles, historicalSinceYearWindow, historicalWindow, historicalYearWindow, parseDatabentoJson, splitHistoricalWindow } = require('../lib/historical-data.cjs');
const { getCachedBacktest, remoteBacktestResultUrls, remoteBacktestUrls } = require('../lib/backtest-service.cjs');
const { readBacktestResult, saveBacktestResult } = require('../lib/backtest-worker.cjs');

const root = path.join(__dirname, '..');

function researchTrades(count, pnlForIndex = (index) => index % 2 === 0 ? 100 : -50) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 0, index + 1, 15));
    return {
      id: `research-${index + 1}`,
      date: at.toISOString().slice(0, 10),
      createdAt: at.toISOString(),
      realizedPnlUsd: pnlForIndex(index),
      rMultiple: pnlForIndex(index) / 100, actualRiskUsd: 100, maeUsd: -50,
      side: index % 2 ? 'short' : 'long',
      session: 'New York',
      exitReason: pnlForIndex(index) > 0 ? 'target' : 'stop'
    };
  });
}

test('terminal unfilled paper orders release their plan without erasing signal history', () => {
  const state = {
    live: {
      openSignalKey: 'signal-1',
      openPlan: { sizing: { actualRiskUsd: 464.5 } },
      openTriggeredAt: '2026-09-29T14:21:00.000Z',
      portfolioRisk: { reservedRiskUsd: 464.5 },
      signalHistory: ['signal-1']
    }
  };

  assert.equal(clearTerminalUnfilledPlan(state, { status: 'not-filled', exitReason: 'entry never traded' }), false);
  assert.ok(state.live.openPlan);
  assert.equal(clearTerminalUnfilledPlan(state, { status: 'not-filled', exitReason: 'order expired' }), true);
  assert.equal(state.live.openPlan, null);
  assert.equal(state.live.openSignalKey, null);
  assert.equal(state.live.openTriggeredAt, null);
  assert.equal(state.live.portfolioRisk, null);
  assert.deepEqual(state.live.signalHistory, ['signal-1']);
});

test('research lab uses an ordered 70/30 split and computes auditable metrics', () => {
  const trades = researchTrades(60);
  const split = splitChronologically([...trades].reverse());
  const metrics = performanceMetrics(trades);

  assert.equal(split.training.length, 42);
  assert.equal(split.holdout.length, 18);
  assert.equal(split.training[0].id, 'research-1');
  assert.equal(split.holdout[0].id, 'research-43');
  assert.equal(metrics.trades, 60);
  assert.equal(metrics.winRate, 50);
  assert.equal(metrics.netPnlUsd, 1500);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.expectancyUsd, 25);
});

test('research reviewer promotes positive holdout evidence and rejects failed holdouts', () => {
  const candidate = reviewEvidence(researchTrades(60).map(t => ({...t, evidenceType: 'forward-paper'})));
  const failedHoldout = reviewEvidence(researchTrades(60, (index) => index < 42 ? 100 : -100).map(t => ({...t, evidenceType: 'forward-paper'})));

  assert.equal(candidate.verdict, 'PAPER CANDIDATE');
  assert.equal(candidate.gates.chronologicalSample, true);
  assert.equal(candidate.holdout.trades, 18);
  assert.equal(failedHoldout.verdict, 'REJECT');
  assert.ok(failedHoldout.redFlags.includes('Chronological trailing sample expectancy is not positive.'));
});

test('research data audits catch malformed trades and candle gaps', () => {
  const tradeAudit = auditResearchTrades([
    { id: 'duplicate', date: '2026-01-01', realizedPnlUsd: 10 },
    { id: 'duplicate', date: 'not-a-date', realizedPnlUsd: 'missing' }
  ]);
  const candleAudit = auditCandles([
    { timestamp: '2026-01-01T14:00:00.000Z', open: 100, high: 102, low: 99, close: 101 },
    { timestamp: '2026-01-01T14:03:00.000Z', open: 101, high: 103, low: 100, close: 102 }
  ]);

  assert.equal(tradeAudit.ok, false);
  assert.equal(tradeAudit.errors, 3);
  assert.equal(candleAudit.ok, true);
  assert.equal(candleAudit.warnings, 1);
  assert.equal(candleAudit.issues[0].code, 'time-gap');
});

test('research lab reads closed journal entries without altering live strategy state', () => {
  const trades = researchTrades(2);
  const snapshot = {
    source: 'test',
    strategies: [{
      slug: STRATEGIES[0].slug,
      name: STRATEGIES[0].name,
      strategyFamilyName: STRATEGIES[0].strategyFamilyName,
      journal: { dailyRecaps: [{ date: trades[0].date, tradesList: trades }] },
      live: { activeTrade: { status: 'open', unrealizedPnlUsd: 250 } }
    }]
  };
  const before = structuredClone(snapshot);
  const lab = buildResearchLab(snapshot);

  assert.equal(lab.summary.closedTrades, 0);
  assert.equal(lab.summary.allJournalTrades, 2);
  assert.equal(lab.reports[0].review.execution, 'paper-only');
  assert.deepEqual(snapshot, before);
});

test('Databento historical records normalize fixed prices and timestamps', () => {
  const candles = parseDatabentoJson([
    JSON.stringify({ hd: { ts_event: '1788445800000000000', instrument_id: 42004177 }, open: '29343000000000', high: '29360500000000', low: '29338750000000', close: '29356000000000', volume: '1427' }),
    JSON.stringify({ ts_event: '2026-08-01T14:31:00.000Z', open: 23000.5, high: 23002, low: 23000, close: 23001.5, volume: 12, instrument_id: 42 })
  ].join('\n'));

  assert.equal(candles.length, 2);
  assert.equal(candles[0].close, 23001.5);
  assert.equal(candles[1].timestamp, '2026-09-03T14:30:00.000Z');
  assert.equal(candles[1].open, 29343);
  assert.equal(candles[1].instrumentId, 42004177);
});

test('historical backtest window defaults to the prior 60 calendar days', () => {
  const window = historicalWindow(60, new Date('2026-09-04T12:34:56.000Z'));
  assert.equal(window.days, 60);
  assert.equal(window.end, '2026-09-04T12:14:00.000Z');
  assert.equal(window.start, '2026-07-06T12:14:00.000Z');
});

test('2026 backtest window runs from January 1 through the delayed current minute', () => {
  const window = historicalYearWindow(2026, new Date('2026-09-05T12:34:56.000Z'));
  assert.equal(window.year, 2026);
  assert.equal(window.start, '2026-01-01T00:00:00.000Z');
  assert.equal(window.end, '2026-09-05T12:14:00.000Z');
  assert.equal(window.days, 248);
});

test('since-year backtest window runs from January 2025 through the delayed current minute', () => {
  const window = historicalSinceYearWindow(2025, new Date('2026-09-05T12:34:56.000Z'));
  assert.equal(window.startYear, 2025);
  assert.equal(window.endYear, 2026);
  assert.equal(window.start, '2025-01-01T00:00:00.000Z');
  assert.equal(window.end, '2026-09-05T12:14:00.000Z');
  assert.ok(window.days > 600);
});

test('year-to-date history is split into bounded contiguous requests', () => {
  const chunks = splitHistoricalWindow({
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-03-15T12:00:00.000Z'
  }, 30);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].start, '2026-01-01T00:00:00.000Z');
  assert.equal(chunks[0].end, chunks[1].start);
  assert.equal(chunks[1].end, chunks[2].start);
  assert.equal(chunks.at(-1).end, '2026-03-15T12:00:00.000Z');
});

test('historical service merges candles returned from every bounded request', async () => {
  const calls = [];
  const result = await fetchDatabentoHistoricalCandles({
    apiKey: 'test-key',
    window: { start: '2026-01-01T00:00:00.000Z', end: '2026-03-15T12:00:00.000Z', year: 2026, days: 74 },
    chunkDays: 30,
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      calls.push(url);
      return {
        ok: true,
        text: async () => JSON.stringify({
          ts_event: url.searchParams.get('start'),
          open: 20_000,
          high: 20_001,
          low: 19_999,
          close: 20_000.5,
          volume: 10
        })
      };
    }
  });

  assert.equal(calls.length, 3);
  assert.equal(result.candles.length, 3);
  assert.equal(result.window.year, 2026);
  assert.ok(calls.every((url) => url.searchParams.get('schema') === 'ohlcv-1m'));
});

test('daily historical cache reuses overlapping windows and fetches only missing days', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-cache-'));
  const calls = [];
  const events = [];
  const options = {
    cacheDir, apiKey: 'test-key', now: new Date('2026-09-06T12:00:00Z'),
    onProgress: (event) => events.push(event),
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      const start = Date.parse(url.searchParams.get('start'));
      const end = Date.parse(url.searchParams.get('end'));
      calls.push({ start, end, symbol: url.searchParams.get('symbols') });
      const rows = [];
      for (let time = start; time < end; time += 60_000) { const p=require('../lib/session-quality.cjs').parts(time); const d=new Date(p.date+'T12:00Z').getUTCDay(); if(d===6||(d===0&&p.minute<1080)||(d===5&&p.minute>=1020)||(p.minute>=1020&&p.minute<1080))continue; rows.push({
        ts_event: new Date(time).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 10
      }); }
      return { ok: true, text: async () => JSON.stringify(rows) };
    }
  };
  const window = { start: '2025-02-04T00:00:00.000Z', end: '2025-02-06T00:00:00.000Z' };
  try {
    const first = await fetchDatabentoHistoricalCandles({ ...options, window });
    const second = await fetchDatabentoHistoricalCandles({ ...options, window, apiKey: '', env: {}, fetchImpl: () => { throw new Error('Cache should avoid network'); } });
    assert.deepEqual(second.candles, first.candles);
    assert.equal(calls.length, 1);
    const overlap = await fetchDatabentoHistoricalCandles({ ...options, window: { start: '2025-02-05T00:00:00.000Z', end: '2025-02-07T00:00:00.000Z' } });
    assert.equal(overlap.candles.length, 2760);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].start, Date.parse('2025-02-06T00:00:00Z'));
    assert.ok(events.some((event) => event.phase === 'cache-read' && event.cachedDays === 2));
    await fetchDatabentoHistoricalCandles({ ...options, window, symbol: 'MNQ.v.0' });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].symbol, 'MNQ.v.0');
    const identityDir = fs.readdirSync(cacheDir).find((directory) => JSON.parse(fs.readFileSync(path.join(cacheDir, directory, '2025-02-04.json'))).identity.includes('"symbol":"NQ.v.0"'));
    fs.writeFileSync(path.join(cacheDir, identityDir, '2025-02-04.json'), 'broken');
    await fetchDatabentoHistoricalCandles({ ...options, window });
    assert.equal(calls.length, 4);
    assert.equal(calls[3].end, Date.parse('2025-02-05T00:00:00Z'));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});


test('backtest progress identifies strategy, calendar date, and completion', () => {
  const events = [];
  const candles = [{ timestamp: '2025-01-02T15:00:00Z', open: 100, high: 101, low: 99, close: 100, volume: 10 }];
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const result = runAllBacktests(candles, config, {
    strategies: [{ slug: 'test', name: 'Test' }],
    dependencies: { detectSignal: () => ({ found: false }) },
    onProgress: (event) => events.push(event)
  });
  assert.equal(result.strategies.length, 1);
  assert.equal(events[0].date, '2025-01-02');
  assert.equal(events[0].strategyIndex, 1);
  assert.equal(events.at(-1).phase, 'strategy-completed');
  assert.equal(events.at(-1).daysCompleted, 1);
});

test('remote backtest URL derives from the existing private live bridge', () => {
  assert.deepEqual(remoteBacktestUrls({ LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status' }), ['https://private.example/api/backtest']);
  assert.deepEqual(remoteBacktestResultUrls({ LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status' }), ['https://private.example/api/backtest-results']);
});

test('cached backtest results use the existing private bridge token', async () => {
  let request;
  const result = await getCachedBacktest({
    env: {
      LIVE_STATUS_SOURCE_URL: 'https://private.example/api/live-status',
      LIVE_STATUS_TOKEN: 'private-token'
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, result: { evidenceClass: 'historical-simulated' } }) };
    }
  });

  assert.equal(request.url, 'https://private.example/api/backtest-results');
  assert.equal(request.options.headers.authorization, 'Bearer private-token');
  assert.equal(result.evidenceClass, 'historical-simulated');
});

test('backtest worker cache writes atomically and remains readable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-backtest-'));
  const cachePath = path.join(directory, 'backtest-results.json');
  const result = { generatedAt: '2026-09-04T18:27:49.006Z', strategies: [] };

  saveBacktestResult(cachePath, result);

  assert.deepEqual(readBacktestResult(cachePath), result);
  assert.deepEqual(fs.readdirSync(directory), ['backtest-results.json']);
});


test('60-day backtest fills only after the detection checkpoint and reaches its separate 50-trade gate', () => {
  const candles = [];
  for (let day = 0; day < 60; day += 1) {
    const first = new Date(Date.parse(businessDate(day)+'T15:00Z'));
    const second = new Date(first.getTime() + 60_000);
    const third = new Date(first.getTime() + 120_000);
    const fourth = new Date(first.getTime() + 180_000);
    const fifth = new Date(first.getTime() + 240_000);
    candles.push({ timestamp: first.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: second.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: third.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: fourth.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: fifth.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
  }
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  let sequence = 0;
  const definition = { slug: 'test-strategy', name: 'Test strategy', strategyFamily: 'test', strategyFamilyName: 'Test' };
  const result = runStrategyBacktest(completeCash(candles), config, definition, {
    detectSignal(context) {
      if(context.at(-1)._padding)return {found:false};
      if (context.length < 2) return { found: false };
      const trigger = context.at(-2);
      const date = trigger.timestamp.slice(0, 10);
      return {
        found: true,
        triggerTimestamp: trigger.timestamp,
        sweepTimestamp: trigger.timestamp,
        setup: { symbol: 'NQ', date, session: 'Test', side: 'long', entry: 100, stop: 99, targets: [101], thesis: 'test', setup: {} }
      };
    },
    buildPlan(signal) {
      return { setup: signal.setup, sizing: { maxContracts: 1, actualRiskUsd: 100 }, targets: [], triggerTimestamp: signal.triggerTimestamp };
    },
    replay(plan, future) {
      assert.ok(future.every((candle) => Date.parse(candle.timestamp) > Date.parse(plan.triggerTimestamp)));
      const pnl = Math.floor(sequence / 2) % 2 === 0 ? 100 : -50;
      sequence += 1;
      return { status: 'closed', contracts: 1, filledAt: future[0].timestamp, exitReason: pnl > 0 ? 'target' : 'stop-loss', finalExitPrice: 100, realizedPnlUsd: pnl, rMultiple: pnl / 100, targetsHit: [], mfePoints: 1, maePoints: 1, mfeUsd: 20, maeUsd: -20 };
    }
  });

  assert.equal(result.trades.length, 60);
  assert.equal(result.review.recommendation, 'ADVANCE TO FORWARD TEST');
  assert.equal(result.review.evidenceType, 'historical-simulated');
  assert.ok(result.trades.every((trade) => trade.evidenceType === 'historical-simulated'));
  assert.ok(result.trades.every((trade) => Date.parse(trade.filledAt) > Date.parse(trade.detectedAt)));
});

test('historical recommendations never use the forward-paper promotion label', () => {
  const review = reviewBacktestEvidence(researchTrades(60));
  assert.equal(review.recommendation, 'ADVANCE TO FORWARD TEST');
  assert.notEqual(review.recommendation, 'PAPER CANDIDATE');
});

test('an untradeable signal does not abort the remaining historical sessions', () => {
  const candles = [];
  for (let day = 0; day < 3; day += 1) {
    const first = new Date(Date.parse(businessDate(day)+'T15:00Z'));
    const second = new Date(first.getTime() + 60_000);
    const third = new Date(first.getTime() + 120_000);
    const fourth = new Date(first.getTime() + 180_000);
    const fifth = new Date(first.getTime() + 240_000);
    candles.push({ timestamp: first.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: second.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: third.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: fourth.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
    candles.push({ timestamp: fifth.toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 });
  }
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  let plans = 0;
  const result = runStrategyBacktest(completeCash(candles), config, {
    slug: 'test-strategy',
    name: 'Test strategy',
    strategyFamily: 'test',
    strategyFamilyName: 'Test'
  }, {
    detectSignal(context) {
      if(context.at(-1)._padding)return {found:false};
      if (context.length < 2) return { found: false };
      const trigger = context.at(-2);
      return {
        found: true,
        triggerTimestamp: trigger.timestamp,
        setup: { symbol: 'NQ', date: trigger.timestamp.slice(0, 10), session: 'Test', side: 'long', entry: 100, stop: 99, targets: [101], thesis: 'test', setup: {} }
      };
    },
    buildPlan(signal) {
      plans += 1;
      if (plans <= 2) throw new Error('No trade: minimum 1-contract risk exceeds the strategy limit');
      return { setup: signal.setup, sizing: { maxContracts: 1, actualRiskUsd: 100 }, targets: [], triggerTimestamp: signal.triggerTimestamp };
    },
    replay(plan, future) {
      return { status: 'closed', contracts: 1, filledAt: future[0].timestamp, exitReason: 'target', finalExitPrice: 101, realizedPnlUsd: 100, rMultiple: 1, targetsHit: [], mfePoints: 1, maePoints: 0, mfeUsd: 20, maeUsd: 0 };
    }
  });

  assert.equal(result.signals, 3);
  assert.equal(result.rejectedSignals, 1);
  assert.equal(result.trades.length, 2);
});

test('sample setup builds and replays through the shared trading engine', () => {
  const config = core.normalizeConfig(core.loadJson(path.join(root, 'config.json')));
  const setup = core.normalizeSetup(core.loadJson(path.join(root, 'examples', 'lucid-sweep-short.setup.json')), config);
  const validation = core.validateSetup(setup, config);
  assert.equal(validation.valid, true, validation.errors.join('\n'));

  const plan = core.buildTradePlan(setup, config, core.createEmptyState(config));
  const candles = core.parseCsvFile(path.join(root, 'examples', 'sample-nq-1m.csv'));
  const replay = core.replayPlan(plan, candles, config);

  assert.ok(plan.sizing.maxContracts > 0);
  assert.ok(Number.isFinite(replay.realizedPnlUsd));
  assert.ok(replay.mfePoints >= 0);
  assert.ok(replay.maePoints >= 0);
  assert.ok(replay.mfeUsd >= 0);
  assert.ok(replay.maeUsd <= 0);
  assert.ok(['closed', 'open', 'not-filled'].includes(replay.status));
});

test('live log parser returns the latest candle and reason', () => {
  const status = parseLiveStatus([
    '[2026-08-28T14:01:00.000Z] live tick',
    'Feed: databento NQ.v.0',
    'Last candle: 2026-08-28T14:00:00Z O:20000 H:20005 L:19995 C:20002',
    'No trade: Waiting for a qualifying sweep'
  ].join('\n'));

  assert.equal(status.lastCandle.close, 20002);
  assert.equal(status.latestReason, 'Waiting for a qualifying sweep');
  assert.equal(status.latestError, null);
});

test('daily summaries preserve per-day PnL and detailed trades', () => {
  const state = {
    balanceUsd: 50_075,
    realizedPnlUsd: 75,
    trades: [
      { id: 'a', date: '2026-08-27', realizedPnlUsd: -25, rMultiple: -1 },
      { id: 'b', date: '2026-08-28', realizedPnlUsd: 100, rMultiple: 2 }
    ],
    live: {}
  };
  const summary = summarizeJournal(state, {
    lastCandle: { timestamp: '2026-08-28T14:00:00Z' },
    activeTrade: null
  });

  assert.equal(summary.daily.date, '2026-08-28');
  assert.equal(summary.daily.realizedPnlUsd, 100);
  assert.equal(summary.dailyRecaps.length, 2);
  assert.equal(summary.dailyRecaps[0].tradesList[0].id, 'b');
});

test('live state writes atomically without leaving temporary files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-'));
  const statePath = path.join(directory, 'state.json');
  saveLiveState(statePath, { balanceUsd: 50_000, live: { heartbeat: { ok: true } } });

  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).live.heartbeat.ok, true);
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('remote snapshots do not expose bridge URLs or private watcher commands', () => {
  const snapshot = sanitizeRemoteSnapshot({
    remoteUrl: 'https://secret.example/status',
    error: 'private bridge detail',
    strategies: [{
      live: {
        latestError: {
          at: '2026-08-29T12:00:00.000Z',
          message: 'python3 /private/path/fetch.py --key-env DATABENTO_API_KEY'
        }
      }
    }]
  });

  assert.equal(snapshot.remoteUrl, undefined);
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.strategies[0].live.latestError.at, '2026-08-29T12:00:00.000Z');
  assert.equal(
    snapshot.strategies[0].live.latestError.message,
    'Live data refresh failed. Check the private watcher logs on the VPS.'
  );
});

test('operator sessions use a server-only derived cookie and accept bearer access', async () => {
  const originalToken = process.env.TRADING_ADMIN_TOKEN;
  process.env.TRADING_ADMIN_TOKEN = 'test-operator-token-with-adequate-length';
  try {
    const auth = await import('../lib/operator-auth.mjs');
    const session = auth.operatorSessionValue();
    assert.ok(session);
    assert.notEqual(session, process.env.TRADING_ADMIN_TOKEN);
    assert.equal(auth.verifyOperatorPasscode(process.env.TRADING_ADMIN_TOKEN), true);
    assert.equal(auth.verifyOperatorPasscode('wrong-token'), false);
    assert.equal(auth.isOperatorRequest({
      headers: new Headers({ authorization: `Bearer ${process.env.TRADING_ADMIN_TOKEN}` }),
      cookies: { get: () => undefined }
    }), true);
    assert.equal(auth.isTrustedMutationOrigin({
      url: 'http://localhost:3000/api/operator-session',
      headers: new Headers({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' })
    }), true);
  } finally {
    if (originalToken === undefined) delete process.env.TRADING_ADMIN_TOKEN;
    else process.env.TRADING_ADMIN_TOKEN = originalToken;
  }
});

test('cloud journal validation rejects malformed and oversized batches before database access', async () => {
  const { validateJournalEntries } = await import('../lib/cloud-journal.mjs');
  assert.deepEqual(validateJournalEntries([{ id: 'trade-1', date: '2026-08-29' }]), [{ id: 'trade-1', date: '2026-08-29' }]);
  assert.throws(() => validateJournalEntries([{ date: '2026-08-29' }]), /non-empty id/);
  assert.throws(() => validateJournalEntries(Array.from({ length: 251 }, (_, index) => ({ id: String(index) }))), /up to 250/);
});

test('Telegram alerts require a token and destination without exposing either in the message', () => {
  const config = getTelegramConfig({
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF',
    TELEGRAM_CHAT_ID: '-1001234567890'
  });
  const message = formatTelegramAlert({
    type: 'trade-closed',
    status: 'closed',
    strategy: 'live-9am-sweep',
    symbol: 'NQ',
    side: 'long',
    realizedPnlUsd: 125.5,
    rMultiple: 1.25,
    at: '2026-08-29T15:00:00.000Z'
  });

  assert.equal(config.ready, true);
  assert.equal(config.validTokenFormat, true);
  assert.match(message, /paper trade closed/);
  assert.match(message, /Realized P&L: \$125\.50/);
  assert.doesNotMatch(message, /123456789/);
  assert.doesNotMatch(message, /-1001234567890/);
});

test('Telegram sender posts trade events and filters every non-trade event', async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } })
    };
  };
  const env = {
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF',
    TELEGRAM_CHAT_ID: '987654321'
  };

  const result = await sendTelegramAlert({
    type: 'trade-opened',
    status: 'opened',
    symbol: 'NQ',
    side: 'long',
    entry: 20000,
    stop: 19990
  }, { env, fetchImpl });
  const filtered = await sendTelegramAlert({ type: 'watcher-health' }, {
    env,
    fetchImpl: () => assert.fail('fetch should not be called for watcher-health events')
  });
  const skipped = await sendTelegramAlert({ type: 'trade-closed' }, {
    env: { TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
    fetchImpl: () => assert.fail('fetch should not be called without a chat ID')
  });

  assert.equal(result.sent, true);
  assert.equal(result.messageId, 42);
  assert.match(request.url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(request.options.body).chat_id, '987654321');
  assert.deepEqual(filtered, { sent: false, reason: 'event-filtered' });
  assert.deepEqual(skipped, { sent: false, reason: 'missing-chat-id' });
});

test('Databento watcher accepts only fresh live-stream cache payloads', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-live-'));
  const cachePath = path.join(directory, 'databento-live.json');
  const timestamp = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(cachePath, JSON.stringify({
    mode: 'live',
    provider: 'databento-live',
    startedAt: timestamp,
    updatedAt: timestamp,
    candles: [{ timestamp, open: 20000, high: 20005, low: 19995, close: 20002, volume: 10 }]
  }));
  const previousKey = process.env.DATABENTO_API_KEY;
  process.env.DATABENTO_API_KEY = 'test-key';
  try {
    const config = { live: { provider: 'databento', liveCachePath: cachePath, maxLiveCandleAgeMinutes: 3 } };
    assert.equal(normalizeStrategyConfig(config).provider, 'databento-live');
    const result = await fetchLiveCandles(config);
    assert.equal(result.metadata.provider, 'databento-live');
    assert.equal(result.candles[0].close, 20002);

    fs.writeFileSync(cachePath, JSON.stringify({
      mode: 'historical',
      provider: 'databento',
      candles: [{ timestamp, open: 1, high: 1, low: 1, close: 1 }]
    }));
    await assert.rejects(() => fetchLiveCandles(config), /not marked as live-stream data/);
  } finally {
    if (previousKey === undefined) delete process.env.DATABENTO_API_KEY;
    else process.env.DATABENTO_API_KEY = previousKey;
  }
});









test('Asia/London context records which side London swept without changing entries', () => {
  const sessionRanges = {
    asia: { high: 20_010, low: 19_990, start: '2026-09-02T00:00:00.000Z', end: '2026-09-02T05:59:00.000Z' },
    london: { high: 20_005, low: 19_985, start: '2026-09-02T06:00:00.000Z', end: '2026-09-02T11:59:00.000Z' }
  };
  const context = computeAmdContext([
    { timestamp: '2026-09-02T06:30:00.000Z', high: 20_005, low: 19_985 }
  ], sessionRanges);
  assert.equal(context.classification, 'asia-low-swept');
  assert.equal(context.supportsLong, true);
  assert.equal(context.supportsShort, false);
});


test('shared portfolio guard caps simultaneous paper risk at $2,500', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctortrades-portfolio-'));
  const config = { maxPortfolioOpenRiskUsd: 2500 };
  for (const strategy of STRATEGIES.slice(0, 2)) {
    const files = runtimeFilesForStrategy(directory, strategy.slug);
    fs.writeFileSync(files.statePath, JSON.stringify({
      live: { openPlan: { sizing: { actualRiskUsd: 1000 } } }
    }));
  }

  const before = getPortfolioRiskSnapshot(directory, config);
  assert.equal(before.reservedRiskUsd, 2000);
  assert.equal(before.availableRiskUsd, 500);

  const fifth = STRATEGIES[2];
  const allowed = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: fifth.slug,
    proposedRiskUsd: 500,
    commit: () => {
      fs.writeFileSync(runtimeFilesForStrategy(directory, fifth.slug).statePath, JSON.stringify({
        live: { openPlan: { sizing: { actualRiskUsd: 500 } } }
      }));
    }
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.projectedRiskUsd, 2500);

  const atCap = getPortfolioRiskSnapshot(directory, config);
  assert.equal(atCap.status, 'cap-reached');
  assert.equal(atCap.availableRiskUsd, 0);

  const blocked = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: STRATEGIES[0].slug,
    proposedRiskUsd: 100
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /already holds a \$1000\.00 paper-risk reservation/);

  fs.unlinkSync(runtimeFilesForStrategy(directory, fifth.slug).statePath);
  const overCap = reservePortfolioRisk({
    rootDir: directory,
    config,
    strategySlug: fifth.slug,
    proposedRiskUsd: 600
  });
  assert.equal(overCap.allowed, false);
  assert.match(overCap.reason, /above the \$2500\.00 cap/);
});








test('research scorecard only promotes a strategy after every paper gate passes', () => {
  const trades = Array.from({ length: 50 }, (_, index) => ({
    evidenceType: 'forward-paper',
    date: `2026-08-${String((index % 25) + 1).padStart(2, '0')}`,
    realizedPnlUsd: index % 5 === 0 ? -100 : 100,
    actualRiskUsd: 100, maeUsd: -100,
    rMultiple: index % 5 === 0 ? -1 : 1
  }));
  const evaluation = evaluateStrategyJournal({ trades });
  assert.equal(evaluation.status, 'Paper candidate');
  assert.equal(evaluation.passedGates, evaluation.totalGates);
  assert.equal(evaluation.execution, 'paper-only');
  assert.equal(evaluation.boardGroup, 'focus');
});

test('twenty-trade profit factor below one moves a strategy to the watchlist without hiding it', () => {
  const trades = Array.from({ length: 20 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    realizedPnlUsd: index < 12 ? -100 : 50,
    rMultiple: index < 12 ? -1 : 0.5
  }));
  const evaluation = evaluateStrategyJournal({ trades });
  assert.equal(evaluation.profitFactor, 0.33);
  assert.equal(evaluation.boardGroup, 'watchlist');
  assert.equal(evaluation.includedInFocusTotals, false);
  assert.equal(evaluation.trades, 20);
});




