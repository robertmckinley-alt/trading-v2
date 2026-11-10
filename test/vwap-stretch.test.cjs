const test=require('node:test'), assert=require('node:assert/strict');
const vwap=require('../lib/vwap-stretch.cjs'), core=require('../lib/trader-core.cjs');
const config={...core.normalizeConfig(require('../config.json')),...vwap.ACCOUNT,strategySlug:vwap.SLUG};
function candles(minutes=200,date='2026-09-08') {
 return Array.from({length:minutes},(_,i)=>({timestamp:new Date(Date.parse(date+'T13:30:00Z')+i*60000).toISOString(),open:100,high:101,low:99,close:100,volume:100,instrumentId:1}));
}
test('VWAP fires in afternoon, long only; incomplete session rejected',()=>{
 const c=candles();c.at(-1).close=90;c.at(-1).low=89;
 const s=vwap.detect(c,config);assert.equal(s.found,true);assert.equal(s.side,'long');assert.ok(s.targets[0]>s.entry);
 assert.equal(vwap.detect(c.filter((_,i)=>i!==2),config).found,false);
 c.at(-1).close=110;c.at(-1).high=111;assert.equal(vwap.detect(c,config).found,false);
});
test('two net losses pause session, wins do not reset count, next day resets',()=>{
 const c=candles();c.at(-1).close=90;c.at(-1).low=89;
 const t=pnl=>({date:'2026-09-08',realizedPnlUsd:pnl});
 assert.equal(vwap.detect(c,config,{trades:[t(-10),t(100)]}).found,true);
 assert.equal(vwap.detect(c,config,{trades:[t(-10),t(100),t(-1)]}).found,false);
 assert.equal(vwap.detect(c,config,{trades:[{...t(-10),date:'2026-09-07'},{...t(-10),date:'2026-09-07'}]}).found,true);
 assert.equal(vwap.detect(c,config,{balanceUsd:47500,trades:[]}).found,false);
});
test('repeat historical setups stop at two losses without overlapping positions',()=>{
 const c=candles(390);
 for(const i of [20,50,80]) {Object.assign(c[i],{open:100,high:100,low:89,close:90});Object.assign(c[i+1],{open:90,high:91,low:80,close:81});}
 const r=require('../lib/vwap-backtest.cjs').run(c,config,{slug:vwap.SLUG,name:'VWAP'});
 assert.equal(r.trades.length,2);assert.equal(r.research.trades.length,2);
 assert.ok(r.trades.every(t=>t.realizedPnlUsd<0));assert.ok(r.trades[1].filledAt>r.trades[0].exitedAt);
});
test('risk budget fits remaining 5% floor room and scheduled close beats later targets',()=>{
 const c=candles();Object.assign(c.at(-1),{close:90,low:89});
 const live=require('../lib/live-trader.cjs'),state=core.createEmptyState(config);state.balanceUsd=47600;
 const signal=live.detectSignalFromCandles(c,config,state),plan=live.buildPlanFromSignal(signal,config,state);
 assert.ok(plan.sizing.actualRiskUsd<=100);assert.ok(plan.sizing.maxContracts>=1);
 const result=core.trackTradeLifecycle(plan,[{timestamp:signal.setup.signalAvailableAt,open:90,high:91,low:90,close:90},{timestamp:signal.setup.flattenAt,open:91,high:110,low:90,close:109}],config,{closeOpenAtEnd:false});
 assert.equal(result.status,'closed');assert.match(result.exitReason,/session exit/);
});
