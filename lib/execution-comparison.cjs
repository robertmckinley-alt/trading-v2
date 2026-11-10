const {metrics}=require('./constant-risk-metrics.cjs');
function compare(before,after){
 if(before.provenance?.dataFingerprint!==after.provenance?.dataFingerprint)throw new Error('Cannot compare different candle fingerprints');
 const prior=new Map(before.strategies.map(s=>[s.slug,s]));
 if(prior.size!==after.strategies.length||after.strategies.some(s=>!prior.has(s.slug)))throw new Error('Strategy list changed; comparison rejected');
 const rows=after.strategies.map(s=>{
  const old=prior.get(s.slug),a=old.research||old,b=s.research||s;
  const left=metrics(a.trades),right=metrics(b.trades);
  return {slug:s.slug,name:s.name,beforeProfitFactor:a.metrics.profitFactor,afterProfitFactor:b.metrics.profitFactor,
   beforeTrades:a.trades.length,afterTrades:b.trades.length,beforeRProfitFactor:left.profitFactor,afterRProfitFactor:right.profitFactor,
   beforeExpectancyR:left.expectancyR,afterExpectancyR:right.expectancyR,afterExpectancyBandR:right.expectancyBandR,
   beforeMaxDrawdownR:left.maxDrawdownR,afterMaxDrawdownR:right.maxDrawdownR,
   beforeNetPnlUsd:a.metrics.netPnlUsd,afterNetPnlUsd:b.metrics.netPnlUsd};
 });
 return {status:'completed',generatedAt:new Date().toISOString(),window:after.window,dataFingerprint:after.provenance.dataFingerprint,
  beforeCodeHash:before.provenance.codeHash,afterCodeHash:after.provenance.codeHash,rows,
  note:'Both versions replayed identical candles and config. Dollar PF preserves each strategy sizing convention; R PF normalizes risk. Null means insufficient observed losses. Retrospective simulation, not forward evidence.'};
}
module.exports={compare};
