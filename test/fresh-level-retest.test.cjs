const {test}=require('node:test'),assert=require('node:assert/strict');
const rules=require('../lib/fresh-level-retest.cjs');
const core=require('../lib/trader-core.cjs');
const live=require('../lib/live-trader.cjs');
const config=core.normalizeConfig({...require('../config.json'),...rules.ACCOUNT,strategySlug:rules.SLUG});
const date='2026-09-30';
const trades=p=>p.map((realizedPnlUsd,i)=>({date,realizedPnlUsd,createdAt:new Date(Date.UTC(2026,8,30,14,i)).toISOString()}));
test('three initial net wins unlock repeated trades until non-win',()=>{
 for(const p of [[],[10],[10,10],[10,10,10],[10,10,10,20,30]])assert.equal(rules.dayAllowed(trades(p),date),true);
 for(const p of [[-1,-1],[1,-1,1],[1,1,0],[1,1,1,-1],[1,1,1,0],[1,1,1,-1,10]])assert.equal(rules.dayAllowed(trades(p),date),false);
 assert.equal(rules.dayAllowed(trades([-1,-1]),'2026-10-01'),true);
});
test('pivot requires two completed right bars; overlapping zones collapse',()=>{
 const bars=[10,11,15,12,10,11,15.25,12,10].map((high,i)=>({timestamp:new Date(Date.UTC(2026,8,30,12,i*5)).toISOString(),end:Date.UTC(2026,8,30,12,(i+1)*5),high,low:high-1}));
 assert.equal(rules.levelsFrom(bars.slice(0,4),.25).length,0);
 const first=rules.levelsFrom(bars.slice(0,5),.25)[0];assert.equal(first.knownAt,bars[4].end);
 assert.equal(rules.levelsFrom(bars,.25).filter(l=>l.kind==='high').length,1);
});
test('missing minute cannot form completed M5 bar',()=>{
 const c=Array.from({length:5},(_,i)=>({timestamp:new Date(Date.UTC(2026,8,30,13,30+i)).toISOString(),open:100,high:101,low:99,close:100}));
 assert.equal(rules.bars5(c).length,1);assert.equal(rules.bars5(c.filter((_,i)=>i!==2)).length,0);
});
function signal(at='2026-09-30T14:00:00.000Z'){
 return {triggerTimestamp:at,metadata:{},setup:{symbol:'NQ',date,session:'Test',side:'long',entry:100,stop:95,targets:[110],exitAllAtTarget:true,execution:'next-bar-market',minimumEntryRewardRisk:1.5,signalAvailableAt:new Date(Date.parse(at)+60000).toISOString(),orderExpiresAt:new Date(Date.parse(at)+120000).toISOString(),flattenAt:'2026-09-30T19:55:00.000Z',thesis:'Synthetic execution verification only',setup:{entryModel:'fresh-level-retest',gapType:'swing-level',entryTimeframe:'M1',reaction:'bullish'}}};
}
test('entry gap must still offer 1.5R and fit $250 risk',()=>{
 const s=signal(),plan=live.buildPlanFromSignal(s,config,core.createEmptyState(config));
 const r=core.replayPlan(plan,[{timestamp:s.setup.signalAvailableAt,open:104,high:111,low:103,close:110}],config);
 assert.equal(r.status,'not-filled');assert.match(r.exitReason,/reward\/risk/);
});
test('stop wins same-bar conflict and modeled costs count',()=>{
 const s=signal(),plan=live.buildPlanFromSignal(s,config,core.createEmptyState(config));
 const r=core.replayPlan(plan,[{timestamp:s.setup.signalAvailableAt,open:100,high:112,low:94,close:105}],config);
 assert.ok(r.realizedPnlUsd<0);assert.match(r.exitReason,/stop-loss/);assert.ok(r.actualRiskUsd<=250);
});
test('multi-trade historical loop carries wins and stops after fourth trade loss',()=>{
 const candles=Array.from({length:390},(_,i)=>({timestamp:new Date(Date.UTC(2026,8,30,13,30+i)).toISOString(),open:100,high:i===41?101:111,low:i===41?94:99,close:100,volume:1}));
 const slots=new Set([10,20,30,40,50]);
 const result=require('../lib/fresh-level-backtest.cjs').run(candles,config,{name:'Test',strategyFamilyName:'Test'},{detect:(context)=>{
   const last=context.at(-1),index=candles.findIndex(c=>c.timestamp===last.timestamp);
   return slots.has(index)?{found:true,...signal(last.timestamp)}:{found:false};
 }});
 assert.equal(result.trades.length,4);assert.ok(result.trades.slice(0,3).every(t=>t.realizedPnlUsd>0));assert.ok(result.trades[3].realizedPnlUsd<0);
 assert.equal(result.research.trades.length,4);
});
test('actual detector accepts first retest, targets fresh resistance, rejects repeat touch',()=>{
 const start=Date.parse('2026-09-28T23:59:00Z');
 const end=Date.parse('2026-09-30T14:05:00Z');
 const candles=[];
 for(let t=start;t<=end;t+=60000)candles.push({timestamp:new Date(t).toISOString(),open:80,high:81,low:79,close:80,volume:10});
 function set(time,v){Object.assign(candles.find(c=>c.timestamp===`2026-09-30T${time}:00.000Z`),v);}
 set('12:10',{high:120});set('13:00',{high:100});
 for(let m=0;m<5;m++)set(`14:0${m}`,{open:103,high:106,low:102,close:105});
 set('14:05',{open:104,high:105,low:100,close:103});
 const s=rules.detect(candles,config,{trades:[]});assert.equal(s.found,true,JSON.stringify(s));assert.equal(s.setup.side,'long');assert.equal(s.setup.targets[0],119.75);
 const plan=live.buildPlanFromSignal(s,config,core.createEmptyState(config));assert.ok(plan.sizing.actualRiskUsd<=250);
 candles.push({timestamp:'2026-09-30T14:06:00.000Z',open:104,high:105,low:100,close:103,volume:10});
 assert.equal(rules.detect(candles,config,{trades:[]}).found,false);
});
test('session anchor needs 24 pre-entry hours, not prior UTC midnight',()=>{
 assert.equal(new Date(rules.contextStartForDate('2026-10-02')).toISOString(),'2026-10-01T13:35:00.000Z');
 assert.equal(new Date(rules.contextStartForDate('2026-12-02')).toISOString(),'2026-12-01T14:35:00.000Z');
 const candles=[];
 for(let t=Date.parse('2026-10-01T13:35:00Z');t<=Date.parse('2026-10-02T14:05:00Z');t+=60000)candles.push({timestamp:new Date(t).toISOString(),open:80,high:81,low:79,close:80});
 function set(time,v){Object.assign(candles.find(c=>c.timestamp===`2026-10-02T${time}:00.000Z`),v);}
 set('12:10',{high:120});set('13:00',{high:100});
 for(let m=0;m<5;m++)set(`14:0${m}`,{open:103,high:106,low:102,close:105});
 set('14:05',{open:104,high:105,low:100,close:103});
 assert.equal(rules.contextStatus(candles,'2026-10-02').ready,true);
 const result=rules.detect(candles,config,{trades:[]});assert.equal(result.found,true,JSON.stringify(result));
 const missing=rules.detect(candles.slice(1),config,{trades:[]});assert.equal(missing.found,false);assert.match(missing.reason,/need 24-hour pre-session context/);
});
test('live context remains fixed across the trading window',()=>{
 for(const at of ['2026-10-02T13:35:00Z','2026-10-02T19:29:00Z'])assert.equal(rules.contextStartForDate(rules.parts(Date.parse(at)).date),Date.parse('2026-10-01T13:35:00Z'));
});

test('watcher audit exposes corrected version and actual context coverage',()=>{
 const state={trades:[],live:{}};
 const candles=[{timestamp:'2026-10-01T13:35:00Z',open:80,high:81,low:79,close:80},{timestamp:'2026-10-02T14:00:00Z',open:80,high:81,low:79,close:80}];
 require('../lib/watcher-observation.cjs').evaluateFreshCandles({candles,config:{...config,strategySlug:rules.SLUG},state,detect:()=>({found:false,reason:'fixture'}),now:Date.parse('2026-10-02T14:01:00Z')});
 assert.equal(state.live.scanAudit.rulesVersion,rules.VERSION);assert.equal(state.live.scanAudit.contextCoverage.ready,true);
 assert.equal(state.live.scanAudit.contextCoverage.requiredStartAt,'2026-10-01T13:35:00.000Z');
});
