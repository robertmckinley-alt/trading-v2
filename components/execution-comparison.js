'use client';
import {useState} from 'react';
const number=value=>Number.isFinite(value)?value.toFixed(2):'Insufficient';
export default function ExecutionComparison({audit,progress}) {
 const [slug,setSlug]=useState('');
 if(!audit)return <section className="backtest-card"><h2>Execution repair comparison</h2><p>{progress ? `Historical comparison: ${progress.phase}${progress.strategy ? ` · ${progress.strategy}` : ''}.` : 'Repaired historical results are pending the identical-data VPS comparison.'}</p>{progress?.error&&<p>{progress.error}</p>}<p>Existing profitability figures are not a completed before/after comparison.</p></section>;
 const row=audit.rows.find(r=>r.slug===slug)||audit.rows[0];
 const series=row?[{name:'Before',pf:row.beforeProfitFactor},{name:'After',pf:row.afterProfitFactor}]:[];
 const max=Math.max(1,...series.map(s=>s.pf||0));
 return <section className="backtest-card"><h2>Execution repair: before and after</h2>
  <p>{audit.window?.start?.slice(0,10)} to {audit.window?.end?.slice(0,10)} (exclusive end). Both versions used the same candle fingerprint.</p>
  <label>Strategy <select value={row?.slug||''} onChange={e=>setSlug(e.target.value)}>{audit.rows.map(r=><option key={r.slug} value={r.slug}>{r.name}</option>)}</select></label>
  <svg viewBox="0 0 600 160" role="img" aria-label={`Before and after profit factor for ${row?.name}`} style={{width:'100%',maxWidth:600}}>
   <line x1={120+360/max} x2={120+360/max} y1="15" y2="125" stroke="currentColor" strokeDasharray="4"/><text x={120+360/max} y="145" fill="currentColor">PF 1.0</text>
   {series.map((s,i)=><g key={s.name}><text x="5" y={42+i*60} fill="currentColor">{s.name}</text><rect x="120" y={20+i*60} height="32" width={s.pf==null?0:s.pf/max*360} fill={i?'#16a085':'#748399'}/><text x="490" y={42+i*60} fill="currentColor">{number(s.pf)}</text></g>)}
  </svg>
  <div style={{overflowX:'auto'}}><table><thead><tr><th>Strategy</th><th>Before PF</th><th>After PF</th><th>Before trades</th><th>After trades</th><th>After R PF</th><th>After expectancy R</th></tr></thead><tbody>{audit.rows.map(r=><tr key={r.slug}><td>{r.name}</td><td>{number(r.beforeProfitFactor)}</td><td>{number(r.afterProfitFactor)}</td><td>{r.beforeTrades}</td><td>{r.afterTrades}</td><td>{number(r.afterRProfitFactor)}</td><td>{number(r.afterExpectancyR)}</td></tr>)}</tbody></table></div>
  <p>{audit.note}</p><details><summary>Data fingerprint</summary><code>{audit.dataFingerprint}</code></details>
 </section>;
}
