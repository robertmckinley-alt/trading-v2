'use client';

import Link from 'next/link';
import { useMemo, useState, useRef, useEffect } from 'react';
import { dashboardView, dashboardHistory, sessionDate, lifetimeView } from '../lib/dashboard-view.cjs';

const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' }) + ' ET' : 'Not recorded';
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
const shortDate = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const tone = value => value > 0 ? 'gain' : value < 0 ? 'loss' : '';
function StrategySection({ title, rows, variant }) {
  return <section className={`day-card trade-section ${variant}`}><header><div><span className="day-eyebrow">Lifetime paper results</span><h2>{title} <span className="day-count">{rows.length}</span></h2></div><strong className={variant}>{money(rows.reduce((n,s)=>n+s.journal.realizedPnlUsd,0))}</strong></header>
    {!rows.length ? <p className="day-empty">No strategies in this group.</p> : rows.map(s => <Link className="day-idle-row lifetime-row" key={s.slug} href={s.route || `/strategies/${s.slug}`}><span><strong>{s.name}</strong><small>{s.ticker} · {s.journal.trades} closed trades · {s.journal.trades ? Math.round(s.journal.wins / s.journal.trades * 100) + '% wins' : 'No closed trades yet'}</small></span><strong className={variant}>{money(s.journal.realizedPnlUsd)} →</strong></Link>)}
  </section>;
}
function DayPopup({ day, date, onClose }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  const trades = [...day.positive, ...day.negative, ...day.flat].sort((a,b)=>String(a.filledAt).localeCompare(String(b.filledAt)));
  return <dialog ref={ref} className="day-dialog" aria-labelledby="day-popup-title" onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header><div><span className="day-eyebrow">Daily paper recap · ET</span><h2 id="day-popup-title">{date} · {money(day.realized + day.partial)}</h2></div><button autoFocus onClick={onClose} aria-label="Close daily recap">Close ×</button></header>
    <p>{day.positive.length} wins · {day.negative.length} losses · {day.flat.length} breakeven · {day.idle.length} accounts without trades. Realized P&amp;L includes partial exits; open P&amp;L is separate.</p>
    <div className="day-table-scroll"><table><thead><tr><th>Strategy</th><th>Entry candle (ET)</th><th>Exit candle (ET)</th><th>Side</th><th>Entry → exit</th><th>Realized P&amp;L</th><th>Exit reason</th></tr></thead><tbody>{trades.map(t=><tr key={t.key}><td><Link href={t.strategy.route || `/strategies/${t.strategy.slug}`}>{t.strategy.name}</Link><details><summary>Timing details</summary><small>Signal observed: {stamp(t.signalObservedAt || t.signalContext?.observedAt)}<br />Journal recorded: {stamp(t.recordedAt || t.createdAt)}<br />Exit candle unavailable means not recorded, not the journal-save time.</small></details></td><td>{stamp(t.filledAt)}</td><td>{stamp(t.exitedAt)}</td><td>{t.side}</td><td>{t.entry} → {t.finalExitPrice ?? '—'}</td><td className={tone(t.realizedPnlUsd)}>{money(t.realizedPnlUsd)}</td><td>{t.exitReason}</td></tr>)}</tbody></table></div>
    {!trades.length && <p className="day-empty">No closed trades recorded for this date and filter.</p>}
    {day.active.map(({strategy,daily})=><p key={strategy.slug}>{strategy.name}: {daily.openTradeStatus} · {money(daily.activeUnrealizedPnlUsd || 0)} unrealized</p>)}
    <details><summary>No-trade accounts ({day.idle.length})</summary>{day.idle.map(s=><p key={s.slug}>{s.name}</p>)}</details>
    <p className="day-footnote">Entry and exit timestamps identify one-minute candles, not tick-exact fills. {day.unavailable.length} accounts lack records for this date.</p>
  </dialog>;
}

export default function DailyTradingDashboard({ data, strategies, refreshData, refreshState }) {
  const [selectedDate, setSelectedDate] = useState('');
  const [popup, setPopup] = useState(false);
  const inspectDay = value => { setSelectedDate(value); setPopup(true); };
  const [query, setQuery] = useState('');
  const [instrument, setInstrument] = useState('all');
  const [range, setRange] = useState('30');
  const [chartMode, setChartMode] = useState('realized');
  const [hoverDate, setHoverDate] = useState('');
  const today = sessionDate(data?.generatedAt);
  const date = selectedDate || today;
  const filtered = useMemo(() => strategies.filter(s => (instrument === 'all' || s.ticker === instrument) && `${s.name} ${s.slug}`.toLowerCase().includes(query.toLowerCase())), [strategies, query, instrument]);
  const day = useMemo(() => dashboardView(filtered, date), [filtered, date]);
  const history = useMemo(() => dashboardHistory(filtered), [filtered]);
  const end = Date.parse(`${today}T12:00:00Z`);
  const series = history.filter(row => range === 'all' || Date.parse(`${row.date}T12:00:00Z`) >= end - (Number(range) - 1) * 86400000);
  const selectedPoint = series.find(row => row.date === (hoverDate || date));
  const maximum = Math.max(1, ...series.map(row => Math.abs(row[chartMode])));
  const total = series.reduce((n, row) => n + row.realized, 0);
  const lifetime = lifetimeView(filtered);
  const closed = filtered.reduce((n,s)=>n+Number(s.journal?.trades || 0),0);
  const wins = filtered.reduce((n,s)=>n+Number(s.journal?.wins || 0),0);
  const lifetimePnl = filtered.reduce((n,s)=>n+Number(s.journal?.realizedPnlUsd || 0),0);
  const issues = strategies.filter(s => s.live?.latestError || (s.mode === 'live-watcher' && !s.watcher?.isHealthy));
  return <div className="daily-dashboard">
    <div className="day-heading"><div><p className="day-eyebrow">Lifetime strategy performance / Paper accounts</p><h1>Every strategy. The full picture.</h1><p>Strategies grouped by lifetime P&L. Select a day to inspect all its trades together.</p></div><div className="day-refresh"><button onClick={refreshData} disabled={refreshState.busy}>{refreshState.busy ? 'Refreshing…' : '↻ Refresh'}</button><small>Snapshot {data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : 'unavailable'} PT · auto-refresh 30s</small></div></div>
    {(refreshState.error || data?.ok === false || data?.source === 'remote-bridge-fallback') && <p className="day-alert" role="status">{refreshState.error || data?.error || 'Live bridge unavailable. Showing a fallback snapshot; account data may be out of date.'}</p>}
    <div className="day-toolbar"><div className="day-date"><label htmlFor="trading-date">Trading date · ET</label><input id="trading-date" type="date" value={date} max={today || undefined} onChange={e => { if(e.target.value) inspectDay(e.target.value); }} /><button onClick={() => inspectDay(today)}>Today</button></div><div className="day-filters"><label><span className="sr-only">Filter instrument</span><select value={instrument} onChange={e => setInstrument(e.target.value)}><option value="all">All instruments</option>{[...new Set(strategies.map(s => s.ticker).filter(Boolean))].map(t => <option key={t}>{t}</option>)}</select></label><label><span className="sr-only">Search strategies</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search strategies…" /></label></div></div>
    <div className="day-metrics">
      <section className="day-card day-main-metric"><span>Lifetime realized P&amp;L</span><strong className={tone(lifetimePnl)}>{money(lifetimePnl)}</strong><small>Closed trades · {filtered.length} accounts in view</small></section>
      <section className="day-card"><span>Daily realized P&amp;L · {shortDate(date)}</span><strong className={tone(day.realized + day.partial)}>{money(day.realized + day.partial)}</strong><button onClick={()=>setPopup(true)}>View day →</button></section>
      <section className="day-card"><span>Lifetime closed trades</span><strong>{closed}</strong><small>{wins} winning trades</small></section>
      <section className="day-card"><span>Lifetime win rate</span><strong>{closed ? `${Math.round(wins / closed * 100)}%` : '—'}</strong><small>Across the selected accounts</small></section>
    </div>
    <section className="day-card day-history"><header><div><span className="day-eyebrow">Forward paper history</span><h2>P&amp;L over time</h2></div><div className="day-chart-controls"><label><span className="sr-only">Chart metric</span><select value={chartMode} onChange={e => setChartMode(e.target.value)}><option value="realized">Daily P&amp;L</option><option value="cumulative">Cumulative P&amp;L</option></select></label><div className="day-segments" aria-label="History range">{[['7', '7D'], ['30', '30D'], ['90', '90D'], ['all', 'All']].map(([value, label]) => <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div></div></header>
      <div className="day-chart-caption"><strong className={tone(selectedPoint ? selectedPoint[chartMode] : total)}>{money(selectedPoint ? selectedPoint[chartMode] : total)}</strong><span>{selectedPoint ? `${shortDate(selectedPoint.date)} · ${chartMode === 'realized' ? 'closed-trade P&L' : 'cumulative closed-trade P&L'}` : 'Closed-trade P&L in this range'} · click a bar to inspect the day</span></div>
      {series.length ? <div className="day-chart-scroll"><div className="day-bar-chart" style={{ minWidth: Math.max(0, series.length * 12) }}><span className="day-zero" aria-hidden="true">$0</span>{series.map(row => { const value = row[chartMode]; const height = Math.max(1, Math.abs(value) / maximum * 45); return <button className={`day-bar ${row.date === date ? 'selected' : ''}`} key={row.date} aria-label={`${row.date}: ${money(value)}. Show this day.`} aria-pressed={row.date === date} title={`${row.date}: ${money(value)}`} onClick={() => inspectDay(row.date)} onMouseEnter={() => setHoverDate(row.date)} onMouseLeave={() => setHoverDate('')} onFocus={() => setHoverDate(row.date)} onBlur={() => setHoverDate('')}><span className={tone(value)} style={{ height: `${height}%`, top: value >= 0 ? `${50 - height}%` : '50%' }} /></button>; })}</div><div className="day-axis"><span>{shortDate(series[0].date)}</span><span>{shortDate(series.at(-1).date)}</span></div></div> : <p className="day-empty">No recorded history in this range. Try All or clear your filters.</p>}
      <p className="day-footnote">{filtered.length} accounts in view · recorded journal dates only · cumulative starts at the first available journal date. Open P&amp;L is excluded. <Link href="/backtests">Historical backtests →</Link></p>
      <details className="day-history-table"><summary>View daily history as a table</summary><div className="day-table-scroll"><table><thead><tr><th>Date (ET)</th><th>Closed-trade P&amp;L</th><th>Cumulative</th><th /></tr></thead><tbody>{[...series].reverse().map(row => <tr key={row.date}><td>{row.date}</td><td className={tone(row.realized)}>{money(row.realized)}</td><td>{money(row.cumulative)}</td><td><button onClick={() => inspectDay(row.date)}>Inspect day</button></td></tr>)}</tbody></table></div></details>
    </section>
    <div className="day-section-pair"><StrategySection title="Profitable strategies" rows={lifetime.positive} variant="gain" /><StrategySection title="Losing strategies" rows={lifetime.negative} variant="loss" /></div>
    {lifetime.flat.length > 0 && <StrategySection title="Breakeven strategies" rows={lifetime.flat} variant="" />}
    <StrategySection title="No trades yet" rows={lifetime.idle} variant="" />
    {lifetime.unavailable.length > 0 && <p className="day-alert">{lifetime.unavailable.length} accounts have unavailable lifetime totals.</p>}
    {popup && <DayPopup day={day} date={date} onClose={()=>setPopup(false)} />}
    <details className="day-card day-health"><summary><strong>System health</strong><span>{issues.length ? `${issues.length} accounts need review` : `${strategies.length} accounts · no watcher issues reported`}</span></summary><div>{(issues.length ? issues : strategies).map(s => <div className="day-idle-row" key={s.slug}><Link href={s.route || `/strategies/${s.slug}`}>{s.name}</Link><span>{s.watcher?.statusLabel || 'Unknown'}</span><small>{s.live?.latestError?.message || s.watcher?.staleStatusHint || 'No current error reported'}</small></div>)}</div></details>
  </div>;
}
