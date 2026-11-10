#!/usr/bin/env node
// Same candles, frozen config, frozen strategies. No network or paid downloads.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),BASELINE='266b9dcc569e7c3882687131b12df298ba637fed';
const {saveBacktestResult:save}=require('../lib/backtest-worker.cjs');
function hash(candles){const h=createHash('sha256');for(const c of candles)h.update(JSON.stringify(c)).update('\n');return h.digest('hex');}
function loadCandles(root,config,report,options={}){
 const identity=JSON.stringify({version:1,dataset:config.live.dataset||'GLBX.MDP3',symbol:config.live.ticker||'NQ.v.0',schema:'ohlcv-1m',stype:'continuous'});
 const dir=path.join(process.env.HISTORICAL_CACHE_DIR||path.join(root,'runtime/historical-candles'),createHash('sha256').update(identity).digest('hex'));
 const map=new Map(),start=Date.parse(report.window.start),end=Date.parse(report.window.end);
 for(const name of fs.readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()){
  const day=Date.parse(name.slice(0,10));if(day>=end||day+86400000<=start)continue;
  const row=JSON.parse(fs.readFileSync(path.join(dir,name)));
  if(row.identity!==identity||row.checksum!==createHash('sha256').update(JSON.stringify(row.candles)).digest('hex'))throw new Error(`Cache checksum/identity mismatch: ${name}`);
  // Intentionally retain partial days in this frozen INPUT. The repaired engine
  // excludes them, the baseline engine does not; that difference is being measured.
  for(const c of row.candles)if(Date.parse(c.timestamp)>=start&&Date.parse(c.timestamp)<end)map.set(c.timestamp,c);
 }
 const candles=[...map.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
 if(!candles.length)throw new Error('No cached candles exist in the requested report window.');
 if(!options.currentCache && hash(candles)!==report.provenance.dataFingerprint)throw new Error('Cached candles do not reproduce the saved report fingerprint. No API calls were made. Restore its matching cache before comparing.');
 return candles;
}
function main(){
 process.chdir(root);require('dotenv').config({path:process.env.ENV_FILE||path.join(root,'.env.local'),quiet:true});
 const currentCache=process.argv.includes('--current-cache');
 if(process.argv.slice(2).some(x=>x!=='--current-cache'))throw new Error('Usage: node scripts/compare-execution-backtests.cjs [--current-cache]');
 const auditDir=path.join(root,'runtime/execution-audit');fs.mkdirSync(auditDir,{recursive:true});
 const dir=path.join(auditDir,`run-${Date.now()}-${process.pid}`);fs.mkdirSync(dir);
 const lock=path.join(auditDir,'run.lock');let fd;try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));}catch{throw new Error('Comparison lock exists. Inspect its PID before removing a stale lock.');}
 const progress=event=>{save(path.join(dir,'progress.json'),{...event,updatedAt:new Date().toISOString()});if(event.phase==='strategy-completed')console.log(JSON.stringify(event));};
 try{
  const report=JSON.parse(fs.readFileSync(process.env.BACKTEST_CACHE_PATH||path.join(root,'runtime/backtest-results.json')));
  const config=require('../lib/trader-core.cjs').normalizeConfig(require('../config.json'));
  const candles=loadCandles(root,config,report,{currentCache});save(path.join(dir,'published-before.json'),report);save(path.join(dir,'frozen-config.json'),config);
  const input={mode:currentCache?'current-cache-replay':'saved-report-reproduction',originalReportFingerprint:report.provenance.dataFingerprint,dataFingerprint:hash(candles),matchesOriginal:hash(candles)===report.provenance.dataFingerprint,candleCount:candles.length,first: candles[0].timestamp,last:candles.at(-1).timestamp,requestedWindow:report.window};
  const coverage=require('../lib/historical-cache-audit.cjs').auditHistoricalCache(root,config,report.window);
  save(path.join(dir,'cache-coverage.json'),coverage);
  input.cacheCoverage={persistedUtcDaysComplete:coverage.persistedUtcDaysComplete,summary:coverage.summary,
    missingDates:coverage.days.filter(d=>d.status==='missing').map(d=>d.date),
    incompleteDates:coverage.days.filter(d=>d.status==='incomplete'||d.status==='corrupt').map(d=>d.date),
    note:coverage.note};
  if(!coverage.persistedUtcDaysComplete)console.error('CACHE COVERAGE INCOMPLETE: this replay does not establish results for every requested day. See cache-coverage.json.');
  save(path.join(dir,'frozen-candles.json'),candles);save(path.join(dir,'input.json'),input);
  console.log(JSON.stringify({...input,output:dir}));
  const baselineDir=path.join(dir,BASELINE);fs.mkdirSync(baselineDir,{recursive:true});
  const archive=path.join(dir,'baseline.tar');execFileSync('git',['archive','--format=tar',`--output=${archive}`,BASELINE,'lib','config.json'],{cwd:root});execFileSync('tar',['-xf',archive,'-C',baselineDir]);fs.unlinkSync(archive);
  const before={...require(path.join(baselineDir,'lib/backtest-engine.cjs')).runAllBacktests(candles,config,{onProgress:e=>progress({...e,version:'before'})}),window:report.window,source:report.source,symbol:report.symbol};
  before.provenance=require(path.join(baselineDir,'lib/backtest-provenance.cjs')).backtestProvenance(candles,before.window);save(path.join(dir,'before.json'),before);
  const after={...require('../lib/backtest-engine.cjs').runAllBacktests(candles,config,{onProgress:e=>progress({...e,version:'after'})}),window:report.window,source:report.source,symbol:report.symbol};
  after.provenance=require('../lib/backtest-provenance.cjs').backtestProvenance(candles,after.window);
  after.executionAudit=require('../lib/execution-comparison.cjs').compare(before,after);
  after.executionAudit.input=input;
  if(currentCache)after.executionAudit.note='NEW CACHE REPLAY, not a reproduction of the published report. Missing sessions are reported in before.json and after.json coverage. '+after.executionAudit.note;
  save(path.join(dir,'after.json'),after);save(path.join(dir,'comparison.json'),after.executionAudit);
  const fields=['slug','beforeProfitFactor','afterProfitFactor','beforeTrades','afterTrades','beforeRProfitFactor','afterRProfitFactor','beforeExpectancyR','afterExpectancyR','beforeMaxDrawdownR','afterMaxDrawdownR'];
  fs.writeFileSync(path.join(dir,'comparison.csv'),fields.join(',')+'\n'+after.executionAudit.rows.map(r=>fields.map(k=>r[k]??'').join(',')).join('\n')+'\n');
  save(path.join(auditDir,'comparison.json'),after.executionAudit);
  progress({phase:'completed',strategies:after.strategies.length,dataFingerprint:hash(candles)});
  console.table(after.executionAudit.rows.map(r=>({strategy:r.slug,beforePF:r.beforeProfitFactor,afterPF:r.afterProfitFactor,beforeTrades:r.beforeTrades,afterTrades:r.afterTrades})));
  console.log('Comparison saved. Dashboard reads runtime/execution-audit/comparison.json. Account journals were not modified.');
 }catch(e){progress({phase:'failed',error:e.message});throw e;}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={loadCandles,hash};
