const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const core = require('../lib/trader-core.cjs');
const risk = require('../lib/portfolio-risk.cjs');
const registry = require('../lib/strategy-registry.cjs');
const config = core.normalizeConfig({startingBalanceUsd:50000,maxAccountDrawdownPercent:10,maxRiskPerTradeUsd:500,tickSize:.25,tickValueUsd:5,commissionPerContractUsd:4.5,slippageTicks:1});
function plan(side='long', execution='limit-touch') {
  return core.buildTradePlan(core.normalizeSetup({side,execution,entry:100,stop:side==='long'?95:105,targets:[side==='long'?130:70],thesis:'regression',setup:{}},config),config,core.createEmptyState(config));
}
const bar=(open, high, low)=>({timestamp:'2026-10-08T15:00:00Z',open,high,low,close:open});
for(const side of ['long','short']) test(`${side} limit requires trade-through and never fills beyond its limit`,()=>{
  const p=plan(side), candle=side==='long'?bar(101,102,100):bar(99,100,98);
  assert.equal(core.trackTradeLifecycle(p,[candle],config,{closeOpenAtEnd:false}).status,'not-filled');
  if(side==='long')candle.low=99.75;else candle.high=100.25;
  const r=core.trackTradeLifecycle(p,[candle],config,{closeOpenAtEnd:false});
  assert.equal(r.filledEntryPrice,100);
  assert.equal(r.slippageCostUsd,0);
  assert.equal(r.actualRiskUsd,p.sizing.actualRiskUsd);
  assert.equal(p.sizing.slippageUsd,5);
  const old=structuredClone(p);delete old.executionModelVersion;
  assert.equal(core.trackTradeLifecycle(old,[candle],config,{closeOpenAtEnd:false}).filledEntryPrice,side==='long'?100.25:99.75);
});
test('market gap cannot exceed the reservation even with a larger account budget',()=>{
  const p=plan('long','next-bar-market');p.sizing.maxContracts=1;p.sizing.actualRiskUsd=114.5;
  const candles=[bar(110,112,109)];
  const result=core.trackTradeLifecycle(p,candles,config,{closeOpenAtEnd:false});
  assert.equal(result.status,'not-filled');assert.equal(result.exitReason,'entry gap exceeds risk budget');
  const legacy=structuredClone(p);delete legacy.executionModelVersion;
  const prior=core.trackTradeLifecycle(legacy,candles,config,{closeOpenAtEnd:false});
  assert.equal(prior.actualRiskUsd,314.5);
  assert.equal(risk.planRiskUsd(legacy),500);
  assert.equal(risk.planRiskUsd(legacy,prior),500);
});
test('gap resizing remains within the reservation for both sides',()=>{
  for(const side of ['long','short']) {
    const p=plan(side,'next-bar-market');
    const r=core.trackTradeLifecycle(p,[side==='long'?bar(103,104,102):bar(97,98,96)],config,{closeOpenAtEnd:false});
    assert.equal(r.contracts,2);assert.ok(r.actualRiskUsd<=p.sizing.actualRiskUsd);
  }
});
test('atomic admissions cannot collectively reserve beyond the shared cap',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'risk-admission-'));
  try {
    const cfg={maxPortfolioOpenRiskUsd:200};let commits=0;
    for(const definition of registry.STRATEGIES.slice(0,2)) {
      const p=plan('long','next-bar-market');p.sizing.maxContracts=1;p.sizing.actualRiskUsd=114.5;
      risk.reservePortfolioRisk({rootDir:root,config:cfg,strategySlug:definition.slug,proposedRiskUsd:p.sizing.actualRiskUsd,commit:()=>{
        commits++;fs.writeFileSync(registry.runtimeFilesForStrategy(root,definition.slug).statePath,JSON.stringify({live:{openPlan:p}}));
      }});
    }
    assert.equal(commits,1);assert.equal(risk.getPortfolioRiskSnapshot(root,cfg).reservedRiskUsd,114.5);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
