#!/usr/bin/env node
// Read-only. Never imports the historical fetcher or calls a market-data API.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function main(){
 const args=process.argv.slice(2);
 if(args.length!==0&&args.length!==2)throw new Error('Usage: node scripts/diagnose-historical-cache.cjs [START_UTC END_UTC_EXCLUSIVE]');
 const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
 const window=args.length?{start:args[0],end:args[1]}:JSON.parse(fs.readFileSync(process.env.BACKTEST_CACHE_PATH||path.join(root,'runtime/backtest-results.json'),'utf8')).window;
 console.log(JSON.stringify(require('../lib/historical-cache-audit.cjs').auditHistoricalCache(root,config,window),null,2));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
