import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('monitor',Path(__file__).resolve().parents[1]/'scripts/operations-monitor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ClosureTests(unittest.TestCase):
 def test_nq_halt_does_not_hide_other_feed_failure(self):
  now=1791318300
  futures={'ok':True,'source':'remote-bridge','generatedAt':now,'feed':{'regularMarketClosed':True},'strategies':[
   {'slug':'gold','ticker':'MGC.v.0','watcher':{'processCount':1,'lastHeartbeatAt':now,'marketClosed':False},'live':{'lastCandle':{'timestamp':now-600}}},
   {'slug':'nq','ticker':'NQ.v.0','watcher':{'processCount':1,'lastHeartbeatAt':now,'marketClosed':True},'live':{'lastCandle':{'timestamp':now-600}}}]}
  issues=m.evaluate({'futures':futures},now)
  self.assertIn('futures:gold:feed',issues);self.assertNotIn('futures:nq:feed',issues)
  del futures['strategies'][0]['watcher']['marketClosed']
  self.assertIn('futures:gold:feed',m.evaluate({'futures':futures},now))
if __name__=='__main__':unittest.main()
