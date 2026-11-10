// Retry only idempotent historical reads, including a dropped response body.
const RETRY_STATUS=new Set([408,429,500,502,503,504]);
function transient(error){return ['TimeoutError','AbortError'].includes(error?.name)||/terminated|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET/i.test(String(error?.message)+' '+String(error?.cause?.code));}
async function readHistoricalResponse(url,init,options={}){
 const attempts=3,sleep=options.retrySleep||((ms)=>new Promise(r=>setTimeout(r,ms)));
 const timeout=Math.min(120000,Math.max(1000,Number(options.requestTimeoutMs)||120000));
 for(let attempt=1;attempt<=attempts;attempt++){
  let response,body,error;
  try{response=await options.fetchImpl(url,{...init,signal:AbortSignal.timeout(timeout)});body=await response.text();}
  catch(e){error=e;}
  const retry=error?transient(error):RETRY_STATUS.has(response.status);
  if(!retry||attempt===attempts){
   if(error)throw error;
   return {ok:response.ok,status:response.status,body};
  }
  const header=response?.headers?.get?.('retry-after');
  const requested=header?(Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-Date.now()):0;
  // Do not retry earlier than a provider's long Retry-After request.
  if(requested>60000)return {ok:response.ok,status:response.status,body};
  const delay=Math.max(2000*2**(attempt-1),Number.isFinite(requested)?requested:0);
  options.onProgress?.({phase:'historical-retry',attempt,nextAttempt:attempt+1,maxAttempts:attempts,status:response?.status||'connection-interrupted',delayMs:delay});
  await sleep(delay);
 }
}
module.exports={readHistoricalResponse};
