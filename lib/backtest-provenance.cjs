const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { groupTradingDays } = require('./backtest-engine.cjs');
const { session, VERSION } = require('./orb-session.cjs');

function backtestProvenance(candles, window) {
  const code = createHash('sha256');
  for (const name of ['backtest-engine.cjs', 'backtest-service.cjs', 'backtest-provenance.cjs', 'backtest-validation.cjs', 'trader-core.cjs', 'live-trader.cjs', 'strategy-registry.cjs', 'orb-session.cjs', 'historical-data.cjs', 'execution-policy.cjs', 'candle-context.cjs', 'session-quality.cjs', 'constant-risk-metrics.cjs', 'research-lab.cjs', 'strategy-evaluation.cjs']) {
    code.update(name).update(fs.readFileSync(path.join(__dirname, name)));
  }
  const data = createHash('sha256');
  for (const file of ['vwap-stretch.cjs','vwap-backtest.cjs','fresh-level-retest.cjs','fresh-level-backtest.cjs']) code.update(fs.readFileSync(path.join(__dirname,file)));
  code.update(fs.readFileSync(path.join(__dirname, 'ny-time.cjs')));
  for (const candle of candles) data.update(JSON.stringify(candle)).update('\n');
  const sessions = groupTradingDays(candles).filter(([date, records]) => session(date).open && records.some((record) => record.minute >= 570 && record.minute < session(date).closeMinute));
  const tradingDates = sessions.map(([date]) => date);
  const issues = [];
  for (const [date, records] of sessions) {
    const coverage = require('./session-quality.cjs').cashCoverage(date, records.map(r=>r.candle));
    if (!coverage.complete) issues.push(`${date}: ${coverage.actual}/${coverage.expected} cash-session minutes; ${coverage.reason}; excluded from simulation.`);
  }
  const known = new Set(tradingDates);
  // A reviewed closure is not a missing session. Unsupported years fail closed.
  for (let time = Date.parse(window.start.slice(0, 10)); time < Date.parse(window.end.slice(0, 10)); time += 86400000) {
    const day = new Date(time);
    const date = day.toISOString().slice(0, 10);
    if (!session(date).known || (session(date).open && !known.has(date))) {
      issues.push(`${date}: missing cash session or unsupported calendar date.`);
    }
  }
  return { executionVersion: 'bounded-fill-v1', calendarVersion: VERSION, codeHash: code.digest('hex'), dataFingerprint: data.digest('hex'),
    tradingDates, coverage: { complete: issues.length === 0 && sessions.length > 0, issues,
      scope: 'Reviewed 2025/2026 cash-session calendar, including early closes. Not a full CME-hours audit.' } };
}

module.exports = { backtestProvenance };
