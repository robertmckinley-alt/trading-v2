// Reload only currently running paper watchers from this checkout. Preserve state and feeds.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {STRATEGIES,runtimeFilesForStrategy}=require('../lib/strategy-registry.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function running(){return fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{
 try{const cwd=fs.readlinkSync(`/proc/${n}/cwd`),a=fs.readFileSync(`/proc/${n}/cmdline`,'utf8').split('\0').filter(Boolean);
 if(cwd!==root||path.basename(a[0]||'')!=='node'||path.resolve(cwd,a[1]||'')!==path.join(root,'paper-trader.cjs')||a[2]!=='watch-live')return [];
 const slug=a.find(x=>x.startsWith('--strategy='))?.split('=')[1]||'live-9am-sweep';
 return STRATEGIES.some(s=>s.slug===slug)?[{pid:Number(n),args:a.slice(1),slug}]:[];
 }catch{return [];}
});}
async function main(){
 process.chdir(root);fs.mkdirSync('runtime',{recursive:true});
 const old=running();
 for(const w of old){try{process.kill(w.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
 for(let i=0;i<25&&running().some(w=>old.some(o=>o.pid===w.pid));i++)await wait(200);
 const alive=running();
 for(const slug of new Set(old.map(w=>w.slug))){
  if(alive.some(w=>w.slug===slug)){console.log(slug,'still running; no duplicate started');continue;}
  const w=old.find(w=>w.slug===slug),files=runtimeFilesForStrategy(root,slug),log=fs.openSync(files.logPath,'a');
  const child=spawn(process.execPath,w.args,{cwd:root,detached:true,stdio:['ignore',log,log]});
  child.on('error',e=>{console.error(slug,e.message);process.exitCode=1;});child.unref();fs.closeSync(log);
  if(child.pid){fs.writeFileSync(files.pidPath,String(child.pid));console.log(slug,'launched',child.pid);}
 }
 console.log('Account state and journals retained. Verify watcher logs after startup.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={running};
