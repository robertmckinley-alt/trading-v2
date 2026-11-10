#!/usr/bin/env node
// Targeted paper watcher rollout. Never resets account state or fabricates history.
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const rules=require('../lib/fresh-level-retest.cjs');
const {matchingPids}=require('../lib/watcher-process.cjs');
const {runtimeFilesForStrategy}=require('../lib/strategy-registry.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 process.chdir(root);
 require('dotenv').config({path:process.env.ENV_FILE||path.join(root,'.env.local'),quiet:true});
 const raw=require('../config.json');
 const config={...raw,...rules.ACCOUNT,strategySlug:rules.SLUG,live:{...raw.live,provider:'databento-live',lookbackBars:6000}};
 const {candles}=await require('../lib/live-trader.cjs').fetchLiveCandles(config);
 const date=rules.parts(Date.parse(candles.at(-1).timestamp)+60000).date;
 const coverage=rules.contextStatus(candles,date);
 console.log(JSON.stringify({rulesVersion:rules.VERSION,tradingDate:date,context:coverage}));
 if(!coverage.ready)throw Error('Required live history is still missing. Existing watcher left running; no guard bypassed.');
 const files=runtimeFilesForStrategy(root,rules.SLUG);
 const prior=fs.existsSync(files.statePath)?JSON.parse(fs.readFileSync(files.statePath,'utf8')):{trades:[]};
 console.log(JSON.stringify({currentDecision:rules.detect(candles,config,prior).reason||'qualifying signal; watcher will re-evaluate'}));
 const pids=matchingPids(rules.SLUG,root);
 if(pids===null)throw Error('Linux process discovery is required');
 for(const pid of pids){try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
 for(let i=0;i<40&&matchingPids(rules.SLUG,root).length;i++)await wait(250);
 if(matchingPids(rules.SLUG,root).length)throw Error('Existing watcher did not exit; refusing a duplicate');
 fs.mkdirSync(path.dirname(files.logPath),{recursive:true});
 const started=Date.now(),fd=fs.openSync(files.logPath,'a');
 const child=spawn(process.execPath,['paper-trader.cjs','watch-live','--provider=databento-live','--interval=60000',`--strategy=${rules.SLUG}`],{cwd:root,env:process.env,detached:true,stdio:['ignore',fd,fd]});
 let spawnError=null;child.on('error',e=>{spawnError=e;});child.unref();fs.closeSync(fd);
 for(let i=0;i<40;i++){
  await wait(500);if(spawnError)throw spawnError;
  const livePids=matchingPids(rules.SLUG,root);
  if(livePids.length>1)throw Error('Multiple watchers detected; inspect before proceeding');
  let state;try{state=JSON.parse(fs.readFileSync(files.statePath,'utf8'));}catch{continue;}
  if(livePids.length===1&&state.live?.heartbeat?.ok && Date.parse(state.live.heartbeat.at)>=started && state.live.scanAudit?.rulesVersion===rules.VERSION && state.live.scanAudit?.contextCoverage?.ready){
   fs.writeFileSync(files.pidPath,`${livePids[0]}\n`);
   console.log(JSON.stringify({enabled:true,paperOnly:true,pid:livePids[0],heartbeat:state.live.heartbeat.at,rulesVersion:rules.VERSION,historyReady:true}));return;
  }
 }
 throw Error(`New heartbeat not confirmed. Inspect ${files.logPath}; do not reset the journal.`);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
