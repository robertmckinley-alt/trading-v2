#!/usr/bin/env bash
# Run on the VPS HOST. Credential export is redirected into a root-only file.
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo 'Run as root on the VPS host.'; exit 1; }
container='openclaw-anwx-openclaw-1'
project='/data/.openclaw/workspace/lucid-nq-paper-trader'
command -v python3 >/dev/null
command -v flock >/dev/null
command -v cron >/dev/null || { echo 'Host cron is required.'; exit 1; }
install -d -m 700 /etc/trading-monitor /var/lib/trading-monitor
umask 077
temp_config=$(mktemp /etc/trading-monitor/config.XXXXXX)
trap 'rm -f "$temp_config"' EXIT
docker exec -w "$project" "$container" node -e '
require("dotenv").config({path:".env.local",quiet:true});
const c=require("./lib/telegram-alerts.cjs").getTelegramConfig(process.env);
if(!c.ready||!c.validTokenFormat){console.error("Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the project .env.local first. Do not paste secrets into chat.");process.exit(1);}
process.stdout.write(JSON.stringify({botToken:c.botToken,chatId:c.chatId,messageThreadId:c.messageThreadId}));
' > "$temp_config"
docker cp "$container:$project/scripts/operations-monitor.py" /usr/local/sbin/trading-operations-monitor.py >/dev/null
chmod 700 /usr/local/sbin/trading-operations-monitor.py
python3 /usr/local/sbin/trading-operations-monitor.py --config "$temp_config" --test-alert
mv "$temp_config" /etc/trading-monitor/config.json
cat > /etc/cron.d/trading-operations-monitor <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/15 * * * * root flock -n /run/lock/trading-operations-monitor.lock python3 /usr/local/sbin/trading-operations-monitor.py >> /var/log/trading-operations-monitor.log 2>&1
EOF
chmod 644 /etc/cron.d/trading-operations-monitor
systemctl enable --now cron
cat > /etc/logrotate.d/trading-operations-monitor <<'EOF'
/var/log/trading-operations-monitor.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
echo 'Installed every 15 minutes. Telegram accepted the test alert. Host continues checking if Docker stops. A full VPS outage requires an external monitor.'
