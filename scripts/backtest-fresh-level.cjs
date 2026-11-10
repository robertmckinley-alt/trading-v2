#!/usr/bin/env node
// Run on the data-owning VPS. Uses cached candles, then configured Databento access.
const fs=require('node:fs'),path=require('node:path');
async function main(){
  const root=path.resolve(__dirname,'..');process.chdir(root);require('dotenv').config({path:'.env.local',quiet:true});
  const {historicalSinceYearWindow,fetchDatabentoHistoricalCandles}=require('../lib/historical-data.cjs');
  const {normalizeConfig}=require('../lib/trader-core.cjs');
  const definition=require('../lib/strategy-registry.cjs').STRATEGIES.find(s=>s.slug==='nq-fresh-level-retest');
  const window=historicalSinceYearWindow(Number(process.env.FRESH_START_YEAR||2025),new Date());
  const source=await fetchDatabentoHistoricalCandles({window,env:process.env,cacheDir:process.env.HISTORICAL_CACHE_DIR||path.join(root,'runtime','historical-candles'),onProgress:p=>console.log(JSON.stringify(p))});
  const result=require('../lib/fresh-level-backtest.cjs').run(source.candles,normalizeConfig(JSON.parse(fs.readFileSync('config.json','utf8'))),definition,{onProgress:p=>console.log(JSON.stringify(p))});
  const report={generatedAt:new Date().toISOString(),source:source.source,window:source.window,candles:source.candles.length,strategy:result};
  fs.mkdirSync('runtime',{recursive:true});fs.writeFileSync('runtime/fresh-level-backtest.json',JSON.stringify(report));
  console.log(JSON.stringify({window:report.window,account:result.metrics,diagnostic:result.research.metrics},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
