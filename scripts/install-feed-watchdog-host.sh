#!/usr/bin/env bash
# Run on the VPS HOST, not inside Docker. Survives container/host restarts.
set -euo pipefail
if [[ "$EUID" != 0 ]]; then echo 'Run as root on the VPS host.' >&2; exit 1; fi
container='openclaw-anwx-openclaw-1'
project='/data/.openclaw/workspace/lucid-nq-paper-trader'
docker_bin="$(command -v docker)"
command -v flock >/dev/null
docker exec "$container" test -f "$project/scripts/feed-watchdog.cjs"
if ! command -v cron >/dev/null; then
  echo 'Install cron first: apt-get update && apt-get install -y cron' >&2
  exit 1
fi
systemctl enable --now cron
cat > /usr/local/sbin/trading-feed-watchdog <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/trading-feed-watchdog.lock
flock -n 9 || exit 0
"$docker_bin" exec -w "$project" "$container" node scripts/feed-watchdog.cjs
EOF
chmod 755 /usr/local/sbin/trading-feed-watchdog
cat > /etc/cron.d/trading-feed-watchdog <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root /usr/local/sbin/trading-feed-watchdog >> /var/log/trading-feed-watchdog.log 2>&1
EOF
chmod 644 /etc/cron.d/trading-feed-watchdog
cat > /etc/logrotate.d/trading-feed-watchdog <<'EOF'
/var/log/trading-feed-watchdog.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
/usr/local/sbin/trading-feed-watchdog
docker exec "$container" cat "$project/runtime/feed-watchdog-status.json"
echo 'Installed: host cron checks the NQ feed every minute.'
