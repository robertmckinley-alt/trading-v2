const {ACCOUNT}=require('./vwap-stretch.cjs');
const core=require('./trader-core.cjs');
const {performanceMetrics,reviewBacktestEvidence}=require('./research-lab.cjs');
function run(candles, raw, definition, deps={}) {
  const {groupTradingDays}=require('./backtest-engine.cjs');
  const live=require('./live-trader.cjs');
  const config={...raw,...ACCOUNT,strategySlug:definition.slug};
  const days=deps.groupedDays||groupTradingDays(candles);
  function simulate(research) {
    const c={...config,...(research?{maxAccountDrawdownPercent:100}: {})};
    const state=core.createEmptyState(c), trades=[]; let signals=0,notFilled=0,rejectedSignals=0;
    const rejectionReasons={}; let previousInstrument=null,rolloverDaysSkipped=0;
    for(const [i,[date,records]] of days.entries()) {
      const session=require('./orb-session.cjs').session(date); if(!session.open) continue;
      const instrument=records.find(r=>r.candle.instrumentId!=null)?.candle.instrumentId;
      const rolled=previousInstrument!=null && instrument!=null && previousInstrument!==instrument;
      if(instrument!=null) previousInstrument=instrument;
      if(rolled){rolloverDaysSkipped++;continue;}
      if(!require('./session-quality.cjs').cashCoverage(date,records.map(r=>r.candle)).complete)continue;
      let availableAfter=-Infinity;
      for(const record of records) {
        const at=Date.parse(record.candle.timestamp);
        if(record.minute<584 || record.minute>=session.closeMinute-2 || at<=availableAfter) continue;
        const detectionState=research?{...state,balanceUsd:50000}:state;
        const signal=live.detectSignalFromCandles(candles.slice(Math.max(0,record.index-require('./execution-policy.cjs').lookbackBars(c)+1),record.index+1),c,detectionState);
        if(!signal.found) continue;
        signals++;
        try {
          const sizingState=research?{...core.createEmptyState(c),trades:state.trades}:state;
          const plan=live.buildPlanFromSignal(signal,c,sizingState);
          const future=records.filter(r=>Date.parse(r.candle.timestamp)>at && r.minute<session.closeMinute).map(r=>r.candle);
          const result=core.replayPlan(plan,future,c);
          availableAfter=Date.parse(result.exitedAt||signal.setup.orderExpiresAt);
          if(result.status==='not-filled'){notFilled++;continue;}
          const trade={...core.toJournalTrade(plan,result),id:`vwap-${research?'research':'account'}-${trades.length}`,createdAt:signal.triggerTimestamp,evidenceType:'historical-simulated'};
          trades.push(trade);state.trades.push(trade);state.realizedPnlUsd+=trade.realizedPnlUsd;state.balanceUsd=50000+state.realizedPnlUsd;
        } catch(e) { if(!/drawdown guard|No trade: minimum/.test(e.message)) throw e;rejectedSignals++;rejectionReasons[e.message]=(rejectionReasons[e.message]||0)+1; }
      }
      if(i%10===0) deps.onProgress?.({phase:'simulating',strategy:definition.slug,date,daysCompleted:i,daysTotal:days.length,trades:trades.length});
    }
    return {trades,signals,notFilled,rejectedSignals,rejectionReasons,rolloverDaysSkipped,metrics:performanceMetrics(trades),review:reviewBacktestEvidence(trades,{enforceAccountDrawdown:!research})};
  }
  const account=simulate(false), research=simulate(true);
  return {slug:definition.slug,name:definition.name,family:definition.strategyFamilyName,evidenceType:'historical-simulated',...account,
    research:{...research,mode:'fixed-risk',sizing:{riskCapUsd:500,accountLossLimit:false},description:'Repeat setups; two net losing trades stop the session. No accumulated loss cutoff in this research diagnostic.',unfilledReasons:{},filterChecks:{}}};
}
module.exports={run};
