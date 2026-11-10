const test=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const path=require('node:path');
test('10: bridge exits before listening when LIVE_STATUS_TOKEN is absent',async()=>{
 const child=spawn(process.execPath,['scripts/live-status-server.cjs'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LIVE_STATUS_TOKEN:'',LIVE_STATUS_PORT:'0',ENV_FILE:'/nonexistent',DATABENTO_API_KEY:''},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);let timer;
 try{const outcome=await Promise.race([new Promise(r=>child.once('exit',code=>r(code))),new Promise(r=>timer=setTimeout(()=>r('still-listening'),1500))]);assert.equal(outcome,1);assert.match(stderr,/LIVE_STATUS_TOKEN/);}finally{clearTimeout(timer);child.kill();}
});
test('10: bridge validates authorization in constant time and permits loopback only',()=>{
 const auth=require('../lib/bridge-security.cjs');assert.throws(()=>auth.settings({}),/LIVE_STATUS_TOKEN/);
 assert.equal(auth.settings({LIVE_STATUS_TOKEN:'fixture'}).host,'127.0.0.1');assert.throws(()=>auth.settings({LIVE_STATUS_TOKEN:'fixture',LIVE_STATUS_HOST:'0.0.0.0'}),/loopback/);
 assert.equal(auth.authorized('Bearer fixture','fixture'),true);assert.equal(auth.authorized('Bearer wrong','fixture'),false);assert.equal(auth.authorized(undefined,'fixture'),false);
});
test('Docker binding requires explicit opt-in and still refuses missing authentication',()=>{
 const auth=require('../lib/bridge-security.cjs');
 assert.equal(auth.settings({LIVE_STATUS_TOKEN:'fixture',LIVE_STATUS_HOST:'0.0.0.0',LIVE_STATUS_ALLOW_CONTAINER_BIND:'true'}).host,'0.0.0.0');
 for(const flag of [undefined,'false','1'])assert.throws(()=>auth.settings({LIVE_STATUS_TOKEN:'fixture',LIVE_STATUS_HOST:'0.0.0.0',LIVE_STATUS_ALLOW_CONTAINER_BIND:flag}),/loopback/);
 assert.throws(()=>auth.settings({LIVE_STATUS_HOST:'0.0.0.0',LIVE_STATUS_ALLOW_CONTAINER_BIND:'true'}),/LIVE_STATUS_TOKEN/);
 assert.throws(()=>auth.settings({LIVE_STATUS_TOKEN:'fixture',LIVE_STATUS_HOST:'::',LIVE_STATUS_ALLOW_CONTAINER_BIND:'true'}),/loopback/);
 assert.equal(auth.authorized('Bearer wrong','fixture'),false);
});
test('listener config is opt-in, persists independently of env files, and rejects malformed config',()=>{
 const fs=require('node:fs'),os=require('node:os'),auth=require('../lib/bridge-security.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-config-')),env={LIVE_STATUS_TOKEN:'fixture'};
 try{
  assert.equal(auth.listenerEnvironment(root,env),env);
  fs.mkdirSync(path.join(root,'runtime'));
  const file=path.join(root,'runtime','bridge-listener.json');
  fs.writeFileSync(file,'{}');assert.throws(()=>auth.listenerEnvironment(root,env),/Unknown/);
  fs.writeFileSync(file,JSON.stringify({mode:'docker-published-port'}));
  if(fs.existsSync('/.dockerenv')){
   const next=auth.listenerEnvironment(root,env);assert.equal(auth.settings(next).host,'0.0.0.0');assert.deepEqual(env,{LIVE_STATUS_TOKEN:'fixture'});
  }else assert.throws(()=>auth.listenerEnvironment(root,env),/inside Docker/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
