#!/usr/bin/env node
// Read-only local evidence. Never prints credentials or raw environment values.
const fs=require('node:fs'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
require('dotenv').config({path:path.join(root,'.env.local'),quiet:true});
const registry=require('../lib/strategy-registry.cjs');
const {matchingPids,inspectLockOwner}=require('../lib/watcher-process.cjs');
const issues=[];
function read(file){try{return JSON.parse(fs.readFileSync(file));}catch(e){if(e.code!=='ENOENT')issues.push({file:path.relative(root,file),issue:'unreadable JSON'});return null;}}
const workers=registry.getStrategyDefinitions(root).map(s=>{
 const files=registry.runtimeFilesForStrategy(root,s.slug),state=read(files.statePath),pids=matchingPids(s.slug);
 const lock=read(path.join(root,'runtime',`${s.slug}-watch.lock`));
 const trades=state?.trades||[],ids=trades.map(t=>t.id),sum=trades.reduce((a,t)=>a+Number(t.realizedPnlUsd||0),0);
 if(!state)issues.push({strategy:s.slug,issue:'missing or unreadable journal'});
 if(new Set(ids).size!==ids.length)issues.push({strategy:s.slug,issue:'duplicate trade IDs'});
 if(pids?.length!==1)issues.push({strategy:s.slug,issue:'missing or duplicate process'});
 return {slug:s.slug,pids,lock:lock?{pid:lock.pid,owner:inspectLockOwner(lock,root,s.slug)}:null,heartbeat:state?.live?.heartbeat?.at,lastCandle:state?.live?.heartbeat?.lastCandle?.timestamp,tradeCount:trades.length,sumRealizedPnlUsd:Math.round(sum*100)/100,openPlan:!!state?.live?.openPlan,executionPolicy:state?.live?.openPlan?.setup?.executionPolicyVersion,todayAudit:state?.live?.scanAudit?.days?.at(-1)};
});
const feeds=['databento-live.json'].map(name=>{const d=read(path.join(root,'runtime',name));const c=d?.candles||[];return {name,provider:d?.provider,mode:d?.mode,bars:c.length,first:c[0]?.timestamp,last:c.at(-1)?.timestamp,duplicateTimestamps:c.length-new Set(c.map(b=>b.timestamp)).size};});
const bt=read(path.join(root,'runtime/backtest-results.json'));
const progress=read(path.join(root,'runtime/backtest-results.json.progress.json'));
const python=spawnSync('python3',['-c','import importlib.util,json;print(json.dumps({x:importlib.util.find_spec(x) is not None for x in ["numpy","hmmlearn","databento"]}))'],{encoding:'utf8',timeout:5000});
let dependencies;try{dependencies=JSON.parse(python.stdout);}catch{dependencies={check:'failed'};}
const telegram=require('../lib/telegram-alerts.cjs').getTelegramConfig();
let revision;try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{revision='unknown';}
const disk=fs.statfsSync(root);
console.log(JSON.stringify({at:new Date().toISOString(),revision,workers,feeds,issues,pythonDependencies:dependencies,
 telegram:{configured:telegram.ready,validTokenFormat:telegram.validTokenFormat},
 backtest:{present:!!bt,generatedAt:bt?.generatedAt,window:bt?.window,keys:bt?Object.keys(bt):[],progress},
 watchdog:read(path.join(root,'runtime/strategy-watchdog-state.json')),
 diskFreeGiB:Math.round(disk.bavail*disk.bsize/1024**3*100)/100},null,2));
