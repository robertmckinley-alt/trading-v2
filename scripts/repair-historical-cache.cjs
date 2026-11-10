#!/usr/bin/env node
// Bounded provider backfill. Reuses valid files; never rewrites trading journals.
const fs=require('node:fs'),path=require('node:path');
const {auditHistoricalCache}=require('../lib/historical-cache-audit.cjs');
const {cacheDayCoverage}=require('../lib/session-quality.cjs');
const {fetchDatabentoHistoricalCandles}=require('../lib/historical-data.cjs');
async function repair(root,config,start,end,options={}){
 const from=Date.parse(start),to=Date.parse(end),now=options.now||new Date();
 if(!Number.isFinite(from)||!Number.isFinite(to)||from%86400000||to%86400000||to<=from||to-from>31*86400000||to>Date.parse(now.toISOString().slice(0,10)))throw Error('Choose completed UTC days only, at most 31 days, with an exclusive end date');
 const window={start:new Date(from).toISOString(),end:new Date(to).toISOString()};
 const cacheDir=options.cacheDir||process.env.HISTORICAL_CACHE_DIR||path.join(root,'runtime/historical-candles');
 const before=auditHistoricalCache(root,config,window,{cacheDir}),attempted=[],failures=[];
 for(const day of before.days){
  if(day.status==='complete')continue;
  const at=Date.parse(day.date);
  if(!cacheDayCoverage(at,[],config.live?.ticker||'NQ.v.0').reviewed){failures.push({date:day.date,reason:'Unreviewed calendar; requires explicit session review'});continue;}
  attempted.push(day.date);
  options.onProgress?.({phase:'repair-day',date:day.date});
  try{
   await fetchDatabentoHistoricalCandles({window:{start:new Date(at).toISOString(),end:new Date(at+86400000).toISOString()},now,cacheDir,env:options.env||process.env,fetchImpl:options.fetchImpl,dataset:config.live?.dataset||'GLBX.MDP3',symbol:config.live?.ticker||'NQ.v.0',requestTimeoutMs:45000,retrySleep:options.retrySleep,onProgress:p=>options.onProgress?.({...p,date:day.date})});
  }catch(error){failures.push({date:day.date,reason:String(error.message).replace(/(Bearer\s+|Basic\s+)\S+/gi,'$1[redacted]')});}
 }
 const after=auditHistoricalCache(root,config,window,{cacheDir});
 return {mode:'targeted-historical-backfill',requestedWindow:window,attempted,failures,before:before.summary,after:after.summary,complete:after.persistedUtcDaysComplete,first:after.first,last:after.last,unresolved:after.days.filter(d=>d.status!=='complete'),note:'Provider retrieval uses the existing Databento account. Valid files reused; paper journals and saved backtest results unchanged.'};
}
async function main(){
 const root=path.resolve(__dirname,'..');require('dotenv').config({path:path.join(root,'.env.local'),quiet:true});
 const [start,end,...extra]=process.argv.slice(2);
 if(!start||!end||extra.length)throw Error('Usage: node scripts/repair-historical-cache.cjs START_UTC END_UTC_EXCLUSIVE');
 const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
 const result=await repair(root,config,start,end,{onProgress:p=>console.log(JSON.stringify(p))});
 const dir=path.join(root,'runtime/execution-audit');fs.mkdirSync(dir,{recursive:true});
 const report=path.join(dir,`cache-repair-${Date.now()}.json`);fs.writeFileSync(report,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,report},null,2));if(!result.complete)process.exitCode=2;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={repair};
