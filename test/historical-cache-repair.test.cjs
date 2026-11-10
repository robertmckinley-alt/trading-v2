const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {repair}=require('../scripts/repair-historical-cache.cjs');
const {parts}=require('../lib/session-quality.cjs');
function rows(){const start=Date.parse('2026-10-01');return Array.from({length:1440},(_,i)=>({timestamp:new Date(start+i*60000).toISOString(),open:100,high:101,low:99,close:100,volume:2})).filter(c=>{const m=parts(c.timestamp).minute;return m<1020||m>=1080;});}
test('targeted repair downloads missing day once then reuses complete 1380-bar cache',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'target-cache-'));let calls=0;
 const fetchImpl=async()=>{calls++;return {ok:true,text:async()=>rows().map(c=>JSON.stringify({hd:{ts_event:c.timestamp},open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume})).join('\n')};};
 try{const opts={now:new Date('2026-10-15'),env:{DATABENTO_API_KEY:'test-only'},fetchImpl};
 const first=await repair(root,{live:{ticker:'NQ.v.0'}},'2026-10-01','2026-10-02',opts);assert.equal(first.complete,true,JSON.stringify(first));assert.equal(calls,1);assert.deepEqual(first.attempted,['2026-10-01']);
 const again=await repair(root,{live:{ticker:'NQ.v.0'}},'2026-10-01','2026-10-02',opts);assert.equal(again.complete,true);assert.equal(calls,1);assert.deepEqual(again.attempted,[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('repair rejects partial/current days and oversized windows before network',async()=>{
 const opts={now:new Date('2026-10-15'),fetchImpl:()=>{throw Error('must not call');}};
 await assert.rejects(repair('/tmp',{},'2026-10-01T01:00Z','2026-10-02',opts),/completed UTC/);
 await assert.rejects(repair('/tmp',{},'2026-10-01','2026-10-16',opts),/completed UTC/);
 await assert.rejects(repair('/tmp',{},'2026-01-01','2026-10-01',opts),/31 days/);
});
test('partial provider response remains unresolved and cannot be promoted to a complete cache',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'partial-cache-'));
 try{const result=await repair(root,{live:{ticker:'NQ.v.0'}},'2026-10-01','2026-10-02',{now:new Date('2026-10-15'),env:{DATABENTO_API_KEY:'test-only'},fetchImpl:async()=>({ok:true,text:async()=>rows().slice(1).map(c=>JSON.stringify({hd:{ts_event:c.timestamp},...c})).join('\n')})});
 assert.equal(result.complete,false);assert.equal(result.unresolved.length,1);assert.equal(result.after.missing,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
