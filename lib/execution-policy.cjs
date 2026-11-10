const {timestampForWallClock}=require('./ny-time.cjs');
const {session}=require('./orb-session.cjs');
const VERSION='execution-repair-v3-fill-quality';
const ORDER_LIFETIME_MS=180000;
const clock=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function tradingDate(at){return clock.format(new Date(at));}
function deadlines(setup,fallbackAt){
 const available=Date.parse(setup.signalAvailableAt||'');
 const detected=Date.parse(setup.detectedAt||fallbackAt||'');
 const at=Number.isFinite(available)?available:detected+60000;
 if(!Number.isFinite(at))throw new Error('Execution policy requires signal availability');
 const origin=setup.signalOriginAvailableAt?Date.parse(setup.signalOriginAvailableAt):at;
 if(!Number.isFinite(origin))throw new Error('Execution policy requires valid signal origin');
 setup.signalOriginAvailableAt=new Date(origin).toISOString();
 setup.signalAvailableAt=new Date(at).toISOString();
 const date=tradingDate(at),cash=session(date);
 if(!cash.known||!cash.open)throw new Error(`No reviewed cash session for ${date}`);
 const minute=cash.closeMinute-1;
 const close=Date.parse(timestampForWallClock(date,`${Math.floor(minute/60)}:${String(minute%60).padStart(2,'0')}`));
 // Preserve any earlier explicit exit; no order can outlive its session.
 setup.flattenAt=new Date(Math.min(close,Date.parse(setup.flattenAt||'')||Infinity)).toISOString();
 // DMC's detector supplies a bounded fifteen-minute retest deadline. Keep it
 // anchored to the signal rather than shortening it to the generic three minutes.
 const lifetime=setup.setup?.entryModel==='dmc-level-to-level' && setup.execution==='limit-touch'?15*60000:ORDER_LIFETIME_MS;
 setup.orderExpiresAt=new Date(Math.min((setup.setup?.entryModel==='fresh-level-retest'?at:origin)+lifetime,Date.parse(setup.orderExpiresAt||'')||Infinity,Date.parse(setup.flattenAt))).toISOString();
 setup.executionPolicyVersion=VERSION;
 return setup;
}
function lookbackBars(config){return Math.max(1,Math.trunc(Number(config.live?.lookbackBars||2880)));}
function entryRiskConfig(config,decision) {
 if(decision?.risk?.allowed!==true)throw new Error(`Risk guard: ${decision?.risk?.reason||'Risk approval unavailable'}`);
 // v2: fixed risk per trade. Hard daily-loss and account-floor guards only.
 return {...config};
}
module.exports={entryRiskConfig,VERSION,ORDER_LIFETIME_MS,tradingDate,deadlines,lookbackBars};
