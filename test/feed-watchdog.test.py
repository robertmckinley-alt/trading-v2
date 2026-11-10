import importlib.util
import json
from pathlib import Path
import signal
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('watchdog', Path(__file__).resolve().parents[1] / 'scripts/feed-watchdog.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)


def at(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class FeedWatchdogTests(unittest.TestCase):
    def test_schedule_dst_weekend_daily_break_and_reopening(self):
        for stamp in ['2026-09-19T16:00:00Z', '2026-09-20T21:59:00Z', '2026-09-23T21:30:00Z', '2026-09-20T22:04:00Z', '2026-12-20T22:59:00Z']:
            self.assertFalse(w.market_open(at(stamp)), stamp)
        for stamp in ['2026-09-23T14:00:00Z', '2026-09-20T22:05:00Z', '2026-12-20T23:05:00Z']:
            self.assertTrue(w.market_open(at(stamp)), stamp)

    def test_actual_candle_not_cache_heartbeat(self):
        cache = {'mode': 'live', 'provider': 'databento-live', 'symbol': 'NQ.v.0', 'updatedAt': '2026-09-23T14:00:00Z', 'latestCandleAt': '2026-09-23T14:00:00Z', 'candles': [{'timestamp': '2026-09-18T13:29:00Z'}]}
        self.assertGreater(w.candle_age(cache, 'NQ.v.0', at('2026-09-23T14:00:00Z')), 400000)
        self.assertIsNone(w.candle_age(cache, 'MGC.v.0', at('2026-09-23T14:00:00Z')))
        self.assertIsNone(w.candle_age({}, 'NQ.v.0', datetime.now(timezone.utc)))

    def test_decisions(self):
        self.assertEqual(w.decision(90, 1, 1000, {}, True), 'healthy')
        for age, count in [(400, 1), (None, 1), (60, 0), (60, 2), (-200, 1)]:
            self.assertEqual(w.decision(age, count, 1000, {}, True), 'restart')
        self.assertEqual(w.decision(400, 1, 1000, {'nextRetryAt': 1100}, True), 'cooldown')
        self.assertEqual(w.decision(400, 0, 1000, {}, False), 'market-closed')

    def test_closed_session_never_mutates_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(w, 'feed_processes', return_value=[]), patch.object(w, 'stop_processes') as stop:
                w.run(root, at('2026-09-19T14:00:00Z'))
                stop.assert_not_called()
            state = json.loads((root / 'runtime/feed-watchdog-status.json').read_text())
            self.assertEqual(state['feeds']['nq']['status'], 'market-closed')
            self.assertNotIn('gold', state['feeds'])

    def test_holiday_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'runtime').mkdir()
            (root / 'runtime/feed-watchdog-closures.json').write_text(json.dumps([{'start': '2026-09-23T00:00:00Z', 'end': '2026-09-24T00:00:00Z'}]))
            with patch.object(w, 'feed_processes', return_value=[]), patch.object(w, 'stop_processes') as stop:
                w.run(root, at('2026-09-23T14:00:00Z'))
                stop.assert_not_called()

    def test_restart_persists_cooldown_and_does_not_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(w.os.environ, {'DATABENTO_API_KEY': 'test-not-real'}), patch.object(w, 'feed_processes', return_value=[]), patch.object(w, 'stop_processes'), patch.object(w.subprocess, 'Popen') as start:
                start.return_value.pid = 1234
                w.run(root, at('2026-09-23T14:00:00Z'))
                w.run(root, at('2026-09-23T14:01:00Z'))
                self.assertEqual(start.call_count, 1)
            state = json.loads((root / 'runtime/feed-watchdog-status.json').read_text())
            self.assertEqual(state['feeds']['nq']['status'], 'cooldown')
            self.assertEqual((root / 'runtime/databento-live-feed.pid').read_text(), '1234')

    def test_key_missing_leaves_process_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(w.os.environ, {}, clear=True), patch.object(w, 'feed_processes', return_value=[(123, '456')]), patch.object(w, 'stop_processes') as stop:
                w.run(Path(directory), at('2026-09-23T14:00:00Z'))
                stop.assert_not_called()

    def test_reused_pid_is_not_signalled(self):
        with patch.object(w, 'process_identity', return_value='new-start-time'), patch.object(w.os, 'kill') as kill:
            w.stop_processes([(123, 'old-start-time')], grace=0)
            kill.assert_not_called()

    def test_process_match_isolates_nq_from_gold_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / 'scripts').mkdir()
            (root / 'scripts/databento-live-feed.py').touch()
            fake_proc = root / 'proc'
            fake_proc.mkdir()
            for pid, symbol, output in [
                ('101', 'NQ.v.0', 'runtime/databento-live.json'),
                ('202', 'MGC.v.0', 'runtime/databento-gold-live.json'),
            ]:
                entry = fake_proc / pid
                entry.mkdir()
                (entry / 'cwd').symlink_to(root, target_is_directory=True)
                args = ['python3', 'scripts/databento-live-feed.py', '--symbol', symbol, '--output', output]
                (entry / 'cmdline').write_bytes(('\0'.join(args) + '\0').encode())
            nq = w.feed_processes(root, root / 'runtime/databento-live.json', 'NQ.v.0', fake_proc)
            gold = w.feed_processes(root, root / 'runtime/databento-gold-live.json', 'MGC.v.0', fake_proc)
            self.assertEqual([pid for pid, _ in nq], [101])
            self.assertEqual([pid for pid, _ in gold], [202])

    def test_hung_feed_escalates_term_to_kill(self):
        with patch.object(w, 'process_identity', side_effect=['same', 'same', 'same']), patch.object(w.os, 'kill') as kill:
            w.stop_processes([(123, 'same')], grace=0)
            self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])


if __name__ == '__main__':
    unittest.main()
