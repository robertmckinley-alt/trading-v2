"""Offline cache tests. No provider connection or live file mutation."""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('feed', Path(__file__).resolve().parents[1] / 'scripts/databento-live-feed.py')
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'live.json'
        self.args = SimpleNamespace(dataset='GLBX.MDP3', symbol='NQ.v.0', schema='ohlcv-1m', stype_in='continuous', max_bars=3)
        self.header = dict(mode='live', provider='databento-live', dataset=self.args.dataset, symbol=self.args.symbol, schema=self.args.schema, stypeIn=self.args.stype_in)

    def bar(self, minute):
        return dict(timestamp=f'2026-09-01T13:{minute:02d}:00Z', open=100, high=101, low=99, close=100.5, volume=100)

    def write(self, candles, **overrides):
        feed.atomic_write_json(self.path, {**self.header, **overrides, 'candles': candles})

    def test_exact_live_identity_required(self):
        for field, value in [('mode', 'historical'), ('provider', 'other'), ('symbol', 'MGC.v.0'), ('dataset', 'other'), ('schema', 'trades'), ('stypeIn', 'raw_symbol')]:
            self.write([self.bar(0)], **{field: value})
            self.assertEqual(len(feed.retained_live_bars(self.path, self.args)), 0)

    def test_retention_sorted_bounded_deduplicated(self):
        self.write([self.bar(i) for i in [4, 2, 1, 3, 4]])
        self.assertEqual([b['timestamp'] for b in feed.retained_live_bars(self.path, self.args).values()], [self.bar(i)['timestamp'] for i in [2, 3, 4]])

    def test_invalid_bars_do_not_destroy_valid_context(self):
        self.write([self.bar(1), {}, {**self.bar(2), 'volume': -1}, {**self.bar(3), 'low': 102}, {**self.bar(4), 'high': float('nan')}, {**self.bar(5), 'timestamp': '2099-01-01T00:00:00Z'}, self.bar(6)])
        self.assertEqual(len(feed.retained_live_bars(self.path, self.args)), 2)
        self.path.write_text('bad-json')
        self.assertEqual(len(feed.retained_live_bars(self.path, self.args)), 0)

    def test_older_reconnect_replay_never_regresses_latest(self):
        self.write([self.bar(i) for i in [3, 4, 5]])
        bars = feed.retained_live_bars(self.path, self.args)
        bars = feed.merge_live_bar(bars, self.bar(0), 3)
        self.assertEqual(list(bars)[-1], self.bar(5)['timestamp'])
        bars = feed.merge_live_bar(bars, {**self.bar(4), 'close': 100.75}, 3)
        self.assertEqual(list(bars)[-1], self.bar(5)['timestamp'])
        self.assertEqual(bars[self.bar(4)['timestamp']]['close'], 100.75)
        self.assertEqual(len(bars), 3)

    @unittest.skipUnless(os.name == 'posix', 'Linux writer lock')
    def test_second_writer_rejected_until_owner_releases(self):
        owner = feed.acquire_writer_lock(self.path)
        try:
            with self.assertRaisesRegex(RuntimeError, 'second cache writer'):
                feed.acquire_writer_lock(self.path)
        finally:
            owner.close()
        feed.acquire_writer_lock(self.path).close()


if __name__ == '__main__':
    unittest.main()
