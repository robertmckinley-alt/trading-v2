// Independent translation of the user's October 2026 video. Frozen, unvalidated rules.
const { timestampForWallClock } = require('./ny-time.cjs');
const { session } = require('./orb-session.cjs');
const SLUG = 'nq-fresh-level-retest';
const VERSION = 'fresh-level-retest-v3-observed-retest';
const ACCOUNT = Object.freeze({startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:250,adaptiveRiskFloorUsd:250});
const clock = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(t) { const p=Object.fromEntries(clock.formatToParts(new Date(t)).map(x=>[x.type,x.value])); return {date:`${p.year}-${p.month}-${p.day}`,minute:+p.hour*60+(+p.minute)}; }
// Freeze the level universe for the entire session, anchored 24 hours before entries open.
function contextStartForDate(date) { return Date.parse(timestampForWallClock(date,'09:35'))-24*3600000; }
function contextStatus(candles,date) {
  const requiredStartAt=new Date(contextStartForDate(date)).toISOString();
  const firstCandleAt=candles[0]?.timestamp||null;
  return {ready:!!firstCandleAt && Date.parse(firstCandleAt)<=Date.parse(requiredStartAt),requiredStartAt,firstCandleAt,lastCandleAt:candles.at(-1)?.timestamp||null};
}
function dayAllowed(trades,date) {
  const today=trades.filter(t=>t.date===date).sort((a,b)=>Date.parse(a.exitedAt||a.createdAt)-Date.parse(b.exitedAt||b.createdAt));
  if(today.slice(0,3).length===3 && today.slice(0,3).every(t=>t.realizedPnlUsd>0)) return today.slice(3).every(t=>t.realizedPnlUsd>0);
  return today.length<3 && today.filter(t=>t.realizedPnlUsd<0).length<2;
}
function bars5(candles) {
  const out=[];let group=[];let bucket=null;
  for(const c of candles) {
    const b=Math.floor(Date.parse(c.timestamp)/300000);
    if(b!==bucket){group=[];bucket=b;}
    group.push(c);
    if(group.length===5 && Date.parse(group[0].timestamp)===b*300000 && group.every((x,i)=>Date.parse(x.timestamp)===b*300000+i*60000))
      out.push({timestamp:group[0].timestamp,end:Date.parse(c.timestamp)+60000,open:group[0].open,close:c.close,high:Math.max(...group.map(x=>x.high)),low:Math.min(...group.map(x=>x.low))});
  }
  return out;
}
function levelsFrom(bars,tick) {
  const levels=[];
  for(let i=2;i<bars.length-2;i++) {
    const five=bars.slice(i-2,i+3), p=bars[i];
    if(five.some((x,j)=>Date.parse(x.timestamp)!==Date.parse(five[0].timestamp)+j*300000))continue;
    for(const kind of ['high','low']) {
      if(!five.every((x,j)=>j===2 || (kind==='high'?x.high<p.high:x.low>p.low)))continue;
      const price=p[kind],lo=price-2*tick,hi=price+2*tick;
      // Earliest zone owns overlapping levels, preventing duplicate opportunities.
      if(levels.some(l=>lo<=l.hi && hi>=l.lo))continue;
      levels.push({id:`${p.timestamp}:${kind}`,kind,price,lo,hi,knownAt:bars[i+2].end});
    }
  }
  return levels;
}
const touch=(c,l)=>c.low<=l.hi && c.high>=l.lo;
function detect(candles,config,state={trades:[]}) {
  const no=reason=>({found:false,reason:`Fresh level: ${reason}`});
  if(candles.length<25)return no('insufficient history');
  let previous=-Infinity;
  for(const c of candles){const t=Date.parse(c.timestamp);if(!Number.isFinite(t)||t<=previous||![c.open,c.high,c.low,c.close].every(Number.isFinite)||c.low>Math.min(c.open,c.close)||c.high<Math.max(c.open,c.close))return no('invalid candles');previous=t;}
  const last=candles.at(-1),at=Date.parse(last.timestamp),available=at+60000,{date,minute}=parts(available),policy=session(date);
  if(!policy.known||!policy.open||minute<575||minute>=Math.min(930,policy.closeMinute-30))return no('outside entry window');
  if(!dayAllowed(state.trades||[],date))return no('daily stopping rule');
  const contextStart=contextStartForDate(date),coverage=contextStatus(candles,date);
  if(!coverage.ready)return no(`need 24-hour pre-session context from ${coverage.requiredStartAt}; earliest candle ${coverage.firstCandleAt}`);
  candles=candles.filter(c=>Date.parse(c.timestamp)>=contextStart);
  if(new Set(candles.map(c=>c.instrumentId).filter(x=>x!=null)).size>1)return no('mixed contracts in context');
  const tick=config.tickSize,point=config.tickValueUsd/tick;
  const bars=bars5(candles),levels=levelsFrom(bars,tick),found=[];
  for(const l of levels){
    const side=l.kind==='high'?'long':'short',dir=side==='long'?1:-1;
    // Only the first completed break creates an opportunity; no re-arming.
    const b=bars.find(b=>Date.parse(b.timestamp)>=l.knownAt && (dir===1?b.close>l.hi:b.close<l.lo));
    if(!b || available>b.end+30*60000)continue;
    const post=candles.filter(c=>Date.parse(c.timestamp)>=b.end);
    // A missing minute may contain the first touch or invalidation. Do not
    // relabel a later observed touch as the first retest across a feed hole.
    if (!post.length || Date.parse(post[0].timestamp)!==b.end || post.some((c,i)=>Date.parse(c.timestamp)!==b.end+i*60000))continue;
    const first=post.find(c=>touch(c,l));
    if(!first || first.timestamp!==last.timestamp)continue;
    if(post.some(c=>Date.parse(c.timestamp)<at&&(dir===1?c.close<l.lo:c.close>l.hi)))continue;
    if(!(dir===1?last.close>l.hi:last.close<l.lo))continue;
    const stop=dir===1?Math.min(last.low,l.lo)-2*tick:Math.max(last.high,l.hi)+2*tick;
    const targets=levels.filter(t=>t.kind===l.kind && t.knownAt<=available && (dir===1?t.lo>last.close:t.hi<last.close)
      && !candles.some(c=>Date.parse(c.timestamp)>=t.knownAt && touch(c,t))).sort((a,b)=>dir*(a.price-b.price));
    if(!targets.length)continue;
    const target=targets[0].price-dir*tick, entry=last.close;
    const costs=config.commissionPerContractUsd+2*config.slippageTicks*config.tickValueUsd;
    if((dir*(target-entry)*point-costs)/((dir*(entry-stop))*point+costs)<1.5)continue;
    found.push({l,side,entry,stop,target});
  }
  if(found.length!==1)return no(found.length?'ambiguous levels':'no first retest with fresh 1.5R target');
  const {l,side,entry,stop,target}=found[0];
  return {found:true,triggerTimestamp:last.timestamp,sweepTimestamp:l.id,rangeSummary:[],sessionRanges:{},metadata:{rulesVersion:VERSION,levelId:l.id,levelKnownAt:new Date(l.knownAt).toISOString()},setup:{symbol:config.symbol,date,session:'Fresh Level Retest',side,entry,stop,targets:[target],exitAllAtTarget:true,execution:'next-bar-market',minimumEntryRewardRisk:1.5,signalAvailableAt:new Date(available).toISOString(),orderExpiresAt:new Date(available+60000).toISOString(),flattenAt:timestampForWallClock(date,policy.closeMinute===780?'12:55':'15:55'),thesis:'First retest after a completed M5 swing-level break; exit at the nearest fresh opposing pivot.',setup:{entryModel:'fresh-level-retest',gapType:'swing-level',entryTimeframe:'M1',reaction:side==='long'?'bullish':'bearish',activationTime:'09:35–15:30 America/New_York',referenceSessions:['confirmed-M5-pivots'],stopPlacement:side==='long'?'swing-low':'swing-high',liquidityPool:l.kind,liquidityLabel:'First retest',drawOnLiquidity:['nearest-fresh-pivot']}}};
}
module.exports={SLUG,VERSION,ACCOUNT,parts,contextStartForDate,contextStatus,dayAllowed,bars5,levelsFrom,detect};
