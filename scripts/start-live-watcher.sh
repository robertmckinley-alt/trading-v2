#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
LOG_FILE="${LOG_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.log}"
FEED_PID_FILE="${FEED_PID_FILE:-$RUNTIME_DIR/databento-live-feed.pid}"
FEED_LOG_FILE="${FEED_LOG_FILE:-$RUNTIME_DIR/databento-live-feed.log}"
LIVE_CACHE_PATH="${LIVE_DATA_CACHE_PATH:-$RUNTIME_DIR/databento-live.json}"
INTERVAL_MS="${INTERVAL_MS:-60000}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-0}"
ALLOW_MOCK="${ALLOW_MOCK:-0}"
# SHARED_FEED=1 reads an existing Databento cache (LIVE_DATA_CACHE_PATH) owned by another checkout and never starts or stops a feed process.
SHARED_FEED="${SHARED_FEED:-0}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

find_existing_watcher_pid() {
  local pid_file="$1"
  local pattern="$2"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && { kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1; }; then
      echo "$pid"
      return 0
    fi
  fi
  pgrep -f "$pattern" | head -n 1 || true
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

provider="${LIVE_DATA_PROVIDER:-}"
if [[ -z "$provider" ]]; then
  if [[ -n "${DATABENTO_API_KEY:-}" ]]; then
    provider="databento-live"
  elif [[ "$ALLOW_MOCK" == "1" ]]; then
    provider="mock"
  else
    echo "Refusing to start fake live watcher: DATABENTO_API_KEY is not set." >&2
    echo "Set DATABENTO_API_KEY for real live futures data, or set ALLOW_MOCK=1 for fixture replay mode." >&2
    exit 1
  fi
fi

if [[ "$provider" == "databento" ]]; then
  provider="databento-live"
fi

if [[ "$provider" == "databento-live" && -z "${DATABENTO_API_KEY:-}" ]]; then
  echo "LIVE_DATA_PROVIDER=databento-live but DATABENTO_API_KEY is not set." >&2
  exit 1
fi

start_live_feed() {
  local existing_pid
  existing_pid="$(find_existing_watcher_pid "$FEED_PID_FILE" "python3 scripts/databento-live-feed.py")"
  if [[ -n "$existing_pid" ]]; then
    echo "Stopping existing Databento live feed PID $existing_pid"
    kill "$existing_pid"
    sleep 1
  fi
  rm -f "$FEED_PID_FILE"
  touch "$FEED_LOG_FILE"
  nohup python3 scripts/databento-live-feed.py --output "$LIVE_CACHE_PATH" >>"$FEED_LOG_FILE" 2>&1 &
  local feed_pid=$!
  echo "$feed_pid" > "$FEED_PID_FILE"
  sleep 2
  if ! kill -0 "$feed_pid" 2>/dev/null; then
    echo "Databento live feed failed to start. Check $FEED_LOG_FILE" >&2
    exit 1
  fi
  echo "Started Databento live feed PID $feed_pid"
  echo "Live cache: $LIVE_CACHE_PATH"
}

reset_state() {
  local state_path="$1"
  STATE_PATH="$state_path" node <<'EOF'
const fs = require('fs');
const statePath = process.env.STATE_PATH;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { startingBalanceUsd: 50000, balanceUsd: 50000, realizedPnlUsd: 0, trades: [] };
state.live = {
  ...(state.live || {}),
  openSignalKey: null,
  openPlan: null,
  openTriggeredAt: null,
  signalHistory: []
};
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
EOF
}

start_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local log_file="$4"
  local state_path="$5"
  local interval_ms="$6"
  local pattern="node paper-trader.cjs watch-live.*--strategy=$strategy"
  if [[ "$strategy" == "live-9am-sweep" ]]; then
    pattern="node paper-trader.cjs watch-live"
  fi
  local existing_pid
  existing_pid="$(find_existing_watcher_pid "$pid_file" "$pattern")"
  if [[ -n "$existing_pid" ]]; then
    echo "Stopping existing $label watcher PID $existing_pid"
    kill "$existing_pid"
    sleep 1
  fi
  rm -f "$pid_file"
  if [[ "$RESET_LIVE_STATE" == "1" ]]; then
    reset_state "$state_path"
  fi
  touch "$log_file"
  nohup node paper-trader.cjs watch-live --provider="$provider" --interval="$interval_ms" --strategy="$strategy" >>"$log_file" 2>&1 &
  local watcher_pid=$!
  echo "$watcher_pid" > "$pid_file"
  echo "Started $label watcher PID $watcher_pid"
  echo "Provider: $provider"
  echo "Log: $log_file"
}

if [[ "$provider" == "databento-live" && "$SHARED_FEED" != "1" ]]; then
  start_live_feed
elif [[ "$SHARED_FEED" == "1" ]]; then
  echo "Shared feed mode: reading $LIVE_CACHE_PATH; no feed process started."
fi

start_watcher "Fresh Level Retest" "nq-fresh-level-retest" "$RUNTIME_DIR/nq-fresh-level-retest-watch.pid" "$RUNTIME_DIR/nq-fresh-level-retest-watch.log" "$ROOT_DIR/state-nq-fresh-level-retest.json" "$INTERVAL_MS"
start_watcher "VWAP Stretch Reversion" "nq-vwap-stretch-reversion" "$RUNTIME_DIR/nq-vwap-stretch-reversion-watch.pid" "$RUNTIME_DIR/nq-vwap-stretch-reversion-watch.log" "$ROOT_DIR/state-nq-vwap-stretch-reversion.json" "$INTERVAL_MS"
start_watcher "9AM" "live-9am-sweep" "$PID_FILE" "$LOG_FILE" "$ROOT_DIR/state.json" "$INTERVAL_MS"

