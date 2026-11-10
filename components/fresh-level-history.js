function usd(value) { return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value); }
function Line({points,field,title,color}) {
  if(!points.length)return null;
  const values=points.map(p=>p[field]),low=Math.min(...values),high=Math.max(...values),span=high-low||1;
  const path=values.map((v,i)=>`${i?'L':'M'}${50+i/Math.max(1,values.length-1)*700},${180-(v-low)/span*140}`).join(' ');
  return <figure style={{margin:'16px 0'}}><figcaption>{title} · {usd(low)} to {usd(high)}</figcaption><svg viewBox="0 0 800 220" role="img" aria-label={`${title}, ${points[0].date} to ${points.at(-1).date}`} style={{width:'100%',maxHeight:260}}><path d="M50 20V185H750" fill="none" stroke="#64748b"/><path d={path} fill="none" stroke={color} strokeWidth="2"/><text x="50" y="210" fill="currentColor" fontSize="12">{points[0].date}</text><text x="750" y="210" textAnchor="end" fill="currentColor" fontSize="12">{points.at(-1).date}</text></svg></figure>;
}
export default function FreshLevelHistory({source,accountView}) {
  const h=source?.history;
  if(!h)return <p>Fresh Level Retest historical run pending. No profitability result is available yet.</p>;
  return <section aria-label="Fresh Level Retest historical charts"><p>{accountView?'Guarded $50,000 account':'Diagnostic cumulative P&L added to $50,000, without the account floor'}. After modeled fees and slippage. Drawdown is measured at daily closes.</p><Line points={h.points} field="equityUsd" title="Historical equity" color="#22c55e"/><Line points={h.points} field="drawdownUsd" title="Daily closing drawdown" color="#fb7185"/><details><summary>Monthly net profit and loss</summary><div style={{overflowX:'auto'}}><table><thead><tr><th>Month</th><th>Net P&amp;L</th><th>Monthly result</th></tr></thead><tbody>{h.monthly.map(m=><tr key={m.month}><td>{m.month}</td><td>{usd(m.pnlUsd)}</td><td><span style={{display:'inline-block',height:12,width:`${Math.max(1,Math.abs(m.pnlUsd)/Math.max(1,...h.monthly.map(x=>Math.abs(x.pnlUsd)))*150)}px`,background:m.pnlUsd>=0?'#22c55e':'#fb7185'}}/></td></tr>)}</tbody></table></div></details></section>;
}
