const fs = require('fs');
const path = require('path');
const {
  buildTradePlan,
  normalizeSetup,
  parseCsvFile,
  trackTradeLifecycle
} = require('./trader-core.cjs');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// The same 2,501-candle context is revisited every minute during replay.
// Cache calendar conversion only, never indicators or future-dependent signals.
const zonedFormatters = new Map();
const zonedPartsCache = new Map();
const MAX_ZONED_PARTS = 8192;

function getZonedParts(timestamp, timeZone) {
  const cacheKey = `${timeZone}|${timestamp}`;
  const cached = zonedPartsCache.get(cacheKey);
  if (cached) return cached;
  const date = new Date(timestamp);
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    if (zonedFormatters.size >= 16) zonedFormatters.delete(zonedFormatters.keys().next().value);
    zonedFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const result = Object.freeze({
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  });
  if (zonedPartsCache.size >= MAX_ZONED_PARTS) zonedPartsCache.delete(zonedPartsCache.keys().next().value);
  zonedPartsCache.set(cacheKey, result);
  return result;
}

function toMinutes(hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return (hour * 60) + minute;
}

function minutesForTimestamp(timestamp, timeZone) {
  const parts = getZonedParts(timestamp, timeZone);
  return (parts.hour * 60) + parts.minute;
}

function inWindow(minuteOfDay, start, end) {
  const startMinute = toMinutes(start);
  const endMinute = toMinutes(end);
  if (startMinute <= endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay <= endMinute;
  }
  return minuteOfDay >= startMinute || minuteOfDay <= endMinute;
}

function shiftDate(dateString, deltaDays) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseActivationTime(activationTime) {
  const [clock, timeZone] = String(activationTime || '').split(/\s+/);
  if (!clock || !timeZone) {
    throw new Error('activationTime must look like "09:00 America/New_York"');
  }
  return {
    clock,
    timeZone,
    minuteOfDay: toMinutes(clock)
  };
}

function normalizeStrategyConfig(rawConfig) {
  const live = rawConfig.live || {};
  const apiKeyEnv = String(live.apiKeyEnv || process.env.LIVE_DATA_API_KEY_ENV || 'DATABENTO_API_KEY');
  const hasDatabentoKey = Boolean(process.env[apiKeyEnv]);
  const requestedProvider = String(live.provider || process.env.LIVE_DATA_PROVIDER || '');
  const selectedProvider = !requestedProvider || requestedProvider === 'auto'
    ? (hasDatabentoKey ? 'databento-live' : 'mock')
    : requestedProvider;
  const resolvedProvider = selectedProvider === 'databento' ? 'databento-live' : selectedProvider;
  return {
    provider: resolvedProvider,
    ticker: String(live.ticker || process.env.LIVE_DATA_TICKER || 'NQ.v.0'),
    mockCsvPath: String(live.mockCsvPath || process.env.LIVE_DATA_MOCK_CSV || path.join(process.cwd(), 'examples', 'sample-nq-1m.csv')),
    apiKeyEnv,
    baseUrl: String(live.baseUrl || process.env.LIVE_DATA_BASE_URL || 'https://api.polygon.io'),
    dataset: String(live.dataset || process.env.LIVE_DATA_DATASET || 'GLBX.MDP3'),
    schema: String(live.schema || process.env.LIVE_DATA_SCHEMA || 'ohlcv-1m'),
    stypeIn: String(live.stypeIn || process.env.LIVE_DATA_STYPE_IN || 'continuous'),
    pythonBin: String(live.pythonBin || process.env.LIVE_DATA_PYTHON_BIN || 'python3'),
    liveCachePath: String(process.env.LIVE_DATA_CACHE_PATH || live.liveCachePath || path.join(process.cwd(), 'runtime', 'databento-live.json')),
    maxLiveCandleAgeMinutes: Number(live.maxLiveCandleAgeMinutes || process.env.LIVE_DATA_MAX_CANDLE_AGE_MINUTES || 3),
    lookbackBars: Number(live.lookbackBars || 2880),
    pollIntervalMs: Number(live.pollIntervalMs || process.env.LIVE_DATA_POLL_INTERVAL_MS || 60000),
    sessionWindows: {
      asia: {
        start: String(live.sessionWindows?.asia?.start || '20:00'),
        end: String(live.sessionWindows?.asia?.end || '01:59')
      },
      london: {
        start: String(live.sessionWindows?.london?.start || '02:00'),
        end: String(live.sessionWindows?.london?.end || '07:59')
      }
    },
    riskRewardFallback: Number(live.riskRewardFallback || 1.5),
    entryBufferTicks: Number(live.entryBufferTicks || 0),
    stopBufferTicks: Number(live.stopBufferTicks || 1),
    maxSignalAgeBars: Number(live.maxSignalAgeBars || 15),
    maxTradesPerDay: Number(live.maxTradesPerDay || 1),
  };
}

function fetchDatabentoLiveCandles(strategyConfig) {
  const apiKey = process.env[strategyConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${strategyConfig.apiKeyEnv} environment variable for Databento live futures data`);
  }
  const cachePath = path.resolve(strategyConfig.liveCachePath);
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Databento live stream cache is not ready at ${cachePath}`);
  }
  const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  if (payload.mode !== 'live' || payload.provider !== 'databento-live') {
    throw new Error('Databento cache rejected because it is not marked as live-stream data');
  }
  const candles = (Array.isArray(payload.candles) ? payload.candles : [])
    .map((candle) => ({
      timestamp: candle.timestamp,
      instrumentId: candle.instrumentId ?? candle.instrument_id ?? null,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    }))
    .filter((candle) => (
      candle.timestamp &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    ))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp))
    .slice(-Math.max(1, strategyConfig.lookbackBars));
  if (!candles.length) {
    throw new Error(`No live Databento candles available for ${strategyConfig.ticker}`);
  }
  const lastCandleAt = new Date(candles.at(-1).timestamp).getTime();
  const ageMinutes = (Date.now() - lastCandleAt) / 60_000;
  if (!Number.isFinite(lastCandleAt) || ageMinutes > strategyConfig.maxLiveCandleAgeMinutes) {
    if (require('./market-feed-status.cjs').clock(new Date(), path.resolve(__dirname, '..'), strategyConfig.ticker).regularMarketClosed) {
      const error = new Error('CME regular session is closed'); error.code = 'MARKET_CLOSED'; throw error;
    }
    throw new Error(
      `Databento live candle is stale by ${Number.isFinite(ageMinutes) ? ageMinutes.toFixed(1) : 'unknown'} minutes; latest candle ${candles.at(-1).timestamp}`
    );
  }
  return {
    source: `databento-live:${strategyConfig.dataset}:${strategyConfig.ticker}`,
    candles,
    metadata: {
      provider: 'databento-live',
      ticker: strategyConfig.ticker,
      dataset: strategyConfig.dataset,
      schema: strategyConfig.schema,
      stypeIn: strategyConfig.stypeIn,
      fetchedAt: new Date().toISOString(),
      streamStartedAt: payload.startedAt || null,
      cacheUpdatedAt: payload.updatedAt || null,
      note: 'Databento Live API OHLCV stream; historical API fallback is disabled',
      fetchedRows: candles.length
    }
  };
}

async function fetchPolygonFuturesCandles(strategyConfig, signalConfig) {
  const apiKey = process.env[strategyConfig.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${strategyConfig.apiKeyEnv} environment variable for live futures data`);
  }
  const url = new URL(`/futures/v1/aggs/${strategyConfig.ticker}`, strategyConfig.baseUrl);
  url.searchParams.set('resolution', '1min');
  url.searchParams.set('limit', String(strategyConfig.lookbackBars));
  url.searchParams.set('sort', 'window_start.asc');
  url.searchParams.set('apiKey', apiKey);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Polygon futures request failed with ${response.status}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload.results) ? payload.results : [];
  if (!rows.length) {
    throw new Error(`No live candles returned for ${strategyConfig.ticker}`);
  }
  const candles = rows.map((row) => ({
    timestamp: row.window_start || row.session_end_date || row.timestamp,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close)
  })).filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
  return {
    source: `polygon-futures:${strategyConfig.ticker}`,
    candles,
    metadata: {
      provider: 'polygon-futures',
      ticker: strategyConfig.ticker,
      fetchedAt: new Date().toISOString(),
      note: 'Futures aggregate bars API'
    }
  };
}

function fetchMockCandles(strategyConfig) {
  const csvPath = path.resolve(strategyConfig.mockCsvPath);
  return {
    source: `mock:${csvPath}`,
    candles: parseCsvFile(csvPath),
    metadata: {
      provider: 'mock',
      ticker: strategyConfig.ticker,
      fetchedAt: new Date().toISOString()
    }
  };
}

async function fetchLiveCandles(rawConfig) {
  const strategyConfig = normalizeStrategyConfig(rawConfig);
  if (strategyConfig.provider === 'mock') {
    return fetchMockCandles(strategyConfig);
  }
  if (strategyConfig.provider === 'databento-live') {
    return fetchDatabentoLiveCandles(strategyConfig);
  }
  if (strategyConfig.provider === 'polygon-futures') {
    return fetchPolygonFuturesCandles(strategyConfig, rawConfig);
  }
  throw new Error(`Unsupported live provider: ${strategyConfig.provider}`);
}

function computeSessionRange(candles, timeZone, tradingDate, window) {
  const crossesMidnight = toMinutes(window.start) > toMinutes(window.end);
  const priorDate = shiftDate(tradingDate, -1);
  const sessionCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, timeZone);
    const minuteOfDay = (parts.hour * 60) + parts.minute;
    if (!crossesMidnight) {
      return parts.date === tradingDate && inWindow(minuteOfDay, window.start, window.end);
    }
    return (
      (parts.date === priorDate && minuteOfDay >= toMinutes(window.start)) ||
      (parts.date === tradingDate && minuteOfDay <= toMinutes(window.end))
    );
  });
  if (!sessionCandles.length) {
    return null;
  }
  const highs = sessionCandles.map((candle) => candle.high);
  const lows = sessionCandles.map((candle) => candle.low);
  return {
    high: Math.max(...highs),
    low: Math.min(...lows),
    start: sessionCandles[0].timestamp,
    end: sessionCandles[sessionCandles.length - 1].timestamp
  };
}

function buildTargets(side, entry, stop, sessionRanges, config) {
  const risk = Math.abs(entry - stop);
  if (side === 'short') {
    const downsidePools = [sessionRanges.asia?.low, sessionRanges.london?.low].filter((value) => Number.isFinite(value) && value < entry).sort((a, b) => b - a);
    const first = downsidePools[0] ?? round(entry - (risk * config.riskRewardFallback), 2);
    const second = downsidePools[1] ?? round(entry - (risk * (config.riskRewardFallback + 0.75)), 2);
    const third = round(entry - (risk * (config.riskRewardFallback + 1.5)), 2);
    return [first, second, third].filter((value, index, array) => value < entry && array.indexOf(value) === index);
  }

  const upsidePools = [sessionRanges.asia?.high, sessionRanges.london?.high].filter((value) => Number.isFinite(value) && value > entry).sort((a, b) => a - b);
  const first = upsidePools[0] ?? round(entry + (risk * config.riskRewardFallback), 2);
  const second = upsidePools[1] ?? round(entry + (risk * (config.riskRewardFallback + 0.75)), 2);
  const third = round(entry + (risk * (config.riskRewardFallback + 1.5)), 2);
  return [first, second, third].filter((value, index, array) => value > entry && array.indexOf(value) === index);
}

function computeAmdContext(candles, sessionRanges) {
  const asia = sessionRanges?.asia;
  const london = sessionRanges?.london;
  if (!asia || !london) {
    return {
      status: 'unavailable',
      classification: 'unknown',
      suggestedBias: 'neutral',
      sweptAsiaHigh: false,
      sweptAsiaLow: false,
      reason: 'Complete Asia and London ranges are required.'
    };
  }

  const londonStart = Date.parse(london.start);
  const londonEnd = Date.parse(london.end);
  const londonCandles = candles.filter((candle) => {
    const timestamp = Date.parse(candle.timestamp);
    return Number.isFinite(timestamp) && timestamp >= londonStart && timestamp <= londonEnd;
  });
  const highSweep = londonCandles.find((candle) => candle.high > asia.high) || null;
  const lowSweep = londonCandles.find((candle) => candle.low < asia.low) || null;
  const sweptAsiaHigh = Boolean(highSweep);
  const sweptAsiaLow = Boolean(lowSweep);
  const classification = sweptAsiaHigh && sweptAsiaLow
    ? 'two-sided-manipulation'
    : sweptAsiaHigh
      ? 'asia-high-swept'
      : sweptAsiaLow
        ? 'asia-low-swept'
        : 'no-asia-sweep';
  const suggestedBias = sweptAsiaHigh && !sweptAsiaLow
    ? 'bearish-reversal'
    : sweptAsiaLow && !sweptAsiaHigh
      ? 'bullish-reversal'
      : 'neutral';

  return {
    status: 'observed',
    classification,
    suggestedBias,
    sweptAsiaHigh,
    sweptAsiaLow,
    highSweepAt: highSweep?.timestamp || null,
    lowSweepAt: lowSweep?.timestamp || null,
    supportsLong: suggestedBias === 'bullish-reversal',
    supportsShort: suggestedBias === 'bearish-reversal',
    reason: sweptAsiaHigh || sweptAsiaLow
      ? `London ${sweptAsiaHigh ? 'swept the Asia high' : ''}${sweptAsiaHigh && sweptAsiaLow ? ' and ' : ''}${sweptAsiaLow ? 'swept the Asia low' : ''}.`
      : 'London remained inside the Asia range.'
  };
}

function buildResearchSetup({
  rawConfig,
  tradingDate,
  session,
  side,
  entry,
  stop,
  targets,
  thesis,
  entryModel,
  gapType,
  entryTimeframe,
  activationTime,
  referenceSessions,
  liquidityPool,
  liquidityLabel,
  drawOnLiquidity
}) {
  return {
    symbol: rawConfig.symbol,
    date: tradingDate,
    session,
    side,
    entry,
    stop,
    targets,
    thesis,
    setup: {
      liquiditySweep: false,
      reaction: side === 'long' ? 'bullish' : 'bearish',
      marketStructureShift: false,
      displacement: false,
      entryModel,
      gapType,
      entryTimeframe,
      activationTime,
      referenceSessions,
      stopPlacement: side === 'long' ? 'swing-low' : 'swing-high',
      higherTimeframeBias: side === 'long' ? 'bullish' : 'bearish',
      liquidityPool,
      liquidityLabel,
      drawOnLiquidity
    }
  };
}

function detectNineAmSignalFromCandles(candles, rawConfig, state) {
  const liveConfig = normalizeStrategyConfig(rawConfig);
  const activation = parseActivationTime(rawConfig.liveActivationTime || '09:00 America/New_York');
  const latest = candles[candles.length - 1];
  if (!latest) {
    return { found: false, reason: 'No candles available' };
  }

  const tradingDate = getZonedParts(latest.timestamp, activation.timeZone).date;
  const latestMinute = minutesForTimestamp(latest.timestamp, activation.timeZone);
  if (latestMinute < activation.minuteOfDay) {
    return { found: false, reason: `Waiting for ${activation.clock} ${activation.timeZone}` };
  }

  const sessionRanges = {
    asia: computeSessionRange(candles, activation.timeZone, tradingDate, liveConfig.sessionWindows.asia),
    london: computeSessionRange(candles, activation.timeZone, tradingDate, liveConfig.sessionWindows.london)
  };
  if (!sessionRanges.asia || !sessionRanges.london) {
    return { found: false, reason: 'Need complete Asia and London session ranges first' };
  }
  const amdContext = computeAmdContext(candles, sessionRanges);

  const tradesToday = (state.trades || []).filter((trade) => trade.date === tradingDate).length;
  if (tradesToday >= liveConfig.maxTradesPerDay) {
    return { found: false, reason: `Daily trade cap already reached for ${tradingDate}` };
  }

  const activationCandles = candles.filter((candle) => {
    const parts = getZonedParts(candle.timestamp, activation.timeZone);
    return parts.date === tradingDate && ((parts.hour * 60) + parts.minute) >= activation.minuteOfDay;
  });
  if (activationCandles.length < 3) {
    return { found: false, reason: 'Need at least 3 post-activation candles to detect the FVG reversal', metadata: { tradingDate, amdContext } };
  }

  const sessionHigh = Math.max(sessionRanges.asia.high, sessionRanges.london.high);
  const sessionLow = Math.min(sessionRanges.asia.low, sessionRanges.london.low);

  for (let index = 2; index < activationCandles.length; index += 1) {
    const first = activationCandles[index - 2];
    const second = activationCandles[index - 1];
    const third = activationCandles[index];
    const signalAgeBars = activationCandles.length - 1 - index;
    if (signalAgeBars > liveConfig.maxSignalAgeBars) {
      continue;
    }

    const sweptHigh = Math.max(first.high, second.high, third.high) > sessionHigh;
    const sweptLow = Math.min(first.low, second.low, third.low) < sessionLow;
    const bearishFvg = first.low > third.high && second.close < second.open;
    const bullishFvg = first.high < third.low && second.close > second.open;

    if (sweptHigh && bearishFvg) {
      const entry = round(third.high - (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.max(first.high, second.high, third.high) + (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      if (rawConfig.strategySlug === 'live-9am-sweep-min-stop' && Math.abs(entry - stop) < 10) continue;
      const targets = buildTargets('short', entry, stop, sessionRanges, liveConfig);
      if (!targets.length) {
        continue;
      }
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: '9AM New York',
          side: 'short',
          entry,
          stop,
          targets,
          thesis: 'Live signal: session high sweep after 9AM New York followed by a 1-minute bearish FVG reversal back toward sell-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bearish',
            entryModel: 'session-sweep-fvg-reversal',
            gapType: 'fvg',
            entryTimeframe: 'M1',
            activationTime: `${activation.clock} ${activation.timeZone}`,
            referenceSessions: ['asia', 'london'],
            stopPlacement: 'swing-high',
            higherTimeframeBias: 'intraday-bearish-reversal',
            liquidityPool: 'asia-or-london-high',
            liquidityLabel: 'Asia / London session high',
            drawOnLiquidity: ['asia-low', 'london-low', 'intraday-sell-side']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges,
        metadata: {
          tradingDate,
          sessionHigh,
          sessionLow,
          signalSide: 'short',
          amdContext
        }
      };
    }

    if (sweptLow && bullishFvg) {
      const entry = round(third.low + (liveConfig.entryBufferTicks * rawConfig.tickSize), 2);
      const stop = round(Math.min(first.low, second.low, third.low) - (liveConfig.stopBufferTicks * rawConfig.tickSize), 2);
      if (rawConfig.strategySlug === 'live-9am-sweep-min-stop' && Math.abs(entry - stop) < 10) continue;
      const targets = buildTargets('long', entry, stop, sessionRanges, liveConfig);
      if (!targets.length) {
        continue;
      }
      return {
        found: true,
        setup: {
          symbol: rawConfig.symbol,
          date: tradingDate,
          session: '9AM New York',
          side: 'long',
          entry,
          stop,
          targets,
          thesis: 'Live signal: session low sweep after 9AM New York followed by a 1-minute bullish FVG reversal back toward buy-side liquidity.',
          setup: {
            liquiditySweep: true,
            reaction: 'bullish',
            entryModel: 'session-sweep-fvg-reversal',
            gapType: 'fvg',
            entryTimeframe: 'M1',
            activationTime: `${activation.clock} ${activation.timeZone}`,
            referenceSessions: ['asia', 'london'],
            stopPlacement: 'swing-low',
            higherTimeframeBias: 'intraday-bullish-reversal',
            liquidityPool: 'asia-or-london-low',
            liquidityLabel: 'Asia / London session low',
            drawOnLiquidity: ['asia-high', 'london-high', 'intraday-buy-side']
          }
        },
        sweepTimestamp: second.timestamp,
        triggerTimestamp: third.timestamp,
        sessionRanges,
        metadata: {
          tradingDate,
          sessionHigh,
          sessionLow,
          signalSide: 'long',
          amdContext
        }
      };
    }
  }

  return {
    found: false,
    reason: 'No qualifying post-9AM session sweep plus 1-minute FVG reversal detected yet',
    sessionRanges,
    metadata: {
      tradingDate,
      sessionHigh,
      sessionLow,
      amdContext
    }
  };
}

function detectSignalFromCandles(candles, rawConfig, state) {
  const strategySlug = rawConfig.detectorStrategySlug || rawConfig.strategySlug || 'live-9am-sweep';
  if (require('./candle-context.cjs').rollDay(candles)) return { found: false, reason: 'Contract-roll session excluded; warming new instrument context' };
  candles = require('./candle-context.cjs').context(candles, rawConfig);
  // Non-blocking research: attach breakout context without modifying incumbent entries.
  const withBreakoutResearch = (result) => {
    if (result?.found && strategySlug === 'nq-fresh-level-retest') {
      result.metadata = {
        ...(result.metadata || {}),
        consolidationExpansion: require('./consolidation-expansion.cjs').assess(candles, result.setup?.side)
      };
    }
    return result;
  };
  if (strategySlug === 'nq-fresh-level-retest') return withBreakoutResearch(require('./fresh-level-retest.cjs').detect(candles, rawConfig, state));
  if (strategySlug === require('./vwap-stretch.cjs').SLUG) {
    const s = require('./vwap-stretch.cjs').detect(candles, rawConfig, state);
    if (!s.found) return s;
    return {found:true,triggerTimestamp:s.triggerTimestamp,metadata:s,rangeSummary:[],sessionRanges:{},
      setup:{...buildResearchSetup({rawConfig,tradingDate:s.date,session:'Cash VWAP',side:'long',entry:s.entry,stop:s.stop,targets:s.targets,
        thesis:'Video-inspired long mean reversion at 2 ATR below candle-based session VWAP; mechanics independently specified.',
        entryModel:'vwap-stretch-reversion',gapType:'vwap-stretch',entryTimeframe:'M1',activationTime:'Full cash session after warmup',
        referenceSessions:['cash-session'],liquidityPool:'session-vwap',liquidityLabel:String(s.vwap),drawOnLiquidity:['session-vwap']}),
        execution:'next-bar-market',exitAllAtTarget:true,flattenAt:s.flattenAt,
        minimumEntryRewardRisk:1,maximumAdverseEntryRiskFraction:0.25,
        signalAvailableAt:new Date(Date.parse(s.triggerTimestamp)+60000).toISOString(),orderExpiresAt:new Date(Math.min(Date.parse(s.triggerTimestamp)+360000,Date.parse(s.flattenAt))).toISOString()}};
  }
  const detectors = {
    'live-9am-sweep': detectNineAmSignalFromCandles,
    'live-9am-sweep-min-stop': detectNineAmSignalFromCandles
  };
  const detector = detectors[strategySlug];
  if (!detector) {
    throw new Error(`No detector registered for strategy: ${strategySlug}`);
  }
  return detector(candles, rawConfig, state);
}

function signalKey(signal) {
  return [
    signal.setup.date,
    signal.setup.side,
    signal.sweepTimestamp,
    signal.triggerTimestamp,
    signal.setup.entry,
    signal.setup.stop
  ].join('|');
}

function loadLiveState(baseState) {
  return {
    ...baseState,
    live: {
      ...(baseState.live || {}),
      openSignalKey: baseState.live?.openSignalKey || null,
      openPlan: baseState.live?.openPlan || null,
      openTriggeredAt: baseState.live?.openTriggeredAt || null,
      signalHistory: Array.isArray(baseState.live?.signalHistory) ? baseState.live.signalHistory : [],
      heartbeat: baseState.live?.heartbeat || null,
      portfolioRisk: baseState.live?.portfolioRisk || null,
      researchContext: baseState.live?.researchContext || null
    }
  };
}

function saveLiveState(filePath, state) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures and surface the original persistence error.
    }
    throw error;
  }
}

const TERMINAL_UNFILLED_REASONS = new Set([
  'entry gap beyond stop or target',
  'entry gap exceeds risk budget',
  'entry gap below minimum reward/risk',
  'entry drift exceeds limit',
  'entry leaves insufficient structural stop distance',
  'entry after session exit deadline',
  'invalid order timing',
  'order expired'
]);

function clearTerminalUnfilledPlan(state, lifecycle) {
  if (lifecycle?.status !== 'not-filled' || !TERMINAL_UNFILLED_REASONS.has(lifecycle.exitReason)) {
    return false;
  }
  if (!state.live?.openPlan) return false;
  state.live.openSignalKey = null;
  state.live.openPlan = null;
  state.live.openLifecycle = null;
  state.live.openTriggeredAt = null;
  state.live.portfolioRisk = null;
  return true;
}

function formatSignalSummary(signal, plan) {
  const ranges = signal.sessionRanges;
  const side = signal.setup.side.toUpperCase();
  const rangeLines = Array.isArray(signal.rangeSummary)
    ? signal.rangeSummary.map((range) => `${range.label}: H ${range.high} / L ${range.low}`)
    : ranges?.asia && ranges?.london
      ? [`Asia: H ${ranges.asia.high} / L ${ranges.asia.low}`, `London: H ${ranges.london.high} / L ${ranges.london.low}`]
      : [];
  return [
    `Signal: ${side} ${signal.setup.symbol} ${signal.setup.date}`,
    `Entry ${signal.setup.entry} | Stop ${signal.setup.stop} | Targets ${signal.setup.targets.join(', ')}`,
    ...rangeLines,
    `Contracts: ${plan.sizing.maxContracts} | Risk ${plan.sizing.actualRiskUsd}`
  ].join('\n');
}

function formatOpenTradeSummary(plan, lifecycle) {
  return [
    `Open trade status: ${lifecycle.status}`,
    `Filled at: ${lifecycle.filledAt || 'waiting for fill'}`,
    `Targets hit: ${lifecycle.targetsHit.length ? lifecycle.targetsHit.join(', ') : 'none'}`,
    `Remaining: ${lifecycle.remainingContracts}`,
    `Realized: ${lifecycle.realizedPnlUsd}`,
    `Unrealized: ${lifecycle.unrealizedPnlUsd}`,
    `Mark: ${lifecycle.markPrice ?? 'n/a'}`,
    `Exit reason: ${lifecycle.exitReason}`
  ].join('\n');
}

function buildPlanFromSignal(signal, rawConfig, state) {
  const setup = require('./execution-policy.cjs').deadlines({ ...signal.setup }, signal.triggerTimestamp);
  const plan = buildTradePlan(normalizeSetup(setup, rawConfig), rawConfig, state);
  if (signal.setup.exitAllAtTarget) {
    if (plan.targets.length !== 1) throw new Error('Full-position exit requires exactly one target.');
    plan.targets[0].closeFraction = 1;
  }
  plan.strategyFamily = rawConfig.strategyFamily || null;
  plan.signalContext = signal.metadata || null;
  return plan;
}

module.exports = {
  buildPlanFromSignal,
  clearTerminalUnfilledPlan,
  computeAmdContext,
  detectSignalFromCandles,
  fetchLiveCandles,
  formatOpenTradeSummary,
  formatSignalSummary,
  loadLiveState,
  normalizeStrategyConfig,
  saveLiveState,
  signalKey,
  trackTradeLifecycle
};
