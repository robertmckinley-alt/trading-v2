const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {matchesFeed}=require('../scripts/feed-control.cjs');
const root=path.resolve(__dirname,'..'),script=path.join(root,'scripts/databento-live-feed.py');
test('feed stop matches exact Python, script, checkout, output and symbol only',()=>{
  assert.ok(matchesFeed(['python3','scripts/databento-live-feed.py','--output','runtime/databento-live.json'],root));
  assert.ok(matchesFeed(['/usr/bin/python3.11',script,'--output='+path.join(root,'runtime/databento-live.json'),'--symbol=NQ.v.0'],root));
  for(const args of [['bash',script],['python3',script+'-other'],['python3','another-script.py'],['python3',script,'--output','other.json'],['python3',script,'--symbol','MGC.v.0']])assert.equal(matchesFeed(args,root),false);
  assert.equal(matchesFeed(['python3',script],path.join(root,'other-checkout')),false);
  assert.ok(matchesFeed(['python3',script,'--output','runtime/databento-gold-live.json','--symbol','MGC.v.0'],root,'MGC.v.0','runtime/databento-gold-live.json'));
});
