const rules=require('./fresh-level-retest.cjs');
const core=require('./trader-core.cjs');
const {performanceMetrics,reviewBacktestEvidence}=require('./research-lab.cjs');
function history(trades,days) {
  let equity=50000,peak=50000;const monthly={};
  const daily=new Map();for(const t of trades)daily.set(t.date,(daily.get(t.date)||0)+t.realizedPnlUsd);
  const points=days.map(([date])=>{const pnl=daily.get(date)||0;equity+=pnl;peak=Math.max(peak,equity);monthly[date.slice(0,7)]=(monthly[date.slice(0,7)]||0)+pnl;return {date,equityUsd:Math.round(equity*100)/100,drawdownUsd:Math.round((peak-equity)*100)/100,pnlUsd:pnl};});
  return {points,monthly:Object.entries(monthly).map(([month,pnlUsd])=>({month,pnlUsd}))};
}
function run(candles,raw,definition,deps={}) {
  const {groupTradingDays}=require('./backtest-engine.cjs'), live=require('./live-trader.cjs');
  const days=deps.groupedDays||groupTradingDays(candles);
  const base={...raw,...rules.ACCOUNT,strategySlug:rules.SLUG,sameCandleConflict:'stop-first'};
  function simulate(research){
    const config={...base,...(research?{maxAccountDrawdownPercent:100}:{})};
    const state=core.createEmptyState(config),trades=[],rejectionReasons={};let signals=0,notFilled=0,rejectedSignals=0,rolloverDaysSkipped=0;
    let instrument=null;
    for(const [i,[date,records]] of days.entries()){
      const policy=require('./orb-session.cjs').session(date);if(!policy.known||!policy.open)continue;
      const current=records.find(r=>r.candle.instrumentId!=null)?.candle.instrumentId;
      if(current!=null && instrument!=null && current!==instrument){instrument=current;rolloverDaysSkipped++;continue;}if(current!=null)instrument=current;
      if(!require('./session-quality.cjs').cashCoverage(date,records.map(r=>r.candle)).complete)continue;
      let busyUntil=-Infinity;
      for(const r of records){
        const at=Date.parse(r.candle.timestamp);
        if(r.minute<574||r.minute>=Math.min(929,policy.closeMinute-31)||at<=busyUntil)continue;
        if(!rules.dayAllowed(state.trades,date))break;
        // A fixed pre-session context anchor keeps merged-zone identities stable throughout the session.
        const start=rules.contextStartForDate(date);
        let from=r.index;while(from>0&&Date.parse(candles[from-1].timestamp)>=start)from--;
        const rawContext=candles.slice(Math.max(0,from-1),r.index+1);
        if(require('./candle-context.cjs').rollDay(rawContext))continue;
        const context=require('./candle-context.cjs').context(rawContext,config);
        const signal=(deps.detect||rules.detect)(context,config,state);if(!signal.found)continue;signals++;
        try {
          const sizing=research?{...core.createEmptyState(config),trades:state.trades}:state;
          const plan=live.buildPlanFromSignal(signal,config,sizing);
          const future=records.filter(x=>Date.parse(x.candle.timestamp)>at&&x.minute<policy.closeMinute).map(x=>x.candle);
          const replay=core.replayPlan(plan,future,config);
          if(replay.status==='not-filled'){notFilled++;continue;}
          const t={...core.toJournalTrade(plan,replay),id:`fresh-${research?'diagnostic':'account'}-${trades.length}`,createdAt:signal.triggerTimestamp,evidenceType:'historical-simulated'};
          trades.push(t);state.trades.push(t);state.realizedPnlUsd+=t.realizedPnlUsd;state.balanceUsd=50000+state.realizedPnlUsd;
          busyUntil=Date.parse(replay.exitedAt);
        }catch(e){if(!/drawdown guard|No trade: minimum/.test(e.message))throw e;rejectedSignals++;rejectionReasons[e.message]=(rejectionReasons[e.message]||0)+1;}
      }
      if(i%10===0)deps.onProgress?.({phase:'simulating',strategy:rules.SLUG,mode:research?'diagnostic':'guarded',date,daysCompleted:i,daysTotal:days.length,trades:trades.length});
    }
    return {trades,signals,notFilled,rejectedSignals,rejectionReasons,rolloverDaysSkipped,metrics:performanceMetrics(trades),review:reviewBacktestEvidence(trades,{enforceAccountDrawdown:!research}),history:history(trades,days)};
  }
  const account=simulate(false),research=simulate(true);
  return {slug:rules.SLUG,name:definition.name,family:definition.strategyFamilyName,rulesVersion:rules.VERSION,evidenceType:'historical-simulated',...account,research:{...research,mode:'fixed-risk',sizing:{riskCapUsd:250,accountLossLimit:false},description:'Diagnostic only: $250 cap and daily stopping rules, without accumulated account floor. Standalone replay cannot model concurrent portfolio vetoes.',unfilledReasons:{},filterChecks:{}}};
}
module.exports={run,history};
