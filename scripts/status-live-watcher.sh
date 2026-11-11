#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.log}"
FEED_PID_FILE="${FEED_PID_FILE:-$RUNTIME_DIR/databento-live-feed.pid}"
FEED_LOG_FILE="${FEED_LOG_FILE:-$RUNTIME_DIR/databento-live-feed.log}"
LIVE_CACHE_PATH="${LIVE_DATA_CACHE_PATH:-$RUNTIME_DIR/databento-live.json}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

find_existing_watcher_pid() {
  # Only a watcher whose working directory is THIS checkout is ever matched.
  # Matching by process name alone would also match a sibling checkout's watcher.
  local pid_file="$1"
  local strategy="$2"
  node scripts/watcher-control.cjs status --strategy="$strategy" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).pids||[];if(p.length)console.log(p[0]);}catch{}})' || true
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && { kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1; }
}

cd "$ROOT_DIR"
mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" && ! -r "$ENV_FILE" ]]; then
  echo "Env file exists but is not readable by $(id -un): $ENV_FILE" >&2
  echo "Fix ownership/permissions, for example: sudo chown $(id -un):$(id -gn) '$ENV_FILE' && chmod 600 '$ENV_FILE'" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

echo "Repo: $ROOT_DIR"
echo "DATABENTO_API_KEY=$([[ -n "${DATABENTO_API_KEY:-}" ]] && echo set || echo missing)"
echo "LIVE_DATA_PROVIDER=${LIVE_DATA_PROVIDER:-auto}"

feed_pid="$(cat "$FEED_PID_FILE" 2>/dev/null || true)"
if [[ -n "$feed_pid" ]] && ! kill -0 "$feed_pid" 2>/dev/null; then feed_pid=""; fi
echo
echo "=== Databento live feed ==="
if is_pid_running "$feed_pid"; then
  echo "PID: $feed_pid"
  ps -fp "$feed_pid"
else
  echo "PID: not running"
fi
if [[ -f "$LIVE_CACHE_PATH" ]]; then
  echo "Cache: $LIVE_CACHE_PATH"
  CACHE_PATH="$LIVE_CACHE_PATH" node <<'EOF'
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(process.env.CACHE_PATH, 'utf8'));
console.log(JSON.stringify({
  mode: payload.mode,
  provider: payload.provider,
  updatedAt: payload.updatedAt,
  latestCandleAt: payload.latestCandleAt,
  candles: Array.isArray(payload.candles) ? payload.candles.length : 0
}, null, 2));
EOF
else
  echo "Cache: not ready"
fi
if [[ -f "$FEED_LOG_FILE" ]]; then
  echo "Recent feed log:"
  tail -n 12 "$FEED_LOG_FILE"
fi

print_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local log_file="$4"
  local state_path="$5"
  local watcher_pid
  watcher_pid="$(find_existing_watcher_pid "$pid_file" "$strategy")"
  echo
  echo "=== $label ==="
  echo "PID file: $pid_file"
  if is_pid_running "$watcher_pid"; then
    echo "PID: $watcher_pid"
    ps -fp "$watcher_pid"
  else
    echo "PID: not running"
  fi

  echo "State:"
  STATE_PATH="$state_path" node <<'EOF'
const fs = require('fs');
const statePath = process.env.STATE_PATH;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { balanceUsd: 50000, realizedPnlUsd: 0, trades: [] };
const snapshot = {
  balanceUsd: state.balanceUsd,
  realizedPnlUsd: state.realizedPnlUsd,
  openSignalKey: state.live?.openSignalKey || null,
  openTriggeredAt: state.live?.openTriggeredAt || null,
  heartbeat: state.live?.heartbeat || null,
  adaptive: state.live?.adaptive || null,
  signalHistoryCount: Array.isArray(state.live?.signalHistory) ? state.live.signalHistory.length : 0,
  trades: Array.isArray(state.trades) ? state.trades.length : 0
};
console.log(JSON.stringify(snapshot, null, 2));
EOF

  if [[ -f "$log_file" ]]; then
    echo "Recent log:"
    tail -n 20 "$log_file"
  else
    echo "Log file missing: $log_file"
  fi
}

print_watcher "Fresh Level Retest" "nq-fresh-level-retest" "$RUNTIME_DIR/nq-fresh-level-retest-watch.pid" "$RUNTIME_DIR/nq-fresh-level-retest-watch.log" "$ROOT_DIR/state-nq-fresh-level-retest.json"
print_watcher "VWAP Stretch Reversion" "nq-vwap-stretch-reversion" "$RUNTIME_DIR/nq-vwap-stretch-reversion-watch.pid" "$RUNTIME_DIR/nq-vwap-stretch-reversion-watch.log" "$ROOT_DIR/state-nq-vwap-stretch-reversion.json"
print_watcher "9AM Asia/London Sweep" "live-9am-sweep" "$PID_FILE" "$LOG_FILE" "$ROOT_DIR/state.json"

