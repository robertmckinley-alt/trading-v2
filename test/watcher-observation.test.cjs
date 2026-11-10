const test=require('node:test'),assert=require('node:assert/strict');
const obs=require('../lib/watcher-observation.cjs');
const raw=require('../config.json');
const cfg={...raw,strategySlug:'nq-vwap-stretch-reversion'};
function candles(start,count){return Array.from({length:count},(_,i)=>({timestamp:new Date(Date.parse(start)+i*60000).toISOString(),open:100,high:101,low:99,close:100,volume:100}));}
test('watcher rescues a fresh completed boundary between polls and never repeats checks',()=>{
  const now=Date.parse('2026-10-01T13:46:30Z'),state={trades:[],live:{}};
  const audit=obs.initialize(state,cfg,now);audit.lastEvaluatedCandleAt='2026-10-01T13:43:00.000Z';
  const c=candles('2026-10-01T13:43:00Z',3),seen=[];
  const detect=context=>{const last=context.at(-1);seen.push(last.timestamp);return last.timestamp.includes('13:44')?{found:true,triggerTimestamp:last.timestamp,setup:{side:'long',entry:100}}:{found:false,reason:'Wait'};};
  const result=obs.evaluateFreshCandles({candles:c,config:cfg,state,detect,now});
  assert.equal(result.found,true);assert.equal(result.triggerTimestamp,'2026-10-01T13:44:00.000Z');
  assert.deepEqual(seen,['2026-10-01T13:44:00.000Z','2026-10-01T13:45:00.000Z']);
  assert.equal(audit.candleChecks,2);assert.equal(audit.setupChecks,2);assert.equal(audit.signals,1);
  assert.equal(obs.evaluateFreshCandles({candles:c,config:cfg,state,detect,now}).found,false);
  assert.equal(audit.candleChecks,2);
});
test('initial watcher observes only the latest candle; stale gaps and future/incomplete candles never backfill',()=>{
  const now=Date.parse('2026-10-01T14:00:30Z'),c=candles('2026-10-01T13:30:00Z',30),state={trades:[],live:{}},seen=[];
  const detect=ctx=>{seen.push(ctx.at(-1).timestamp);return {found:false,reason:'Wait'};};
  obs.evaluateFreshCandles({candles:c,config:cfg,state,detect,now});
  assert.deepEqual(seen,['2026-10-01T13:59:00.000Z']);
  state.live.scanAudit.lastEvaluatedCandleAt='2026-10-01T13:30:00.000Z';seen.length=0;
  obs.evaluateFreshCandles({candles:[...c,...candles('2026-10-01T14:00:00Z',2)],config:cfg,state,detect,now});
  assert.deepEqual(seen,['2026-10-01T13:58:00.000Z','2026-10-01T13:59:00.000Z']);
  assert.ok(state.live.scanAudit.missedOlderCandles>0);
});
test('forward availability is after observation, deadline remains binding and market orders expire',()=>{
  const now=Date.parse('2026-10-01T13:46:30Z');
  const plan={setup:{execution:'next-bar-market',signalAvailableAt:'2026-10-01T13:45:00Z'}};
  obs.bindForwardObservation(plan,now);
  assert.equal(plan.setup.signalAvailableAt,'2026-10-01T13:47:00.000Z');
  assert.equal(plan.setup.orderExpiresAt,'2026-10-01T13:50:00.000Z');
  assert.throws(()=>obs.bindForwardObservation({setup:{orderExpiresAt:'2026-10-01T13:46:00Z'}},now),/deadline/);
});
test('eligible sessions exclude weekends and early-close afternoon; rule changes keep an activation boundary',()=>{
  assert.equal(obs.eligible(cfg,'2026-10-01T19:29:00Z'),true);
  assert.equal(obs.eligible(cfg,'2026-10-03T14:44:00Z'),false);
  assert.equal(obs.eligible(cfg,'2026-11-27T18:29:00Z'),false);
  const state={trades:[{}],live:{}};obs.initialize(state,cfg,1);
  assert.equal(state.live.scanAudit.rulesVersion,'baseline');
  obs.record(state.live.scanAudit,'setupChecks','2026-10-01T14:44:00Z','Structural stop 200 points');
  assert.equal(obs.snapshot(state.live.scanAudit).observedSessions,1);
  obs.initialize(state,{...cfg,strategySlug:'nq-fresh-level-retest'},2);
  assert.equal(state.live.scanAudit.priorVersion.rulesVersion,'baseline');
  assert.equal(state.live.scanAudit.tradeCountAtStart,1);
});
