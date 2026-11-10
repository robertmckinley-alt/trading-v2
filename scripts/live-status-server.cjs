#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');

const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  try {
    require('dotenv').config({ path: envPath, override: false });
  } catch (error) {
    console.warn(`Could not load env file ${envPath}: ${error.message}`);
  }
}

const { getLocalStrategySnapshots } = require('../lib/live-status.cjs');
const { readBacktestResult, runBacktestWorker } = require('../lib/backtest-worker.cjs');
const { BACKTEST_STRATEGIES } = require('../lib/strategy-registry.cjs');

const port = Number(process.env.LIVE_STATUS_PORT || 3210);
const bridgeSecurity = require('../lib/bridge-security.cjs');
const { host, token: statusToken } = bridgeSecurity.settings(bridgeSecurity.listenerEnvironment(path.resolve(__dirname,'..')));
const backtestCachePath = process.env.BACKTEST_CACHE_PATH || path.join(__dirname, '..', 'runtime', 'backtest-results.json');
const backtestRefreshMs = Math.max(60 * 60 * 1000, Number(process.env.BACKTEST_REFRESH_MS || 24 * 60 * 60 * 1000));
const backtestStartYear = Number(process.env.BACKTEST_START_YEAR || 2025);
let backtestRefreshPromise = null;
let backtestStartedAt = null;

function backtestStatus() {
  let progress = null;
  try { progress = readBacktestResult(`${backtestCachePath}.progress.json`); } catch { /* No progress before first run. */ }
  if (backtestRefreshPromise && (!progress || progress.startedAt < backtestStartedAt)) {
    progress = { phase: 'starting', startedAt: backtestStartedAt, updatedAt: backtestStartedAt };
  }
  return { pending: Boolean(backtestRefreshPromise), progress };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) reject(new Error('Request is too large.'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}

function refreshBacktestCache(options = { startYear: backtestStartYear }) {
  if (!process.env.DATABENTO_API_KEY) return Promise.resolve(null);
  if (backtestRefreshPromise) return backtestRefreshPromise;
  backtestStartedAt = new Date().toISOString();
  const label = options.startYear ? `${options.startYear}-to-present` : options.year ? `${options.year} year-to-date` : `${options.days || 60}-day`;
  console.log(`[${new Date().toISOString()}] starting ${label} backtest refresh in worker`);
  backtestRefreshPromise = runBacktestWorker({ ...options, cachePath: backtestCachePath })
    .then((result) => {
      console.log(`[${new Date().toISOString()}] refreshed ${label} backtest cache`);
      return result;
    })
    .catch((error) => {
      console.error(`[${new Date().toISOString()}] backtest refresh failed: ${error.message}`);
      return null;
    })
    .finally(() => { backtestRefreshPromise = null; });
  return backtestRefreshPromise;
}

function refreshBacktestIfDue() {
  try {
    const cached = readBacktestResult(backtestCachePath);
    const generatedAt = Date.parse(cached.generatedAt);
    const cachedSlugs = new Set((cached.strategies || []).map((strategy) => strategy.slug));
    const hasEveryStrategy = BACKTEST_STRATEGIES.every((strategy) => cachedSlugs.has(strategy.slug));
    if (hasEveryStrategy && Number.isFinite(generatedAt) && Date.now() - generatedAt < backtestRefreshMs) return Promise.resolve(null);
  } catch { /* Missing or invalid cache must be rebuilt. */ }
  return refreshBacktestCache({ startYear: backtestStartYear });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), pid: process.pid }));
    return;
  }

  if (!bridgeSecurity.authorized(req.headers.authorization, statusToken)) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  if (pathname === '/api/backtest' && req.method === 'POST') {
    try {
      const body = await readRequestJson(req);
      if (!process.env.DATABENTO_API_KEY) throw new Error('Historical data access is not configured on this server.');
      const options = body.startYear
        ? { startYear: body.startYear }
        : body.year
          ? { year: body.year }
          : { days: body.days || 60 };
      const promise = refreshBacktestCache(options);
      if (body.background === true) {
        sendJson(res, 202, { ok: true, ...backtestStatus() });
      } else {
        const result = await promise;
        if (!result) throw new Error('Backtest failed; inspect the progress report.');
        sendJson(res, 200, { ok: true, result, ...backtestStatus() });
      }
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === '/api/backtest-results' && req.method === 'GET') {
    try {
      if (!fs.existsSync(backtestCachePath)) {
        void refreshBacktestCache();
        sendJson(res, 202, { ok: true, result: null, ...backtestStatus() });
        return;
      }
      sendJson(res, 200, { ok: true, result: require('../lib/backtest-dashboard-report.cjs').readReport(backtestCachePath), ...backtestStatus() });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === '/api/buy-hold' && req.method === 'GET') {
    try {
      const report = readBacktestResult(backtestCachePath);
      const saved = report.buyHold || readBacktestResult(path.join(__dirname, '..', 'runtime', 'buy-hold-results.json'));
      if (!saved || saved.dataFingerprint !== report.provenance?.dataFingerprint || saved.reportGeneratedAt !== report.generatedAt) throw new Error('Benchmark needs rebuilding against the latest completed report.');
      sendJson(res, 200, { ok: true, result: saved });
    } catch { sendJson(res, 200, { ok: true, result: null, message: 'Benchmark not ready. Run node scripts/build-buy-hold.cjs on the VPS, or wait for the next completed backtest.' }); }
    return;
  }

  if (pathname !== '/api/live-status') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  try {
    const payload = getLocalStrategySnapshots();
    payload.feed = require('../lib/market-feed-status.cjs').status(path.resolve(__dirname, '..'));
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(port, host, () => {
  const ensureFeed = () => require('../lib/market-feed-status.cjs').ensureFeed(path.resolve(__dirname, '..'));
  ensureFeed();
  setInterval(ensureFeed, 60000).unref();
  console.log(`Live status server listening on http://${host}:${port}/api/live-status`);
  void refreshBacktestIfDue();
  setInterval(() => { void refreshBacktestIfDue(); }, Math.min(backtestRefreshMs, 60 * 60 * 1000)).unref();
});
