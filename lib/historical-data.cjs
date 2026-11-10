const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const HISTORICAL_URL = 'https://hist.databento.com/v0/timeseries.get_range';
const PRICE_SCALE = 1_000_000_000;
const MAX_CANDLES_PER_REQUEST = 150_000;
const MAX_TOTAL_CANDLES = 1_000_000;
const REQUEST_CHUNK_DAYS = 30;

function price(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return NaN;
  return Math.abs(number) > 1_000_000 ? number / PRICE_SCALE : number;
}

function timestamp(value) {
  if (typeof value === 'number' || /^\d{16,}$/.test(String(value || ''))) {
    const nanoseconds = Number(value);
    if (!Number.isFinite(nanoseconds)) return null;
    return new Date(nanoseconds / 1_000_000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRecord(record) {
  const header = record.hd || record.header || {};
  const normalized = {
    timestamp: timestamp(record.ts_event ?? record.timestamp ?? header.ts_event ?? header.timestamp),
    open: price(record.open),
    high: price(record.high),
    low: price(record.low),
    close: price(record.close),
    volume: Number(record.volume || 0),
    instrumentId: record.instrument_id ?? record.instrumentId ?? header.instrument_id ?? header.instrumentId ?? null
  };
  if (!normalized.timestamp || [normalized.open, normalized.high, normalized.low, normalized.close].some((value) => !Number.isFinite(value))) {
    return null;
  }
  return normalized;
}

function parseDatabentoJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let records;
  if (text.startsWith('[')) {
    records = JSON.parse(text);
  } else {
    records = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Databento returned invalid JSON on line ${index + 1}.`);
      }
    });
  }

  const byTimestamp = new Map();
  for (const record of records) {
    const candle = normalizeRecord(record);
    if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  const candles = [...byTimestamp.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (candles.length > MAX_CANDLES_PER_REQUEST) throw new Error(`Historical response exceeded the ${MAX_CANDLES_PER_REQUEST.toLocaleString()} candle per-request safety limit.`);
  return candles;
}

function historicalWindow(days = 60, now = new Date()) {
  const safeDays = Math.max(10, Math.min(366, Math.round(Number(days) || 60)));
  const end = new Date(now.getTime() - (20 * 60_000));
  end.setUTCSeconds(0, 0);
  const start = new Date(end.getTime() - (safeDays * 24 * 60 * 60_000));
  return { days: safeDays, start: start.toISOString(), end: end.toISOString() };
}

function historicalYearWindow(year = new Date().getUTCFullYear(), now = new Date()) {
  const requestedYear = Math.trunc(Number(year));
  const currentYear = now.getUTCFullYear();
  if (!Number.isFinite(requestedYear) || requestedYear < 2000 || requestedYear > currentYear) {
    throw new Error(`Historical year must be between 2000 and ${currentYear}.`);
  }
  const start = new Date(Date.UTC(requestedYear, 0, 1));
  const yearEnd = new Date(Date.UTC(requestedYear + 1, 0, 1));
  const delayedNow = new Date(now.getTime() - (20 * 60_000));
  delayedNow.setUTCSeconds(0, 0);
  const end = new Date(Math.min(yearEnd.getTime(), delayedNow.getTime()));
  if (end <= start) throw new Error(`Historical data for ${requestedYear} is not available yet.`);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  return { year: requestedYear, days, start: start.toISOString(), end: end.toISOString() };
}

function historicalSinceYearWindow(startYear = 2025, now = new Date()) {
  const requestedStartYear = Math.trunc(Number(startYear));
  const currentYear = now.getUTCFullYear();
  if (!Number.isFinite(requestedStartYear) || requestedStartYear < 2000 || requestedStartYear > currentYear) {
    throw new Error(`Historical start year must be between 2000 and ${currentYear}.`);
  }
  const start = new Date(Date.UTC(requestedStartYear, 0, 1));
  const end = new Date(now.getTime() - (20 * 60_000));
  end.setUTCSeconds(0, 0);
  if (end <= start) throw new Error(`Historical data beginning in ${requestedStartYear} is not available yet.`);
  const days = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  return {
    startYear: requestedStartYear,
    endYear: end.getUTCFullYear(),
    days,
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function splitHistoricalWindow(window, chunkDays = REQUEST_CHUNK_DAYS) {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const chunkMs = Math.max(1, Number(chunkDays)) * 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Historical window is invalid.');
  const chunks = [];
  for (let cursor = start; cursor < end; cursor += chunkMs) {
    chunks.push({
      start: new Date(cursor).toISOString(),
      end: new Date(Math.min(end, cursor + chunkMs)).toISOString()
    });
  }
  return chunks;
}

async function fetchDatabentoChunk(options, window) {
  const params = new URLSearchParams({
    dataset: options.dataset || 'GLBX.MDP3',
    symbols: options.symbol || 'NQ.v.0',
    schema: 'ohlcv-1m',
    stype_in: 'continuous',
    start: window.start,
    end: window.end,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true'
  });
  const response = await require('./historical-retry.cjs').readHistoricalResponse(`${HISTORICAL_URL}?${params}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}` },
    cache: 'no-store'
  }, options);
  if (!response.ok) {
    const raw = response.body;
    // Only this explicit provider range error permits one bounded retry.
    let errorDetail;
    try { errorDetail = JSON.parse(raw).detail; } catch { /* Preserve ordinary error. */ }
    const match = errorDetail?.case === 'data_end_after_available_end'
      ? String(errorDetail.message || '').match(/data available up to ['"]([^'"]+)['"]/) : null;
    const cutoff = match ? Date.parse(match[1].replace(' ', 'T')) : NaN;
    if (response.status === 422 && !options.availabilityRetried && Number.isFinite(cutoff)
      && cutoff < Date.parse(window.end)) {
      options.onProgress?.({ phase: 'availability-cutoff', requestedEnd: window.end, availableEnd: new Date(cutoff).toISOString() });
      if (cutoff <= Date.parse(window.start)) return { candles: [], end: cutoff };
      const retried = await fetchDatabentoChunk({ ...options, availabilityRetried: true },
        { ...window, end: new Date(cutoff).toISOString() });
      return { ...retried, end: cutoff };
    }
    const detail = raw.slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(`Databento historical request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }
  return { candles: parseDatabentoJson(response.body), end: Date.parse(window.end) };
}

async function fetchDatabentoHistoricalCandles(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const env = options.env || process.env;
  const apiKey = String(options.apiKey || env.DATABENTO_API_KEY || '');
  const window = options.window || historicalWindow(options.days || 60, options.now || new Date());
  const byTimestamp = new Map();
  // Cache complete UTC days independently so overlapping date ranges can reuse them.
  // The current partial day stays uncached because more candles may still arrive.
  const identity = JSON.stringify({ version: 1, dataset: options.dataset || 'GLBX.MDP3', symbol: options.symbol || 'NQ.v.0', schema: 'ohlcv-1m', stype: 'continuous' });
  const cacheRoot = options.cacheDir ? path.join(options.cacheDir, createHash('sha256').update(identity).digest('hex')) : null;
  const requestedEnd = Date.parse(window.end);
  let availableEnd = requestedEnd;
  const today = Date.parse((options.now || new Date()).toISOString().slice(0, 10));
  const segments = [];
  for (let cursor = Date.parse(window.start); cursor < requestedEnd;) {
    const dayStart = Math.floor(cursor / 86_400_000) * 86_400_000;
    const end = Math.min(dayStart + 86_400_000, requestedEnd);
    const filename = cacheRoot ? path.join(cacheRoot, `${new Date(dayStart).toISOString().slice(0, 10)}.json`) : null;
    let hit = false;
    if (filename && !options.forceRefresh) {
      try {
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const checksum = createHash('sha256').update(JSON.stringify(saved.candles)).digest('hex');
        if (saved.identity === identity && saved.dayStart === dayStart && Array.isArray(saved.candles) && saved.checksum === checksum && require('./session-quality.cjs').cacheDayComplete(dayStart, saved.candles, options.symbol || 'NQ.v.0')) {
          for (const candle of saved.candles) {
            const at = Date.parse(candle.timestamp);
            if (at >= cursor && at < end) byTimestamp.set(candle.timestamp, candle);
          }
          hit = true;
        }
      } catch { /* Missing or corrupt cache entries are fetched again. */ }
    }
    segments.push({ start: cursor, end, dayStart, filename, hit });
    cursor = end;
  }
  options.onProgress?.({ phase: 'cache-read', cachedDays: segments.filter((segment) => segment.hit).length, totalDays: segments.length });
  // Merge adjacent misses into bounded requests; initial downloads still use 30-day batches.
  const missingWindows = [];
  for (const segment of segments.filter((item) => !item.hit)) {
    const last = missingWindows.at(-1);
    if (last && last.end === segment.start) last.end = segment.end;
    else missingWindows.push({ start: segment.start, end: segment.end });
  }
  const requests = missingWindows.flatMap((range) => splitHistoricalWindow({ start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() }, options.chunkDays));
  if (requests.length && !apiKey) throw new Error('Historical Databento access is not configured and requested candles are missing from the local cache.');
  for (const chunk of requests) {
    if (Date.parse(chunk.start) >= availableEnd) break;
    const fetched = await fetchDatabentoChunk({ ...options, apiKey, fetchImpl },
      { ...chunk, end: new Date(Math.min(Date.parse(chunk.end), availableEnd)).toISOString() });
    if (fetched.end < Date.parse(chunk.end)) availableEnd = Math.min(availableEnd, fetched.end);
    const candles = fetched.candles;
    for (const candle of candles) byTimestamp.set(candle.timestamp, candle);
    if (cacheRoot) {
      fs.mkdirSync(cacheRoot, { recursive: true });
      const chunkStart = Date.parse(chunk.start);
      const chunkEnd = fetched.end;
      const daily = new Map();
      for (const candle of candles) {
        const day = Math.floor(Date.parse(candle.timestamp) / 86_400_000) * 86_400_000;
        if (!daily.has(day)) daily.set(day, []);
        daily.get(day).push(candle);
      }
      for (const segment of segments) {
        if (segment.hit || segment.start !== segment.dayStart || segment.end !== segment.dayStart + 86_400_000 || segment.end > today || segment.start < chunkStart || segment.end > chunkEnd) continue;
        const dayCandles = daily.get(segment.dayStart) || [];
        if (!require('./session-quality.cjs').cacheDayComplete(segment.dayStart, dayCandles, options.symbol || 'NQ.v.0')) continue;
        const saved = { identity, dayStart: segment.dayStart, candles: dayCandles, checksum: createHash('sha256').update(JSON.stringify(dayCandles)).digest('hex') };
        const temporary = `${segment.filename}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(saved));
        fs.renameSync(temporary, segment.filename);
      }
    }
    options.onProgress?.({ phase: 'download-chunk', through: new Date(fetched.end).toISOString(), candles: byTimestamp.size });
    if (byTimestamp.size > MAX_TOTAL_CANDLES) {
      throw new Error(`Historical response exceeded the ${MAX_TOTAL_CANDLES.toLocaleString()} total candle safety limit.`);
    }
  }
  if (byTimestamp.size > MAX_TOTAL_CANDLES) throw new Error(`Historical response exceeded the ${MAX_TOTAL_CANDLES.toLocaleString()} total candle safety limit.`);
  const candles = [...byTimestamp.values()].filter(c => Date.parse(c.timestamp) < availableEnd).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (!candles.length) throw new Error('Databento returned no one-minute NQ candles for this period.');
  return {
    source: 'Databento GLBX.MDP3',
    symbol: options.symbol || 'NQ.v.0',
    dataset: options.dataset || 'GLBX.MDP3',
    schema: 'ohlcv-1m',
    window: { ...window, end: new Date(availableEnd).toISOString(), days: Math.ceil((availableEnd - Date.parse(window.start)) / 86400000), ...(availableEnd < requestedEnd ? { requestedEnd: window.end, availabilityClamped: true } : {}) },
    candles
  };
}

module.exports = { fetchDatabentoHistoricalCandles, historicalSinceYearWindow, historicalWindow, historicalYearWindow, parseDatabentoJson, splitHistoricalWindow };
