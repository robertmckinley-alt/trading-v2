const test = require('node:test');
const assert = require('node:assert/strict');
const { session } = require('../lib/orb-session.cjs');
const { backtestProvenance } = require('../lib/backtest-provenance.cjs');
test('cash calendar handles holidays, exceptional closure, shortened days and unknown years', () => {
  assert.equal(session('2026-09-07').open, false);
  assert.equal(session('2025-01-09').open, false);
  assert.equal(session('2026-09-08').closeMinute, 960);
  assert.equal(session('2025-11-28').closeMinute, 780);
  assert.equal(session('2027-01-04').known, false);
});
test('coverage accepts a complete shortened session, but catches a missing candle', () => {
  const candles = Array.from({ length: 210 }, (_, i) => ({ timestamp: new Date(Date.parse('2025-11-28T14:30:00Z') + i * 60000).toISOString(), open: 100, high: 101, low: 99, close: 100, volume: 10 }));
  const window = { start: '2025-11-27T00:00:00Z', end: '2025-11-29T00:00:00Z' };
  assert.equal(backtestProvenance(candles, window).coverage.complete, true);
  assert.equal(backtestProvenance(candles.slice(1), window).coverage.complete, false);
});
