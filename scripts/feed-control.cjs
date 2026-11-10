// Controls only an exact feed script, checkout, output path and symbol.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function matchesFeed(args,cwd,symbol='NQ.v.0',output='runtime/databento-live.json',checkout=root) {
  const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)||fallback;};
  return cwd===checkout && /^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(args[0]||''))
    && path.resolve(cwd,args[1]||'')===path.join(checkout,'scripts/databento-live-feed.py')
    && path.resolve(cwd,option('--output','runtime/databento-live.json'))===path.resolve(checkout,output)
    && option('--symbol','NQ.v.0')===symbol;
}
function feedPids(symbol='NQ.v.0', output='runtime/databento-live.json') {
  return fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).flatMap(p=>{
    try {
      const cwd=fs.readlinkSync(`/proc/${p}/cwd`),args=fs.readFileSync(`/proc/${p}/cmdline`,'utf8').split('\0').filter(Boolean);
      const matches=matchesFeed(args,cwd,symbol,output);
      return matches?[Number(p)]:[];
    }catch{return [];}
  });
}
async function main() {
  const symbol='NQ.v.0';
  const output='runtime/databento-live.json';
  const pids=feedPids(symbol,output);
  if(process.argv[2]==='status'){console.log(JSON.stringify({symbol,pids,count:pids.length}));return;}
  if(process.argv[2]!=='stop')throw new Error('Usage: feed-control.cjs stop|status');
  const registry=require('../lib/strategy-registry.cjs'),{assertFlat}=require('./watcher-control.cjs');
  if(pids.length)for(const s of registry.STRATEGIES)assertFlat(registry.runtimeFilesForStrategy(root,s.slug).statePath);
  for(const pid of pids)if(feedPids(symbol,output).includes(pid))try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
  const until=Date.now()+20000;
  while(feedPids(symbol,output).some(pid=>pids.includes(pid))){
    if(Date.now()>until)throw new Error('Exact feed stop timed out; no broad kill attempted');
    await new Promise(r=>setTimeout(r,100));
  }
  console.log(JSON.stringify({symbol,stopped:pids}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={feedPids,matchesFeed};
