const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const capital = 50000;
const round = n => Math.round(n * 100) / 100;
function fingerprint(candles) { const h = createHash('sha256'); for (const c of candles) h.update(JSON.stringify(c)).update('\n'); return h.digest('hex'); }
function calculate(candles, report, config) {
  if (!candles.length || candles.some(c => c.instrumentId == null || ![c.open, c.close].every(v => Number.isFinite(v) && v > 0))) throw new Error('Benchmark requires valid prices and contract IDs on every candle.');
  if (fingerprint(candles) !== report.provenance?.dataFingerprint) throw new Error('Cached candles do not exactly match the completed backtest. Refresh the historical report before comparing.');
  const multiplier = config.tickValueUsd / config.tickSize;
  const roundTrip = config.commissionPerContractUsd + 2 * config.slippageTicks * config.tickValueUsd;
  let points = 0, rolls = 0, prior = null, segmentCapital = capital, segmentEntry = candles[0].open;
  let futurePeak = capital, cashPeak = capital, futureDrawdown = 0, cashDrawdown = 0;
  const daily = new Map();
  for (const c of candles) {
    const roll = prior && String(prior.instrumentId) !== String(c.instrumentId);
    if (roll) { rolls++; segmentCapital *= prior.close / segmentEntry; segmentEntry = c.open; }
    points += c.close - (!prior || roll ? c.open : prior.close);
    const nqEquity = capital + points * multiplier - (rolls + 1) * roundTrip;
    const cashEquity = segmentCapital * c.close / segmentEntry;
    futurePeak = Math.max(futurePeak, nqEquity); cashPeak = Math.max(cashPeak, cashEquity);
    futureDrawdown = Math.max(futureDrawdown, futurePeak - nqEquity); cashDrawdown = Math.max(cashDrawdown, cashPeak - cashEquity);
    const date = c.timestamp.slice(0, 10);
    daily.set(date, { date, nqEquity: round(nqEquity), cashEquity: round(cashEquity) }); prior = c;
  }
  const curve = [...daily.values()];
  const end = curve.at(-1);
  const strategies = report.strategies.map(s => {
    if (!s.research) return { slug: s.slug, name: s.name, unavailable: true };
    const trades = s.research.trades;
    const byDay = new Map();
    for (const t of trades) { const date = (t.exitedAt || t.date).slice(0, 10); byDay.set(date, (byDay.get(date) || 0) + t.realizedPnlUsd); }
    let equity = capital;
    const equityCurve = curve.map(c => { equity += byDay.get(c.date) || 0; return round(equity); });
    const metrics = s.research.review.total;
    if (Math.abs(equity - capital - metrics.netPnlUsd) > .1) throw new Error(`Trade dates do not align with benchmark coverage for ${s.slug}.`);
    return { slug: s.slug, name: s.name, trades: metrics.trades, netPnlUsd: metrics.netPnlUsd,
      returnPercent: round(metrics.netPnlUsd / capital * 100), maxDrawdownUsd: metrics.maxDrawdownUsd,
      vsNqUsd: round(equity - end.nqEquity), vsCashProxyUsd: round(equity - end.cashEquity),
      sizing: s.research.sizing, equityCurve };
  });
  return { generatedAt: new Date().toISOString(), reportGeneratedAt: report.generatedAt, startingBalanceUsd: capital,
    firstCandleAt: candles[0].timestamp, lastCandleAt: candles.at(-1).timestamp, candles: candles.length,
    dataFingerprint: report.provenance.dataFingerprint, rolls, curve, strategies,
    nq: { netPnlUsd: round(end.nqEquity - capital), returnPercent: round((end.nqEquity / capital - 1) * 100), maxDrawdownUsd: round(futureDrawdown), modeledCostsUsd: round((rolls + 1) * roundTrip) },
    cashProxy: { netPnlUsd: round(end.cashEquity - capital), returnPercent: round((end.cashEquity / capital - 1) * 100), maxDrawdownUsd: round(cashDrawdown) },
    methodology: 'NQ continuous-contract approximation: close old contract at its last observed close and open the replacement at its first observed open. Contract-switch price gaps are excluded. Actual simultaneous roll prices are unavailable. One-NQ proxy includes configured entry/exit slippage and round-trip fees per segment; no margin enforcement, cash interest or financing. Cash-exposure proxy chains within-contract price returns, without transaction costs or dividends; it is not QQQ total return. Benchmark drawdown uses minute closes; strategy drawdown uses closed trades.' };
}
function fromCache(root, report, config) {
  const identity = JSON.stringify({ version: 1, dataset: 'GLBX.MDP3', symbol: 'NQ.v.0', schema: 'ohlcv-1m', stype: 'continuous' });
  const dir = path.join(process.env.HISTORICAL_CACHE_DIR || path.join(root, 'runtime', 'historical-candles'), createHash('sha256').update(identity).digest('hex'));
  const candles = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const day = Date.parse(name.slice(0, 10));
    if (day + 86400000 <= Date.parse(report.window.start) || day >= Date.parse(report.window.end)) continue;
    const data = JSON.parse(fs.readFileSync(path.join(dir, name)));
    if (data.identity !== identity || data.checksum !== createHash('sha256').update(JSON.stringify(data.candles)).digest('hex')) throw new Error('Historical cache checksum failed.');
    candles.push(...data.candles.filter(c => Date.parse(c.timestamp) >= Date.parse(report.window.start) && Date.parse(c.timestamp) < Date.parse(report.window.end)));
  }
  return calculate(candles.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), report, config);
}
module.exports = { calculate, fromCache, fingerprint };
