const {tradingDate,lookbackBars}=require('./execution-policy.cjs');
const identity=c=>c.instrumentId??c.instrument_id??null;
function rollIndex(candles){
 const latest=identity(candles.at(-1)||{});if(latest==null)return -1;
 for(let i=candles.length-2;i>=0;i--)if(identity(candles[i])!==latest)return i+1;
 return -1;
}
function context(candles,config){const start=rollIndex(candles);return candles.slice(Math.max(start, candles.length-lookbackBars(config),0));}
function rollDay(candles){const i=rollIndex(candles);return i>0&&tradingDate(candles[i].timestamp)===tradingDate(candles.at(-1).timestamp);}
module.exports={context,rollDay,identity};
