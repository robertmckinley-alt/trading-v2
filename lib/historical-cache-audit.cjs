const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {cacheDayCoverage}=require('./session-quality.cjs');
function cacheIdentity(config){return JSON.stringify({version:1,dataset:config.live?.dataset||'GLBX.MDP3',symbol:config.live?.ticker||'NQ.v.0',schema:'ohlcv-1m',stype:'continuous'});}
function auditHistoricalCache(root,config,window,options={}){
 const start=Date.parse(window.start),end=Date.parse(window.end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error('Invalid historical audit window');
 const identity=cacheIdentity(config),cacheRoot=options.cacheDir||process.env.HISTORICAL_CACHE_DIR||path.join(root,'runtime/historical-candles');
 const dir=path.join(cacheRoot,createHash('sha256').update(identity).digest('hex'));
 const days=[];let first=null,last=null,candleCount=0;
 for(let at=Math.floor(start/86400000)*86400000;at<end;at+=86400000){
  const date=new Date(at).toISOString().slice(0,10),row={date};
  try{
   const saved=JSON.parse(fs.readFileSync(path.join(dir,date+'.json'),'utf8'));
   if(saved.identity!==identity||!Array.isArray(saved.candles)||saved.checksum!==createHash('sha256').update(JSON.stringify(saved.candles)).digest('hex'))throw new Error('Cache identity or checksum mismatch');
   Object.assign(row,cacheDayCoverage(at,saved.candles,config.live?.ticker||'NQ.v.0'));
   row.status=row.complete?'complete':row.reviewed?'incomplete':'unreviewed';
   for(const c of saved.candles){const t=Date.parse(c.timestamp);if(t>=start&&t<end){candleCount++;if(first===null||t<first)first=t;if(last===null||t>last)last=t;}}
  }catch(error){row.status=error.code==='ENOENT'?'missing':'corrupt';row.reason=error.code==='ENOENT'?'No persisted UTC cache file':error.message;}
  row.partialRequestedDay=at<start||at+86400000>end;
  days.push(row);
 }
 return {mode:'read-only-no-downloads',directory:dir,requestedWindow:window,candleCount,first:first===null?null:new Date(first).toISOString(),last:last===null?null:new Date(last).toISOString(),
  persistedUtcDaysComplete:days.length>0&&days.every(d=>d.status==='complete'),
  summary:days.reduce((a,d)=>(a[d.status]=(a[d.status]||0)+1,a),{}),days,
  note:'Persisted UTC cache coverage only. Current partial days are intentionally not cached. Missing files do not prove the historical provider has no data. Holiday schedules remain unreviewed; no candles are synthesized or downloaded.'};
}
module.exports={cacheIdentity,auditHistoricalCache};
