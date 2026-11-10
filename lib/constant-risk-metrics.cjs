// Evidence normalizes each trade to its actual initial risk, never account size.
function metrics(trades=[]){
 const valid=trades.filter(t=>Number.isFinite(Number(t.actualRiskUsd))&&Number(t.actualRiskUsd)>0&&Number.isFinite(Number(t.realizedPnlUsd)));
 const values=valid.map(t=>Number(t.realizedPnlUsd)/Number(t.actualRiskUsd));
 const n=values.length,mean=n?values.reduce((a,b)=>a+b,0)/n:null;
 const se=n>1?Math.sqrt(values.reduce((s,r)=>s+(r-mean)**2,0)/(n-1)/n):null;
 let equity=0,peak=0,drawdown=0;let missingMae=0;
 valid.forEach((t,i)=>{if(t.maeUsd==null||!Number.isFinite(Number(t.maeUsd)))missingMae++;
  const adverse=Math.abs(Number(t.maeUsd)||0)/Number(t.actualRiskUsd);
  drawdown=Math.max(drawdown,peak-(equity-adverse));equity+=values[i];peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);
 });
 const gains=values.filter(r=>r>0).reduce((a,b)=>a+b,0),losses=-values.filter(r=>r<0).reduce((a,b)=>a+b,0);
 return {basis:'one unit of actual initial risk per trade',trades:n,missingRisk:trades.length-n,missingMae,complete:n===trades.length&&n>0&&missingMae===0,
  expectancyR:mean,profitFactor:losses>0?gains/losses:null,maxDrawdownR:drawdown,expectancyStandardErrorR:se,
  expectancyBandR:se==null?null:{lower:mean-1.96*se,upper:mean+1.96*se},
  bandMethod:'Approximate 95% normal band; trade-level sample SE, assumes independence; not selection-adjusted',
  drawdownMethod:'Closed equity plus each trade MAE; conservative proxy, not a reconstructed intrabar equity path'};
}
module.exports={metrics};
