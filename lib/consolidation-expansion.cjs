// Advisory consolidation/expansion score. Never blocks existing strategies.
function assess(candles, side) {
 const bars=(candles||[]).slice(-37);
 if(bars.length<37)return {available:false,reason:'insufficient candles'};
 const baseline=bars.slice(0,20),compression=bars.slice(20,36),breakout=bars[36];
 const mean=a=>a.reduce((s,x)=>s+x.high-x.low,0)/a.length;
 const baselineRange=mean(baseline), compressedRange=mean(compression);
 const contraction=baselineRange>0&&compressedRange/baselineRange<=0.85;
 const high=Math.max(...compression.map(x=>x.high)),low=Math.min(...compression.map(x=>x.low));
 const expansion=compressedRange>0&&(breakout.high-breakout.low)/compressedRange>=1.15;
 const direction=side==='long'?breakout.close>high:side==='short'?breakout.close<low:false;
 const body=breakout.high>breakout.low?Math.abs(breakout.close-breakout.open)/(breakout.high-breakout.low):0;
 return {available:true,contraction,expansion,direction,bodyFraction:body,qualifies:contraction&&expansion&&direction&&body>=0.55,baselineRange,compressedRange};
}
module.exports={assess};
