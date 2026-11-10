const {test}=require('node:test'),assert=require('node:assert/strict');
const {fetchDatabentoHistoricalCandles}=require('../lib/historical-data.cjs');
const window={start:'2026-10-01T00:00:00.000Z',end:'2026-10-02T00:30:00.000Z',days:2};
const record={timestamp:'2026-10-01T23:59:00Z',open:100,high:101,low:99,close:100};
const unavailable=()=>({ok:false,status:422,text:async()=>JSON.stringify({detail:{case:'data_end_after_available_end',message:"The dataset GLBX.MDP3 has data available up to '2026-10-02 00:00:00+00:00'."}})});
test('provider cutoff retries once and reports actual end',async()=>{
 const ends=[];const result=await fetchDatabentoHistoricalCandles({window,apiKey:'test',fetchImpl:async url=>{ends.push(new URL(url).searchParams.get('end'));return ends.length===1?unavailable():{ok:true,text:async()=>JSON.stringify([record])};}});
 assert.deepEqual(ends,[window.end,'2026-10-02T00:00:00.000Z']);assert.equal(result.window.end,ends[1]);assert.equal(result.window.requestedEnd,window.end);assert.equal(result.window.days,1);
});
test('retry is bounded when provider repeats error',async()=>{
 let calls=0;await assert.rejects(fetchDatabentoHistoricalCandles({window,apiKey:'test',fetchImpl:async()=>{calls++;return unavailable();}}),/422/);assert.equal(calls,2);
});
test('other errors are not masked or retried',async()=>{
 let calls=0;await assert.rejects(fetchDatabentoHistoricalCandles({window,apiKey:'test',fetchImpl:async()=>{calls++;return {ok:false,status:401,text:async()=> 'Unauthorized'};}}),/401/);assert.equal(calls,1);
});
