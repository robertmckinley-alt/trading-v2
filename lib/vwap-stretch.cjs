const SLUG = 'nq-vwap-stretch-reversion';
const RULES = Object.freeze({ timeframe: 'M1', atrPeriod: 14, stretchAtr: 2, stopAtr: 1, maxLosingTradesPerSession: 2 });
const ACCOUNT = Object.freeze({ startingBalanceUsd: 50000, maxAccountDrawdownPercent: 5, maxRiskPerTradeUsd: 500 });
const fmt = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(timestamp) {
  const p=Object.fromEntries(fmt.formatToParts(new Date(timestamp)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:+p.hour*60 + +p.minute};
}
function detect(candles, config, state={trades:[]}) {
  const no=reason=>({found:false,reason});
  const last=candles.at(-1); if(!last) return no('VWAP: no candles');
  const p=parts(last.timestamp), session=require('./orb-session.cjs').session(p.date);
  if(!session.open || p.minute<584 || p.minute>=session.closeMinute-2) return no('VWAP: waiting for session warmup or entry window closed');
  if((state.trades||[]).filter(t=>t.date===p.date && t.realizedPnlUsd<0).length>=2) return no('VWAP: two losing trades; paused until next cash session');
  if(state.balanceUsd <= 47500) return no('VWAP: 5% account drawdown stop; review required');
  const count=p.minute-570+1, start=Date.parse(last.timestamp)-(count-1)*60000;
  const bars=candles.slice(-count);
  if(bars.length!==count || bars.some((c,i)=>Date.parse(c.timestamp)!==start+i*60000 || ![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) || c.volume<0)) return no('VWAP: incomplete or invalid session candles');
  const history=bars.slice(0,-1), tr=history.slice(-14).map((c,i)=>{
    const idx=history.length-14+i, prev=history[idx-1]?.close ?? c.open;
    return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));
  });
  const atr=tr.reduce((a,b)=>a+b,0)/14;
  const volume=bars.reduce((a,c)=>a+c.volume,0);
  if(!(volume>0 && atr>0)) return no('VWAP: insufficient volume or volatility');
  const vwap=bars.reduce((a,c)=>a+(c.high+c.low+c.close)/3*c.volume,0)/volume;
  if(last.close>vwap-2*atr) return no('VWAP: close is not 2 ATR below session VWAP');
  const priorVolume=history.reduce((a,c)=>a+c.volume,0);
  const priorVwap=history.reduce((a,c)=>a+(c.high+c.low+c.close)/3*c.volume,0)/priorVolume;
  if(!(priorVolume>0) || history.at(-1).close<=priorVwap-2*atr) return no('VWAP: waiting for a fresh stretch crossing');
  const barRange=Math.max(last.high-last.low,0);
  const lowerWick=Math.min(last.open,last.close)-last.low;
  const exhaustionRejection=last.close>last.open || (barRange>0 && lowerWick/barRange>=0.4);
  if((config?.live?.vwapStretch?.requireRejectionCandle || config?.vwapStretch?.requireRejectionCandle) && !exhaustionRejection) {
    return no('VWAP: waiting for bullish rejection or lower-wick exhaustion');
  }
  const tick=config.tickSize, entry=Math.round(last.close/tick)*tick;
  const stop=Math.floor((entry-atr)/tick)*tick, target=Math.floor(vwap/tick)*tick;
  const flattenAt=new Date(Date.parse(last.timestamp)+(session.closeMinute-p.minute)*60000).toISOString();
  return {found:true,date:p.date,entry,stop,targets:[target],side:'long',atr,vwap,exhaustionRejection,flattenAt,triggerTimestamp:last.timestamp};
}
module.exports={SLUG,RULES,ACCOUNT,detect};
