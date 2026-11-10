const test=require('node:test'),assert=require('node:assert/strict');
const {readHistoricalResponse:read}=require('../lib/historical-retry.cjs');
const res=(status,body='data',retryAfter=null)=>({status,ok:status===200,text:async()=>body,headers:{get:()=>retryAfter}});
test('503 and 504 back off then succeed with bounded attempts',async()=>{
 let calls=0;const delays=[],progress=[];
 const r=await read('test',{}, {fetchImpl:async()=>res([503,504,200][calls++]),retrySleep:async m=>delays.push(m),onProgress:p=>progress.push(p)});
 assert.equal(r.body,'data');assert.equal(r.ok,true);assert.equal(calls,3);assert.deepEqual(delays,[2000,4000]);assert.equal(progress.length,2);
});
test('dropped body is retried as a whole, never returned as partial success',async()=>{
 let calls=0;const r=await read('test',{}, {fetchImpl:async()=>++calls===1?{...res(200),text:async()=>{throw new TypeError('terminated');}}:res(200,'complete'),retrySleep:async()=>{}});
 assert.equal(r.body,'complete');assert.equal(calls,2);
});
test('authentication/entitlement errors are not retried and persistent outages stop after three',async()=>{
 for(const status of [401,403,422,503]){
  let calls=0;const r=await read('test',{}, {fetchImpl:async()=>{calls++;return res(status);},retrySleep:async()=>{}});
  assert.equal(r.status,status);assert.equal(calls,status===503?3:1);
 }
});
test('Retry-After is respected and long requests do not trigger premature retries',async()=>{
 const delays=[];let calls=0;
 await read('test',{}, {fetchImpl:async()=>++calls===1?res(429,'limit','10'):res(200),retrySleep:async d=>delays.push(d)});assert.deepEqual(delays,[10000]);
 calls=0;await read('test',{}, {fetchImpl:async()=>{calls++;return res(429,'limit','120');},retrySleep:async()=>{throw Error('must not sleep');}});assert.equal(calls,1);
});
