#!/usr/bin/env node
// Explicitly enables the listener needed by this installation's existing Docker
// port mapping. Does not alter tokens, Docker ports, firewalls or trading state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
async function main(){
 process.chdir(root);
 if(!fs.existsSync('/.dockerenv'))throw Error('Run this repair inside the existing Docker container');
 const envPath=process.env.ENV_FILE||path.join(root,'.env.local');
 if(fs.existsSync(envPath))require('dotenv').config({path:envPath,quiet:true});
 const auth=require('../lib/bridge-security.cjs');
 // Validate authentication before saving anything or stopping any process.
 const {token}=auth.settings({...process.env,LIVE_STATUS_HOST:'0.0.0.0',LIVE_STATUS_ALLOW_CONTAINER_BIND:'true'});
 fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
 const file=path.join(root,'runtime','bridge-listener.json');
 if(fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).mode!=='docker-published-port')throw Error('Existing listener override differs; refusing to replace it');
 const tmp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(tmp,JSON.stringify({mode:'docker-published-port'})+'\n',{mode:0o600});fs.renameSync(tmp,file);
 const result=spawnSync(process.execPath,['scripts/restart-status-server.cjs'],{cwd:root,env:process.env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('Status-service restart failed; original trading journals were not changed');
 const ip=Object.values(os.networkInterfaces()).flat().find(a=>a?.family==='IPv4'&&!a.internal)?.address;
 if(!ip)throw Error('Could not identify container IPv4 address to verify Docker-facing listener');
 const url=`http://${ip}:${Number(process.env.LIVE_STATUS_PORT||3210)}/api/live-status`;
 const denied=await fetch(url,{signal:AbortSignal.timeout(15000)});
 if(denied.status!==401)throw Error(`Authentication check failed: expected HTTP 401, got ${denied.status}`);
 const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error(`Authenticated data endpoint returned HTTP ${response.status}`);
 const data=await response.json();
 if(!Array.isArray(data.strategies)||!data.strategies.length)throw Error('Data endpoint did not return strategy accounts');
 console.log(`VERIFIED container-network access: ${data.strategies.length} accounts. Requests without the token return 401.`);
 console.log('Refresh the dashboard. External connectivity still depends on the existing Docker/firewall routing.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
