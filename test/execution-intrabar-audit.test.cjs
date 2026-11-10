const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/trader-core.cjs');
const config = core.normalizeConfig({startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:150,tickSize:.25,tickValueUsd:5,commissionPerContractUsd:4.5,slippageTicks:1});
function plan(side='long',execution='limit-touch') {
 return core.buildTradePlan(core.normalizeSetup({side,execution,entry:100,stop:side==='long'?95:105,targets:[side==='long'?110:90],setup:{}},config),config,core.createEmptyState(config));
}
const bar=(open,high,low,close,timestamp='2026-10-15T15:00:00Z')=>({open,high,low,close,timestamp});
const run=(p,bars)=>core.trackTradeLifecycle(p,bars,config,{closeOpenAtEnd:false});
for(const side of ['long','short']) {
 const candle=side==='long'?bar(105,112,99,101):bar(95,101,88,99);
 test(`${side}: ambiguous limit-fill candle cannot award a possibly pre-entry target`,()=>{
  const p=plan(side), r=run(p,[candle]);
  assert.equal(r.status,'open');assert.deepEqual(r.targetsHit,[]);assert.equal(r.realizedPnlUsd,0);
  assert.equal(r.execution.intrabarPolicyVersion,'post-fill-evidence-v1');
  delete p.intrabarPolicyVersion;
  assert.equal(run(p,[candle]).status,'closed','existing saved plans preserve accounting');
 });
 test(`${side}: close beyond target supplies post-fill evidence`,()=>{
  const r=run(plan(side),[{...candle,close:side==='long'?111:89}]);
  assert.equal(r.status,'closed');assert.equal(r.targetsHit.length,1);
 });
 test(`${side}: subsequent candle target remains executable`,()=>{
  const later=side==='long'?bar(101,111,100,110,'2026-10-15T15:01:00Z'):bar(99,100,89,90,'2026-10-15T15:01:00Z');
  assert.equal(run(plan(side),[candle,later]).exitedAt,later.timestamp);
 });
 test(`${side}: limit executable at the open retains target eligibility`,()=>{
  assert.equal(run(plan(side),[{...candle,open:100}]).status,'closed');
 });
 test(`${side}: ambiguous entry candle still respects stop-first`,()=>{
  const c={...candle,low:side==='long'?94:88,high:side==='short'?106:112};
  const r=run(plan(side),[c]);assert.equal(r.status,'closed');assert.match(r.exitReason,/stop-loss/);assert.ok(r.realizedPnlUsd<0);
 });
}
test('unfilled new plan cannot enter at or beyond its session flatten deadline',()=>{
 const p=plan();p.setup.flattenAt='2026-10-15T15:00:00Z';
 const r=run(p,[bar(101,102,99,101)]);
 assert.equal(r.status,'not-filled');assert.equal(r.exitReason,'entry after session exit deadline');
});
test('market entry remains eligible for its entry-candle target',()=>{
 const r=run(plan('long','next-bar-market'),[bar(100,111,99,110)]);
 assert.equal(r.status,'closed');assert.equal(r.targetsHit.length,1);
});
for(const side of ['long','short']) test(`${side}: optional remaining-stop filter blocks collapsed structural risk only when configured`,()=>{
 const p=plan(side,'next-bar-market');
 const c=side==='long'?bar(96,97,95.5,96.5):bar(104,104.5,103,103.5);
 assert.equal(run(p,[c]).status,'open');
 p.setup.minimumRemainingStopRiskFraction=.5;
 const r=run(p,[c]);assert.equal(r.status,'not-filled');
 assert.equal(r.exitReason,'entry leaves insufficient structural stop distance');
 assert.equal(r.execution.minimumRemainingStopRiskFraction,.5);
 const normal=side==='long'?bar(99,100,98,99):bar(101,102,100,101);
 assert.equal(run(p,[normal]).status,'open');
});
test('new terminal rejections release the unfilled reservation',()=>{
 const {clearTerminalUnfilledPlan}=require('../lib/live-trader.cjs');
 for(const exitReason of ['entry leaves insufficient structural stop distance','entry after session exit deadline']) {
  const state={live:{openPlan:plan(),openSignalKey:'x',portfolioRisk:{reserved:100}}};
  assert.equal(clearTerminalUnfilledPlan(state,{status:'not-filled',exitReason}),true);
  assert.equal(state.live.openPlan,null);assert.equal(state.live.portfolioRisk,null);
 }
});
