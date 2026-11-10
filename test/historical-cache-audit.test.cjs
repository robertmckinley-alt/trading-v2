const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {cacheDayCoverage,cacheDayComplete,parts}=require('../lib/session-quality.cjs');
const {cacheIdentity,auditHistoricalCache}=require('../lib/historical-cache-audit.cjs');
function dayCandles(date){const start=Date.parse(date);return Array.from({length:1440},(_,i)=>start+i*60000).filter(t=>{const m=parts(t).minute;return !(m>=1020&&m<1080);}).map(t=>({timestamp:new Date(t).toISOString(),open:100,high:101,low:99,close:100}));}
test('UTC cache coverage distinguishes absent minutes, unexpected halt candles, duplicates and invalid prices',()=>{
 const start=Date.parse('2026-10-06'),rows=dayCandles('2026-10-06');
 assert.equal(cacheDayComplete(start,rows),true);
 const missing=cacheDayCoverage(start,rows.slice(1));assert.equal(missing.missing,1);assert.equal(missing.firstMissing,rows[0].timestamp);
 const extra=cacheDayCoverage(start,[...rows,{...rows[0],timestamp:'2026-10-06T21:00:00Z'}]);assert.equal(extra.unexpected,1);assert.equal(extra.complete,false);
 assert.equal(cacheDayCoverage(start,[...rows,rows[0]]).duplicates,1);
 const invalid=structuredClone(rows);invalid[0].low=102;assert.equal(cacheDayCoverage(start,invalid).invalid,1);assert.equal(cacheDayComplete(start,invalid),false);
});
test('holiday UTC cache coverage explicitly remains unreviewed, not silently complete',()=>{
 const r=cacheDayCoverage(Date.parse('2026-12-25'),[]);assert.equal(r.reviewed,false);assert.equal(r.expected,null);assert.equal(r.complete,false);
});
test('read-only audit exposes missing tail days and corruption without changing persisted data',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-audit-')),config={live:{ticker:'NQ.v.0'}},identity=cacheIdentity(config);
 const dir=path.join(root,'runtime/historical-candles',createHash('sha256').update(identity).digest('hex'));fs.mkdirSync(dir,{recursive:true});
 try{
  const candles=dayCandles('2026-10-06');const saved=JSON.stringify({identity,candles,checksum:createHash('sha256').update(JSON.stringify(candles)).digest('hex')});
  const file=path.join(dir,'2026-10-06.json');fs.writeFileSync(file,saved);
  const window={start:'2026-10-06T00:00:00Z',end:'2026-10-08T00:00:00Z'};
  const audit=auditHistoricalCache(root,config,window);assert.deepEqual(audit.summary,{complete:1,missing:1});assert.equal(audit.last,'2026-10-06T23:59:00.000Z');assert.equal(audit.persistedUtcDaysComplete,false);assert.equal(audit.days[1].date,'2026-10-07');assert.equal(fs.readFileSync(file,'utf8'),saved);
  fs.writeFileSync(file,saved.replace('"checksum":"','"checksum":"wrong'));
  assert.equal(auditHistoricalCache(root,config,window).days[0].status,'corrupt');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('cash coverage rejects invalid prices even when all 390 timestamps are present',()=>{
 const q=require('../lib/session-quality.cjs'),rows=dayCandles('2026-10-06');assert.equal(q.cashCoverage('2026-10-06',rows).complete,true);rows.find(c=>c.timestamp==='2026-10-06T14:00:00.000Z').high=0;const coverage=q.cashCoverage('2026-10-06',rows);assert.equal(coverage.actual,390);assert.equal(coverage.invalid,1);assert.equal(coverage.complete,false);
});

test('NQ and Gold both require the former afternoon halt minutes in 2025/26',()=>{
 const start=Date.parse('2026-10-06'),rows=dayCandles('2026-10-06');
 const missing=rows.filter(c=>{const m=parts(c.timestamp).minute;return !(m>=975&&m<990);});
 for(const symbol of ['NQ.v.0','MNQ.v.0','MGC.v.0','GC.v.0']){
  assert.equal(cacheDayCoverage(start,missing,symbol).missing,15);
  assert.equal(cacheDayComplete(start,rows,symbol),true);
 }
 assert.equal(cacheDayCoverage(start,rows,'UNKNOWN').reviewed,false);
});
test('market clock remains open through the obsolete NQ halt and closes for actual maintenance',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clock-audit-'));
 try{const {clock}=require('../lib/market-feed-status.cjs');
  assert.equal(clock(new Date('2026-10-15T20:20:00Z'),root,'NQ.v.0').regularMarketClosed,false);
  assert.equal(clock(new Date('2026-10-15T21:20:00Z'),root,'NQ.v.0').regularMarketClosed,true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('1380-minute persisted NQ day is reused with zero API calls; obsolete 1365-minute day is a miss',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-reuse-')),cacheDir=path.join(root,'history'),config={live:{ticker:'NQ.v.0'}},identity=cacheIdentity(config);
 const dir=path.join(cacheDir,createHash('sha256').update(identity).digest('hex'));fs.mkdirSync(dir,{recursive:true});
 const start=Date.parse('2026-10-01'),file=path.join(dir,'2026-10-01.json'),candles=dayCandles('2026-10-01');
 const save=rows=>fs.writeFileSync(file,JSON.stringify({identity,dayStart:start,candles:rows,checksum:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}));
 const options={cacheDir,env:{},window:{start:'2026-10-01T00:00:00Z',end:'2026-10-02T00:00:00Z'},now:new Date('2026-10-15'),fetchImpl:()=>{throw new Error('Network must not be called');}};
 try{
  save(candles);assert.equal(candles.length,1380);
  const result=await require('../lib/historical-data.cjs').fetchDatabentoHistoricalCandles(options);assert.equal(result.candles.length,1380);assert.deepEqual(result.candles,candles);
  save(candles.filter(c=>{const m=parts(c.timestamp).minute;return !(m>=975&&m<990);}));
  await assert.rejects(require('../lib/historical-data.cjs').fetchDatabentoHistoricalCandles(options),/missing from the local cache/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
