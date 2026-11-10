const {session}=require('./orb-session.cjs');
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(at){const p=Object.fromEntries(fmt.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
function cashCoverage(date,candles){
 const cash=session(date);if(!cash.open)return {complete:false,expected:0,actual:0,reason:cash.reason};
 const rows=candles.filter(c=>Number.isFinite(Date.parse(c?.timestamp))).filter(c=>{const p=parts(c.timestamp);return p.date===date&&p.minute>=570&&p.minute<cash.closeMinute;});
 const minutes=rows.map(c=>parts(c.timestamp).minute);
 const expected=cash.closeMinute-570,actual=new Set(minutes).size,invalid=rows.filter(c=>!validCandle(c)).length;
 const complete=actual===expected&&minutes.length===expected&&!invalid;
 return {complete,expected,actual,invalid,reason:complete?'complete':'incomplete, duplicate, or invalid cash session'};
}
// UTC cache files contain overnight minutes too. Accept only an exact reviewed
// regular-session minute set. Holiday schedules are not guessed: those days are
// fetched again, while cash backtests use the reviewed cash calendar below.
function validCandle(c) {
 return c && Number.isFinite(Date.parse(c.timestamp)) && Date.parse(c.timestamp)%60000===0
  && ['open','high','low','close'].every(k=>Number.isFinite(c[k]))
  && c.high>=Math.max(c.open,c.close,c.low) && c.low<=Math.min(c.open,c.close,c.high);
}
function cacheDayCoverage(dayStart,candles,symbol='NQ.v.0'){
 const family=String(symbol).split('.')[0];
 // CME filing 20-244 eliminated the equity 16:15–16:30 ET halt in June 2021.
 // All supported cache years (2025/26) require these open minutes.
 const expected=new Set();let reviewed=['NQ','MNQ','MGC','GC'].includes(family);
 for(let at=dayStart;at<dayStart+86400000;at+=60000){
  const p=parts(at),day=new Date(p.date+'T12:00Z').getUTCDay(),cash=session(p.date);
  if(!cash.known || (day>0&&day<6&&(!cash.open||cash.closeMinute!==960)))reviewed=false;
  const closed=day===6||(day===0&&p.minute<1080)||(day===5&&p.minute>=1020)||(p.minute>=1020&&p.minute<1080);
  if(!closed)expected.add(at);
 }
 const rows=Array.isArray(candles)?candles:[];
 const actual=new Set(rows.map(c=>Date.parse(c?.timestamp)));
 const missing=[...expected].filter(t=>!actual.has(t));
 const unexpected=[...actual].filter(t=>!expected.has(t));
 const invalid=rows.filter(c=>!validCandle(c)).length;
 const duplicates=rows.length-actual.size;
 const complete=reviewed&&!missing.length&&!unexpected.length&&!duplicates&&!invalid;
 return {complete,reviewed,expected:reviewed?expected.size:null,actual:actual.size,invalid,duplicates,
  missing:reviewed?missing.length:null,unexpected:reviewed?unexpected.length:null,
  firstMissing:reviewed&&missing.length?new Date(missing[0]).toISOString():null,
  firstUnexpected:reviewed&&unexpected.length&&Number.isFinite(unexpected[0])?new Date(unexpected[0]).toISOString():null,
  reason:!reviewed?'Futures symbol, holiday hours, or calendar year not reviewed':complete?'Complete reviewed regular UTC day':'Missing, extra, duplicate, or invalid minute candles'};
}
function cacheDayComplete(dayStart,candles,symbol='NQ.v.0'){return cacheDayCoverage(dayStart,candles,symbol).complete;}
module.exports={cashCoverage,cacheDayComplete,cacheDayCoverage,validCandle,parts};
