const {session}=require('../lib/orb-session.cjs');
const {parts}=require('../lib/session-quality.cjs');
const {timestampForWallClock}=require('../lib/ny-time.cjs');
function businessDate(index,start='2026-01-02') {let n=-1;for(let at=Date.parse(start+'T12:00Z');;at+=86400000){const date=new Date(at).toISOString().slice(0,10);if(session(date).open && ++n===index)return date;}}
function completeCash(candles){const map=new Map(candles.map(c=>[Date.parse(c.timestamp),c]));const dates=new Set(candles.map(c=>parts(c.timestamp).date));for(const date of dates){const s=session(date);if(!s.open)continue;const first=candles.find(c=>parts(c.timestamp).date===date);let last=first;const start=Date.parse(timestampForWallClock(date,'09:30'));for(let i=0;i<s.closeMinute-570;i++){const at=start+i*60000;if(map.has(at)){last=map.get(at);continue;}map.set(at,{timestamp:new Date(at).toISOString(),open:last.close,high:last.close,low:last.close,close:last.close,volume:100,instrumentId:first.instrumentId,_padding:true});}}return [...map.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));}
module.exports={businessDate,completeCash};
