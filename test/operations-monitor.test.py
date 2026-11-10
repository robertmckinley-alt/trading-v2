import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).resolve().parents[1] / 'scripts/operations-monitor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MonitorTests(unittest.TestCase):
    def sample(self):
        now = 1791309600
        return now, {
            'futures': {'ok': True, 'source': 'remote-bridge', 'generatedAt': now, 'strategies': [{'slug': 'test', 'watcher': {'processCount': 1, 'lastHeartbeatAt': now}, 'live': {'lastCandle': {'timestamp': now}}}], 'feed': {'regularMarketClosed': False}},
        }
    def test_account_state_error_alerts(self):
        now, data = self.sample()
        data['futures']['portfolioRisk'] = {'status': 'state-error', 'issues': [{'reason': 'Unreadable account'}]}
        self.assertIn('futures:risk-state', m.evaluate(data, now))

    def test_healthy_and_market_closure(self):
        now, data = self.sample()
        self.assertEqual(m.evaluate(data, now), {})
        data['futures']['feed']['regularMarketClosed'] = True
        data['futures']['strategies'][0]['live']['lastCandle']['timestamp'] = now - 86400
        self.assertEqual(m.evaluate(data, now), {})
        data['futures']['strategies'][0]['watcher']['processCount'] = 0
        self.assertIn('futures:test:process', m.evaluate(data, now))
    def test_missing_endpoint_and_stale_worker(self):
        now, data = self.sample()
        data['futures']['strategies'][0]['watcher']['lastHeartbeatAt'] = now - 301
        issues = m.evaluate(data, now)
        self.assertIn('futures:test:heartbeat', issues)
        self.assertIn('futures:unavailable', m.evaluate({}, now))
    def test_deduplication_hourly_reminder_and_recovery(self):
        issues = {'down': 'worker down'}
        fingerprint, notify = m.should_notify({}, issues, 10000)
        self.assertTrue(notify)
        prior = {'fingerprint': fingerprint, 'issues': issues, 'sentAt': 10000}
        self.assertFalse(m.should_notify(prior, issues, 10900)[1])
        self.assertTrue(m.should_notify(prior, issues, 13600)[1])
        self.assertTrue(m.should_notify(prior, {}, 10900)[1])
        self.assertFalse(m.should_notify({}, {}, 10000)[1])

if __name__ == '__main__':
    unittest.main()
