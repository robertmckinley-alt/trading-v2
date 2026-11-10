# Feed recovery watchdog

Run the installer on the Ubuntu VPS host as root. The host cron service invokes a short-lived check inside the existing container every minute, independently of the status server. It recovers a stale NQ feed and restarts missing paper strategy watcher processes. Cron resumes after host/container restarts; it does not start a stopped container.

```bash
docker exec openclaw-anwx-openclaw-1 sh -lc 'cd /data/.openclaw/workspace/lucid-nq-paper-trader && git pull --ff-only origin main'
docker cp openclaw-anwx-openclaw-1:/data/.openclaw/workspace/lucid-nq-paper-trader/scripts/install-feed-watchdog-host.sh /tmp/install-trading-feed-watchdog.sh
bash /tmp/install-trading-feed-watchdog.sh
```

During regular futures trading hours, the watchdog restarts the NQ feed when the actual last candle exceeds five minutes of age, the cache is missing/invalid, the feed is absent, or duplicate matching feeds exist. Freshness, cache symbol/provider, process working directory, script, and output path are checked. Watchers, journals, balances, and strategies are never reset.

Recovery sends TERM, waits eight seconds, and uses KILL only if the same process identity is still present. It launches Python unbuffered, records the new PID, and marks the feed healthy only after fresh candles arrive. It retries after 10, 20, 40, then 60 minutes during persistent failures; it does not repeatedly restart a feed every minute. A successful fresh feed clears the retry counter. File locks prevent overlapping checks, and persisted deadlines survive an interrupted watchdog. This is recovery, not a guarantee against provider outages or credential/subscription failures.

The regular calendar uses America/New_York with daylight-saving handling, skips the 17:00–18:00 daily break and Friday evening through Sunday 18:00, and allows five minutes after reopening. Exchange holiday/early-close schedules are NOT inferred from cash-market holidays. Add exact UTC closure intervals to `runtime/feed-watchdog-closures.json` as needed:

```json
[{"start":"2026-12-25T00:00:00Z","end":"2026-12-25T23:00:00Z"}]
```

This is a format example, not a verified exchange schedule. Without overrides, unscheduled closures can cause bounded recovery attempts. Malformed override files abort the check visibly in the host log rather than restarting feeds.

Check installation and operation:

```bash
systemctl is-active cron
cat /etc/cron.d/trading-feed-watchdog
tail -n 20 /var/log/trading-feed-watchdog.log
docker exec openclaw-anwx-openclaw-1 cat /data/.openclaw/workspace/lucid-nq-paper-trader/runtime/feed-watchdog-status.json
```

`checkedAt` must advance every minute. Feed status is `healthy`, `recovering`, `cooldown`, `market-closed`, or `error`. Strategy status is saved in `runtime/strategy-watchdog-state.json` with values such as `running`, `starting`, `restart-cooldown`, or `duplicate-processes`. Logs remain local; no Telegram/email messages are sent. Logrotate retains four weekly host logs. The host watchdog detects a stopped container through failed cron executions in that log, but cannot recover a dead VPS. Remove `/etc/cron.d/trading-feed-watchdog` to disable automated recovery before intentionally stopping feeds.

Validation: `python3 test/feed-watchdog.test.py` (includes a real hung Python process and forced termination). Node/shell syntax checks are also required. No live feed credentials or network subscription are used in tests.
