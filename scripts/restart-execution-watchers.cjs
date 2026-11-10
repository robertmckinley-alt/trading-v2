#!/usr/bin/env node
// Restart only already-enabled paper watchers and the existing NQ feed.
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 process.chdir(root);require('dotenv').config({path:process.env.ENV_FILE||path.join(root,'.env.local'),quiet:true});
 const registry=require('../lib/strategy-registry.cjs'),{matchingPids}=require('../lib/watcher-process.cjs');
 const preservePlans=process.argv.includes('--profit-preservation');
 const orderWindowsOnly=process.argv.includes('--order-windows');
 const affected=new Set(['nq-fresh-level-retest']);
 const plans=registry.getStrategyDefinitions(root).filter(s=>!orderWindowsOnly||affected.has(s.slug)).map(s=>({slug:s.slug,files:registry.runtimeFilesForStrategy(root,s.slug),pids:matchingPids(s.slug,root)})).filter(s=>s.pids?.length);
 const backup=path.join(root,'runtime/execution-audit',`state-backup-${Date.now()}`);fs.mkdirSync(backup,{recursive:true});
 // Validate all active accounts before stopping any writer. A filled paper plan
 // must finish under its existing execution version; no reset or reinterpretation.
 for(const s of plans){const file=s.files.statePath;if(fs.existsSync(file)){const state=JSON.parse(fs.readFileSync(file));if(!preservePlans&&state.live?.openPlan)throw new Error(`${s.slug} has an active plan. Rollout left all watchers running; finish or review that plan first.`);fs.copyFileSync(file,path.join(backup,path.basename(file)));}}
 for(const s of plans){
  for(const pid of s.pids)if(matchingPids(s.slug,root).includes(pid))process.kill(pid,'SIGTERM');
  for(let n=0;n<50&&matchingPids(s.slug,root).some(p=>s.pids.includes(p));n++)await wait(100);
  if(matchingPids(s.slug,root).some(p=>s.pids.includes(p)))throw new Error(`${s.slug} did not stop; no duplicate started`);
  if(!matchingPids(s.slug,root).length){const fd=fs.openSync(s.files.logPath,'a');const child=spawn(process.execPath,['paper-trader.cjs','watch-live','--provider=databento-live','--interval=60000',`--strategy=${s.slug}`],{cwd:root,env:process.env,detached:true,stdio:['ignore',fd,fd]});child.on('error',e=>console.error(e.message));child.unref();fs.closeSync(fd);}
  console.log(`Reloaded ${s.slug}; journal preserved`);
 }
 if(preservePlans){console.log(`Reloaded ${plans.length} watchers. Existing plans and journals retained. Feed retained. Backup: ${backup}`);return;}
 if(orderWindowsOnly){console.log(`Reloaded ${plans.length} affected watchers. Backup: ${backup}. Feed and other watchers retained.`);return;}
 const {feedPids}=require('./feed-control.cjs');const oldFeed=feedPids();
 for(const pid of oldFeed)if(feedPids().includes(pid))process.kill(pid,'SIGTERM');
 for(let n=0;n<50&&feedPids().some(p=>oldFeed.includes(p));n++)await wait(100);
 if(feedPids().some(p=>oldFeed.includes(p)))throw new Error('Old NQ feed did not stop');
 if(oldFeed.length&&!feedPids().length){const cfg=require('../config.json'),fd=fs.openSync(path.join(root,'runtime/databento-live-feed.log'),'a');const child=spawn(cfg.live.pythonBin||'python3',['scripts/databento-live-feed.py','--output',cfg.live.liveCachePath||'runtime/databento-live.json','--dataset',cfg.live.dataset||'GLBX.MDP3','--symbol',cfg.live.ticker||'NQ.v.0'],{cwd:root,env:process.env,detached:true,stdio:['ignore',fd,fd]});child.on('error',e=>console.error(e.message));child.unref();fs.closeSync(fd);}
 console.log(`Backup: ${backup}. Verify new heartbeats on the dashboard. No strategies were added or removed.`);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
