const clock = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
function parts(timestamp) {
  const p=Object.fromEntries(clock.formatToParts(new Date(timestamp)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return { date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute) };
}
function eligible(config, timestamp) {
  const {date,minute}=parts(timestamp), session=require('./orb-session.cjs').session(date);
  if (!session.open) return false;
  const slug=config.detectorStrategySlug || config.strategySlug;
  const windows={
    'nq-fresh-level-retest':[575,Math.min(930,session.closeMinute-30),1],
    'nq-vwap-stretch-reversion':[584,session.closeMinute-3,1],
    'live-9am-sweep':[540,session.closeMinute-1,1] };
  const [start,end,step]=windows[slug] || [570,session.closeMinute-1,1];
  const closeBuffer=1;
  return minute>=start && minute<=Math.min(end,session.closeMinute-closeBuffer) && minute%step===step-1;
}
function initialize(state, config, now=Date.now()) {
  const rulesVersion=(config.detectorStrategySlug||config.strategySlug)==='nq-fresh-level-retest'?require('./fresh-level-retest.cjs').VERSION:'baseline';
  if(!state.live.scanAudit || state.live.scanAudit.rulesVersion!==rulesVersion) {
    const old=state.live.scanAudit;
    state.live.scanAudit={rulesVersion,startedAt:new Date(now).toISOString(),tradeCountAtStart:state.trades?.length||0,
      pollIntervalMs:Number(config.live?.pollIntervalMs||60000),candleChecks:0,setupChecks:0,signals:0,orders:0,
      unfilledOrders:0,riskRejections:0,feedErrors:0,missedOlderCandles:0,days:[],
      priorVersion:old?{rulesVersion:old.rulesVersion,startedAt:old.startedAt,candleChecks:old.candleChecks,setupChecks:old.setupChecks}:null};
  }
  return state.live.scanAudit;
}
function record(audit, event, timestamp, reason=null) {
  const {date}=parts(timestamp);
  let day=audit.days.find(d=>d.date===date);
  if(!day){day={date,candleChecks:0,setupChecks:0,signals:0,orders:0,unfilledOrders:0,riskRejections:0,reasons:{}};audit.days.push(day);audit.days=audit.days.slice(-40);}
  audit[event]=Number(audit[event]||0)+1;
  day[event]=Number(day[event]||0)+1;
  if(reason && (event==='setupChecks'||event==='unfilledOrders'||event==='riskRejections')) {
    // Bucket numeric prices/distances so the reason histogram stays bounded.
    const bucket=String(reason).replace(/\d+(?:[.,]\d+)*/g,'#').slice(0,180);
    if(day.reasons[bucket]!==undefined || Object.keys(day.reasons).length<30)day.reasons[bucket]=(day.reasons[bucket]||0)+1;
  }
}
function evaluateFreshCandles({candles,config,state,detect,now=Date.now()}) {
  const audit=initialize(state,config,now), last=candles.at(-1);
  if(!last)return {found:false,reason:'No candles available'};
  const prior=Date.parse(audit.lastEvaluatedCandleAt||'');
  const freshness=Number(config.live?.maxLiveCandleAgeMinutes||3)*60000;
  const floor=now-freshness;
  // First installation/restart without scan history observes ONLY the latest bar.
  const unseen=Number.isFinite(prior)?candles.filter(c=>Date.parse(c.timestamp)>prior):[last];
  const fresh=unseen.filter(c=>Date.parse(c.timestamp)>=floor && Date.parse(c.timestamp)+60000<=now);
  const discarded=unseen.filter(c=>Date.parse(c.timestamp)<floor && Date.parse(c.timestamp)>Date.parse(audit.lastDiscardedCandleAt||'1970-01-01'));
  audit.missedOlderCandles+=discarded.length;
  if(discarded.length)audit.lastDiscardedCandleAt=discarded.at(-1).timestamp;
  audit.contextBars=candles.length;
  if((config.detectorStrategySlug||config.strategySlug)==='nq-fresh-level-retest')audit.contextCoverage=require('./fresh-level-retest.cjs').contextStatus(candles,parts(Date.parse(last.timestamp)+60000).date);
  let result={found:false,reason:'Waiting for a new completed live candle'};
  let newestSignal=null;
  for(const c of fresh) {
    const end=candles.findIndex(item=>item===c)+1;
    const signal=detect(candles.slice(0,end),config,state);
    record(audit,'candleChecks',c.timestamp);
    if(eligible(config,c.timestamp)) {
      record(audit,'setupChecks',c.timestamp,signal.found?'Qualified setup':signal.reason);
      audit.lastSetupCheckAt=c.timestamp;
      audit.lastSetupReason=signal.found?'Qualified setup':signal.reason;
    }
    audit.lastEvaluatedCandleAt=c.timestamp;
    audit.lastObservedAt=new Date(now).toISOString();
    result=signal;
    if(signal.found){
      const key=`${signal.triggerTimestamp}|${signal.setup.side}|${signal.setup.entry}`;
      if(key!==audit.lastSignalKey){record(audit,'signals',c.timestamp);audit.lastSignalKey=key;}
      newestSignal=signal;
    }
  }
  // Several unseen minute bars can describe the same completed setup. Only one
  // newest plan may be submitted, and its fills must occur AFTER observation.
  return newestSignal || result;
}
function bindForwardObservation(plan, now=Date.now()) {
  const floor=Math.ceil(now/60000)*60000;
  const old=Date.parse(plan.setup.signalAvailableAt||'');
  if(plan.setup.setup?.entryModel==='fresh-level-retest' && plan.setup.execution==='next-bar-market') {
    // This strategy gets one future minute to fill, not one minute beginning
    // before the watcher observes it. Keep the original signal age bounded.
    const origin=Date.parse(plan.setup.signalOriginAvailableAt||plan.setup.signalAvailableAt||'');
    if(!Number.isFinite(origin) || now-origin>120000)throw new Error('Fresh level signal is stale before forward observation');
    plan.setup.signalOriginAvailableAt=new Date(origin).toISOString();
    // Never extend an already submitted order on a subsequent binding call.
    if(!plan.setup.observedAt)plan.setup.orderExpiresAt=new Date(Math.max(floor,old)+60000).toISOString();
  }
  plan.setup.signalAvailableAt=new Date(Math.max(floor,Number.isFinite(old)?old:floor)).toISOString();
  plan.setup.observedAt=new Date(now).toISOString();
  require('./execution-policy.cjs').deadlines(plan.setup);
  if(Date.parse(plan.setup.orderExpiresAt)<=Date.parse(plan.setup.signalAvailableAt))throw new Error('Order deadline passed before a future observable fill');
  return plan;
}
function expirePending(state, now=Date.now()) {
  const plan=state.live?.openPlan;
  if(!plan || state.live.openLifecycle?.status !== 'not-filled' || now < Date.parse(plan.setup.orderExpiresAt))return false;
  return require('./live-trader.cjs').clearTerminalUnfilledPlan(state,{status:'not-filled',exitReason:'order expired'});
}
function snapshot(audit) {
  if(!audit)return null;
  return {...audit,observedSessions:audit.days.filter(d=>d.setupChecks>0).length,
    topRejections:Object.entries(audit.days.reduce((totals,d)=>{for(const [reason,n]of Object.entries(d.reasons))totals[reason]=(totals[reason]||0)+n;return totals;},{})).sort((a,b)=>b[1]-a[1]).slice(0,5)};
}
module.exports={expirePending,eligible,initialize,record,evaluateFreshCandles,bindForwardObservation,snapshot,parts};
