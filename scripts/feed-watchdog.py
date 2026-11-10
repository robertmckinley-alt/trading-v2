#!/usr/bin/env python3
"""One-shot NQ/MGC recovery, invoked every minute by a host cron job."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
STALE_SECONDS = 300


def market_open(now):
    local = now.astimezone(ZoneInfo('America/New_York'))
    minute = local.hour * 60 + local.minute
    # Regular Globex hours, plus five minutes for completed bars after reopening.
    # Holiday/early-close overrides are supplied as explicit UTC intervals below.
    return not (local.weekday() == 5 or
                (local.weekday() == 6 and minute < 1085) or
                (local.weekday() == 4 and minute >= 1020) or
                1020 <= minute < 1085)


def parse_time(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return value


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def atomic_json(path, value):
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def candle_age(cache, symbol, now):
    if not isinstance(cache, dict) or cache.get('provider') != 'databento-live' or cache.get('mode') != 'live' or cache.get('symbol') != symbol:
        return None
    try:
        # Inspect the actual final candle, not filesystem mtime or a heartbeat.
        return (now - parse_time(cache['candles'][-1]['timestamp'])).total_seconds()
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        return None


def process_identity(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def feed_processes(root, output, symbol, proc_dir='/proc'):
    matches = []
    for entry in Path(proc_dir).iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().decode().strip('\0').split('\0')
            cwd = (entry / 'cwd').resolve()
            if cwd != root or not Path(args[0]).name.startswith('python'):
                continue
            if not any((cwd / arg).resolve() == root / 'scripts/databento-live-feed.py' for arg in args[1:3]):
                continue
            def option(name, default):
                for i, arg in enumerate(args):
                    if arg == name:
                        return args[i + 1]
                    if arg.startswith(name + '='):
                        return arg.split('=', 1)[1]
                return default
            if (cwd / option('--output', 'runtime/databento-live.json')).resolve() != output:
                continue
            if option('--symbol', 'NQ.v.0') != symbol:
                raise RuntimeError(f'Unexpected symbol on managed cache {output.name}; refusing restart')
            pid = int(entry.name)
            matches.append((pid, process_identity(pid)))
        except (OSError, IndexError, UnicodeError):
            continue
    return matches


def stop_processes(processes, grace=8):
    def alive(pid, identity):
        return identity is not None and process_identity(pid) == identity
    for pid, identity in processes:
        if alive(pid, identity):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and any(alive(*p) for p in processes):
        time.sleep(0.2)
    for pid, identity in processes:
        if alive(pid, identity):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if processes:
        time.sleep(0.5)


def decision(age, process_count, now, previous, is_open):
    if not is_open:
        return 'market-closed'
    if process_count == 1 and age is not None and 0 <= age <= STALE_SECONDS:
        return 'healthy'
    if now < previous.get('nextRetryAt', 0):
        return 'cooldown'
    return 'restart'


def run(root=ROOT, now=None):
    now = now or datetime.now(timezone.utc)
    runtime = root / 'runtime'
    runtime.mkdir(exist_ok=True)
    with (runtime / 'feed-watchdog.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        config = read_json(root / 'config.json', {})
        live = config.get('live', {})
        feeds = [('nq', live.get('ticker', 'NQ.v.0'), live.get('liveCachePath', 'runtime/databento-live.json'), 'databento-live-feed')]
        state_path = runtime / 'feed-watchdog-status.json'
        previous = read_json(state_path, {}) or {}
        result = {'checkedAt': now.isoformat(), 'feeds': {}}
        opened = market_open(now)
        # Optional exchange holiday closures: [{"start":"...Z","end":"...Z"}].
        closures_path = runtime / 'feed-watchdog-closures.json'
        if closures_path.exists():
            closures = json.loads(closures_path.read_text())
            for item in closures:
                if parse_time(item['start']) <= now < parse_time(item['end']):
                    opened = False
        for name, symbol, cache_path, label in feeds:
            old = previous.get('feeds', {}).get(name, {})
            status = dict(old)
            try:
                output = (root / cache_path).resolve()
                processes = feed_processes(root, output, symbol)
                age = candle_age(read_json(output), symbol, now)
                action = decision(age, len(processes), now.timestamp(), old, opened)
                status.update(status=action, candleAgeSeconds=age, pids=[p[0] for p in processes], symbol=symbol)
                if action == 'healthy':
                    status.update(failures=0, nextRetryAt=0, lastHealthyAt=now.isoformat())
                    status.pop('error', None)
                elif action == 'restart':
                    if not os.environ.get('DATABENTO_API_KEY', '').strip():
                        raise RuntimeError('DATABENTO_API_KEY missing; processes left untouched')
                    # Persist retry deadline BEFORE mutations so interrupted runs cannot loop.
                    failures = min(old.get('failures', 0) + 1, 7)
                    status.update(failures=failures, nextRetryAt=now.timestamp() + min(600 * 2 ** (failures - 1), 3600), lastRestartAt=now.isoformat())
                    result['feeds'][name] = status
                    atomic_json(state_path, {**previous, **result, 'feeds': {**previous.get('feeds', {}), **result['feeds']}})
                    stop_processes(processes)
                    # Another existing supervisor may have started a feed during shutdown.
                    current = feed_processes(root, output, symbol)
                    if not current:
                        with (runtime / (label + '.log')).open('ab') as log:
                            log.write(f'\n[watchdog {now.isoformat()}] restarting {name}; candle age {age}\n'.encode())
                            log.flush()
                            child = subprocess.Popen([live.get('pythonBin', 'python3'), 'scripts/databento-live-feed.py', '--output', str(output), '--symbol', symbol, '--dataset', live.get('dataset', 'GLBX.MDP3')], cwd=root, env={**os.environ, 'PYTHONUNBUFFERED': '1'}, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                        (runtime / (label + '.pid')).write_text(str(child.pid))
                        status['pids'] = [child.pid]
                    else:
                        status['pids'] = [p[0] for p in current]
                    status['status'] = 'recovering'
                if status.get('status') != old.get('status') or action == 'restart':
                    print(json.dumps({'at': now.isoformat(), 'feed': name, **status}), flush=True)
            except Exception as exc:
                status.update(status='error', error=str(exc))
                print(json.dumps({'at': now.isoformat(), 'feed': name, 'error': str(exc)}), flush=True)
            result['feeds'][name] = status
        atomic_json(state_path, result)


if __name__ == '__main__':
    run()
