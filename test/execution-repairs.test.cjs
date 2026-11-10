const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../lib/trader-core.cjs'),live=require('../lib/live-trader.cjs');
const config=core.normalizeConfig(require('../config.json'));
function orbBars(){const base=Date.parse('2026-02-03T14:30:00Z');return Array.from({length:30},(_,i)=>({timestamp:new Date(base+i*60000).toISOString(),open:i<15?10000:10004+(i-15)*3,high:i<15?10010:10007+(i-15)*4,low:i<15?9990:10003+(i-15)*3,close:i<15?10000:10006+(i-15)*4,volume:100}));}
const obs=require('../lib/watcher-observation.cjs');
function plan(execution='limit-touch',date='2026-02-03',time='14:05:00Z') { return {setup:{date,execution,side:'long',entry:100,stop:95,targets:[110],signalAvailableAt:`${date}T${time}`,thesis:'fixture',setup:{}},targets:[{price:110,closeFraction:1}],sizing:{maxContracts:1,riskBudgetUsd:500,actualRiskUsd:110}}; }
test('2: untapped 09:05 limit expires the same session and releases reservation',()=>{
 const p=plan();obs.bindForwardObservation(p,Date.parse(p.setup.signalAvailableAt));
 assert.equal(p.setup.orderExpiresAt,'2026-02-03T14:08:00.000Z');assert.equal(p.setup.flattenAt,'2026-02-03T20:59:00.000Z');
 const state={live:{openPlan:p,openTriggeredAt:p.setup.signalAvailableAt,openSignalKey:'old'}};
 const result=core.trackTradeLifecycle(p,[{timestamp:'2026-02-03T14:08:00Z',open:105,high:106,low:104,close:105}],config,{closeOpenAtEnd:false});
 assert.equal(live.clearTerminalUnfilledPlan(state,result),true);assert.equal(state.live.openPlan,null);
 const next=plan('limit-touch','2026-02-04');assert.doesNotThrow(()=>obs.bindForwardObservation(next,Date.parse(next.setup.signalAvailableAt)));
});
test('2: early close is 12:59 Eastern and flatten happens at scheduled open',()=>{
 const p=plan('next-bar-market','2026-11-27');obs.bindForwardObservation(p,Date.parse(p.setup.signalAvailableAt));
 assert.equal(p.setup.flattenAt,'2026-11-27T17:59:00.000Z');
 const r=core.trackTradeLifecycle(p,[{timestamp:p.setup.signalAvailableAt,open:100,high:101,low:99,close:100},{timestamp:p.setup.flattenAt,open:102,high:111,low:101,close:110}],config,{closeOpenAtEnd:false});
 assert.equal(r.status,'closed');assert.equal(r.finalExitPrice,102-config.slippageTicks*config.tickSize);assert.deepEqual(r.targetsHit,[]);
});
test('3: exact touch is not a fill; one-tick trade-through fills with adverse entry costs; legacy flag differs',()=>{
 const p=plan();const bar={timestamp:p.setup.signalAvailableAt,open:101,high:102,low:100,close:101};
 assert.equal(core.trackTradeLifecycle(p,[bar],config).status,'not-filled');
 const r=core.trackTradeLifecycle(p,[{...bar,low:99.75}],config,{closeOpenAtEnd:false});
 assert.equal(r.filledEntryPrice,100+config.slippageTicks*config.tickSize);
 assert.equal(core.trackTradeLifecycle(p,[bar],{...config,limitFillModel:'legacy-touch'}).filledEntryPrice,100);
 const short=plan();Object.assign(short.setup,{side:'short',stop:105});short.targets=[{price:90,closeFraction:1}];
 assert.equal(core.trackTradeLifecycle(short,[{...bar,open:99,high:100,low:98}],config).status,'not-filled');
 assert.equal(core.trackTradeLifecycle(short,[{...bar,open:99,high:100.25,low:98}],config).filledEntryPrice,100-config.slippageTicks*config.tickSize);
});
function parityBars(){const base=Date.parse('2026-02-03T14:30:00Z');return Array.from({length:390},(_,i)=>{const v=i<15?10000:i<30?10004+(i-15)*.6:10014;return {timestamp:new Date(base+i*60000).toISOString(),open:v,high:i<15?10010:i<30?v+2:10016,low:i<15?9990:v-1,close:i<15?v:i<30?v+1:v,volume:100,instrumentId:1};});}
test('8: scorecards use equal-risk R, include MAE, report SE, and reject zero-loss PF',()=>{
 const research=require('../lib/research-lab.cjs'),evaluation=require('../lib/strategy-evaluation.cjs');
 const trades=[{date:'2026-02-03',realizedPnlUsd:1000,actualRiskUsd:1000,rMultiple:1,maeUsd:-2000},{date:'2026-02-04',realizedPnlUsd:-200,actualRiskUsd:100,rMultiple:-2,maeUsd:-250}];
 const m=research.performanceMetrics(trades);
 assert.equal(m.constantRisk.expectancyR,-.5);assert.equal(m.constantRisk.profitFactor,.5);assert.ok(m.constantRisk.maxDrawdownR>=2.5);assert.equal(m.constantRisk.expectancyStandardErrorR,1.5);
 const wins=Array.from({length:60},(_,i)=>({...trades[0],date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)}));
 assert.equal(research.reviewEvidence(wins).gates.profitFactor,false);assert.equal(evaluation.evaluateStrategyJournal({trades:wins}).gates.profitFactor,false);
});
test('9: Friday final bar on Saturday is market closed, not a watcher feed error',()=>{
 const {buildLiveStrategy}=require('../lib/live-status.cjs');const real=Date.now;Date.now=()=>Date.parse('2026-10-03T19:00:00Z');
 try{const result=buildLiveStrategy({config,state:{trades:[],live:{heartbeat:{at:'2026-10-03T19:00:00Z',ok:false,error:'Databento live candle is stale',lastCandle:{timestamp:'2026-10-02T20:59:00Z'}}}},processCount:1,logText:''});assert.equal(result.watcher.statusLabel,'Market closed');assert.equal(result.watcher.isHealthy,true);}finally{Date.now=real;}
});
test('2: expired pending reservation clears even on a feed outage, but filled positions are retained',()=>{
 const p=plan();obs.bindForwardObservation(p,Date.parse(p.setup.signalAvailableAt));const now=Date.parse(p.setup.orderExpiresAt);
 const s={live:{openPlan:p,openLifecycle:{status:'not-filled'}}};assert.equal(obs.expirePending(s,now),true);assert.equal(s.live.openPlan,null);
 const filled={live:{openPlan:p,openLifecycle:{status:'open',filledAt:p.setup.signalAvailableAt}}};assert.equal(obs.expirePending(filled,now),false);assert.ok(filled.live.openPlan);
});
test('comparison rejects mixed input data and keeps every strategy in the PF table',()=>{
 const compare=require('../lib/execution-comparison.cjs').compare;
 const trade={date:'2026-02-03',realizedPnlUsd:50,actualRiskUsd:100,maeUsd:-10};
 const r={provenance:{dataFingerprint:'same'},strategies:[{slug:'one',name:'One',trades:[trade],metrics:{profitFactor:null}}]};
 assert.equal(compare(r,structuredClone(r)).rows.length,1);
 assert.throws(()=>compare(r,{...r,provenance:{dataFingerprint:'different'}}),/fingerprint/);
 assert.throws(()=>compare(r,{...r,strategies:[]}),/Strategy list changed/);
});
