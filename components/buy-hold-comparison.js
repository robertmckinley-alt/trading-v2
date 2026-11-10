'use client';
import { useEffect, useState } from 'react';
const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
function Curve({ strategy, result }) {
  const series = [strategy.equityCurve, result.curve.map(p => p.nqEquity), result.curve.map(p => p.cashEquity)];
  const values = series.flat(); const min = Math.min(50000, ...values); const max = Math.max(50000, ...values); const span = Math.max(1, max - min);
  return <figure><figcaption>{strategy.name} · daily closing equity</figcaption><svg viewBox="0 0 600 180" role="img" aria-label={`${strategy.name} equity compared with both buy-and-hold proxies`}><text x="0" y="12" fill="currentColor">{usd(max)}</text><text x="0" y="164" fill="currentColor">{usd(min)}</text>{series.map((s, i) => <polyline key={i} fill="none" stroke={['#2563eb', '#e8790c', '#737373'][i]} strokeWidth="2" points={s.map((v, j) => `${90+j/Math.max(1,s.length-1)*505},${18+(max-v)/span*145}`).join(' ')} />)}</svg><small>{result.curve[0].date} → {result.curve.at(-1).date} · Blue: strategy · Orange: one NQ · Gray: cash-exposure proxy</small></figure>;
}
export default function Comparison() {
  const [data, setData] = useState(null); const [message, setMessage] = useState('Loading comparison…');
  useEffect(() => {
    let stopped = false, timer;
    async function refresh() {
      try { const r = await fetch('/api/buy-hold', { cache: 'no-store', signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(); const p = await r.json(); if (!stopped) { setData(p.result); setMessage(p.message || 'Benchmark not ready.'); } }
      catch { if (!stopped) setMessage('Comparison connection unavailable.'); }
      if (!stopped) timer = setTimeout(refresh, 30000);
    }
    refresh(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  if (!data) return <aside className="research-safety"><strong>{message}</strong><p>The comparison requires the exact cached candles used by the completed backtest. No benchmark values are estimated from strategy trades.</p></aside>;
  const strategies = [...data.strategies].filter(s => !s.unavailable).sort((a,b) => b.netPnlUsd-a.netPnlUsd);
  return <><p>{data.candles.toLocaleString()} verified matching candles · {data.firstCandleAt} through {data.lastCandleAt} · {data.rolls} contract changes</p><p>Historical report: {data.reportGeneratedAt}</p><aside className="backtest-disclosure"><strong>These are continuous-futures approximations, not QQQ total return.</strong><p>{data.methodology}</p></aside>
    <div className="backtest-metrics"><div><strong>One NQ held · after modeled costs</strong><p>{usd(data.nq.netPnlUsd)} · {data.nq.returnPercent}%</p><p>Minute-close drawdown {usd(data.nq.maxDrawdownUsd)}</p></div><div><strong>$50,000 cash-exposure price proxy</strong><p>{usd(data.cashProxy.netPnlUsd)} · {data.cashProxy.returnPercent}%</p><p>Minute-close drawdown {usd(data.cashProxy.maxDrawdownUsd)}</p></div></div>
    <p>{strategies.filter(s=>s.vsNqUsd>0).length} of {strategies.length} strategies outperform the one-NQ proxy on net dollars. This does not establish a risk-adjusted advantage or future profitability.</p>
    <div className="orb-forward-table"><table><caption>All historical strategies · $50,000 starting equity</caption><thead><tr><th>Strategy</th><th>Trades</th><th>Net P&amp;L</th><th>Return</th><th>Closed-trade DD</th><th>Vs one NQ</th><th>Vs cash proxy</th></tr></thead><tbody>{strategies.map(s=><tr key={s.slug}><th><a href={`#compare-${s.slug}`}>{s.name}</a></th><td>{s.trades}</td><td>{usd(s.netPnlUsd)}</td><td>{s.returnPercent}%</td><td>{usd(s.maxDrawdownUsd)}</td><td>{usd(s.vsNqUsd)}</td><td>{usd(s.vsCashProxyUsd)}</td></tr>)}</tbody></table></div>
    <p>Positive “Vs” means the strategy earned more. Strategies retain their configured research sizing. Equal starting capital does not mean equal exposure. Drawdown measurement differs as labeled.</p>
    <div className="orb-forward-grid">{strategies.map(s=><article className="backtest-card" key={s.slug} id={`compare-${s.slug}`}><Curve strategy={s} result={data}/></article>)}</div></>;
}
