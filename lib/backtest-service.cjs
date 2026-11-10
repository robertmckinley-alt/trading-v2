const fs = require('fs');
const path = require('path');
const { runAllBacktests } = require('./backtest-engine.cjs');
const { fetchDatabentoHistoricalCandles, historicalSinceYearWindow, historicalWindow, historicalYearWindow } = require('./historical-data.cjs');
const { normalizeConfig } = require('./trader-core.cjs');
const { BACKTEST_STRATEGIES } = require('./strategy-registry.cjs');
const { backtestProvenance } = require('./backtest-provenance.cjs');
const { buildBacktestValidation } = require('./backtest-validation.cjs');

function loadConfig() {
  return normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
}

function remoteBacktestUrls(env = process.env) {
  const direct = String(env.BACKTEST_SOURCE_URL || '').trim();
  const live = [env.LIVE_STATUS_SOURCE_URL, env.LIVE_STATUS_SOURCE_URLS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\/api\/live-status\/?(?:\?.*)?$/, '/api/backtest'));
  return [...new Set([direct, ...live].filter(Boolean))];
}

function remoteBacktestResultUrls(env = process.env) {
  return remoteBacktestUrls(env).map((value) => value.replace(/\/api\/backtest$/, '/api/backtest-results'));
}

function backtestConfigured(env = process.env) {
  return Boolean(env.DATABENTO_API_KEY || remoteBacktestUrls(env).length);
}

async function fetchRemoteBacktest(url, request, env = process.env, fetchImpl = fetch) {
  const token = env.LIVE_STATUS_TOKEN || env.BACKTEST_SOURCE_TOKEN;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: AbortSignal.timeout(290_000)
  });
  if (!response.ok) throw new Error(`Remote backtest service responded ${response.status}.`);
  const data = await response.json();
  if (!data?.ok || !data?.result) throw new Error(data?.error || 'Remote backtest service returned an invalid result.');
  return data.result;
}

async function getBacktestStatus(options = {}) {
  const env = options.env || process.env;
  const urls = remoteBacktestResultUrls(env);
  if (!urls.length) return { result: null, progress: null, pending: false };
  const token = env.LIVE_STATUS_TOKEN || env.BACKTEST_SOURCE_TOKEN;
  try {
    return await Promise.any(urls.map(async (url) => {
      const response = await (options.fetchImpl || fetch)(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`Remote backtest results responded ${response.status}.`);
      const data = await response.json();
      if (!data?.ok && !data?.pending) throw new Error(data?.error || 'No cached backtest result is ready.');
      return { result: data.result || null, progress: data.progress || null, pending: Boolean(data.pending), error: data.error || null };
    }));
  } catch {
    return { result: null, progress: null, pending: false, error: 'The backtest server is unavailable. Previously saved results may be out of date.' };
  }
}

async function getCachedBacktest(options = {}) {
  return (await getBacktestStatus(options)).result;
}

async function requestBacktestRefresh(options = {}) {
  const env = options.env || process.env;
  const urls = remoteBacktestUrls(env);
  if (!urls.length) return { pending: false, result: await executeBacktest(options) };
  const token = env.LIVE_STATUS_TOKEN || env.BACKTEST_SOURCE_TOKEN;
  // Mutations try one bridge at a time: alternate URLs may point at the same worker.
  let lastError;
  for (const url of urls) {
    try {
      const response = await (options.fetchImpl || fetch)(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ startYear: options.startYear || 2025, background: true }),
        signal: AbortSignal.timeout(10_000), cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `Backtest start failed (${response.status}).`);
      return { pending: Boolean(data.pending), result: data.result || null, progress: data.progress || null };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function executeBacktest(options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const window = options.startYear
    ? historicalSinceYearWindow(options.startYear, now)
    : options.year
      ? historicalYearWindow(options.year, now)
      : historicalWindow(options.days || 60, now);
  const request = options.startYear ? { startYear: window.startYear } : options.year ? { year: window.year } : { days: window.days };
  if (!env.DATABENTO_API_KEY) {
    const urls = remoteBacktestUrls(env);
    if (!urls.length) throw new Error('Backtesting needs DATABENTO_API_KEY on Vercel or the VPS backtest bridge enabled.');
    return Promise.any(urls.map((url) => fetchRemoteBacktest(url, request, env, options.fetchImpl || fetch)));
  }
  options.onProgress?.({ phase: 'downloading', window });
  const historical = await fetchDatabentoHistoricalCandles({
    window, env, fetchImpl: options.fetchImpl, onProgress: options.onProgress,
    cacheDir: options.cacheDir || env.HISTORICAL_CACHE_DIR || path.join(env.VERCEL ? require('node:os').tmpdir() : process.cwd(), 'runtime', 'historical-candles'),
    forceRefresh: options.forceRefresh
  });
  options.onProgress?.({ phase: 'download-completed', candles: historical.candles.length });
  const config = loadConfig();
  const result = {
    ...runAllBacktests(historical.candles, config, { onProgress: options.onProgress }),
    source: historical.source,
    symbol: historical.symbol,
    window: historical.window
  };
  options.onProgress?.({ phase: 'evaluating', message: 'Building validation diagnostics.' });
  const provenance = backtestProvenance(historical.candles, result.window);
  result.provenance = provenance;
  result.validation = buildBacktestValidation(result, { ...provenance, config, definitions: BACKTEST_STRATEGIES });
  try { result.buyHold = require('./buy-hold.cjs').calculate(historical.candles, result, config); }
  catch (error) { result.buyHoldError = error.message; }
  return result;
}

module.exports = { backtestConfigured, executeBacktest, getBacktestStatus, getCachedBacktest, requestBacktestRefresh, remoteBacktestResultUrls, remoteBacktestUrls };
