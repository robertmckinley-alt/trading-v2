const {timingSafeEqual,createHash}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
function listenerEnvironment(root,env=process.env){
 const file=path.join(root,'runtime','bridge-listener.json');
 if(!fs.existsSync(file))return env;
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));
 if(saved.mode!=='docker-published-port')throw new Error('Unknown bridge listener mode');
 if(!fs.existsSync('/.dockerenv'))throw new Error('Docker listener override is permitted only inside Docker');
 return {...env,LIVE_STATUS_HOST:'0.0.0.0',LIVE_STATUS_ALLOW_CONTAINER_BIND:'true'};
}
function settings(env=process.env){
 const token=String(env.LIVE_STATUS_TOKEN||'').trim();if(!token)throw new Error('LIVE_STATUS_TOKEN is required; bridge was not started');
 const host=env.LIVE_STATUS_HOST||'127.0.0.1';
 const explicitContainerBind=host==='0.0.0.0' && env.LIVE_STATUS_ALLOW_CONTAINER_BIND==='true';
 if(!['127.0.0.1','::1','localhost'].includes(host) && !explicitContainerBind)throw new Error('LIVE_STATUS_HOST must be loopback unless Docker published-port binding is explicitly enabled');
 return {token,host};
}
function authorized(header,token){
 if(!token||typeof header!=='string')return false;
 const digest=s=>createHash('sha256').update(s).digest();
 return timingSafeEqual(digest(header),digest(`Bearer ${token}`));
}
module.exports={settings,authorized,listenerEnvironment};
