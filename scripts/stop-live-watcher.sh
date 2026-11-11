#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${RUNTIME_DIR:-$ROOT_DIR/runtime}"
PID_FILE="${PID_FILE:-$RUNTIME_DIR/lucid-nq-paper-trader-watch.pid}"
FEED_PID_FILE="${FEED_PID_FILE:-$RUNTIME_DIR/databento-live-feed.pid}"
RESET_LIVE_STATE="${RESET_LIVE_STATE:-0}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

mkdir -p "$RUNTIME_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

find_existing_watcher_pid() {
  # Only a watcher whose working directory is THIS checkout is ever matched.
  # Matching by process name alone would also match a sibling checkout's watcher.
  local pid_file="$1"
  local strategy="$2"
  node scripts/watcher-control.cjs status --strategy="$strategy" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).pids||[];if(p.length)console.log(p[0]);}catch{}})' || true
}

stop_watcher() {
  local label="$1"
  local strategy="$2"
  local pid_file="$3"
  local watcher_pid
  watcher_pid="$(find_existing_watcher_pid "$pid_file" "$strategy")"
  if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
    kill "$watcher_pid"
    echo "Stopped $label watcher PID $watcher_pid"
  else
    echo "No running $label watcher found"
  fi
  rm -f "$pid_file"
}

stop_watcher "Fresh Level Retest" "nq-fresh-level-retest" "$RUNTIME_DIR/nq-fresh-level-retest-watch.pid"
stop_watcher "VWAP Stretch Reversion" "nq-vwap-stretch-reversion" "$RUNTIME_DIR/nq-vwap-stretch-reversion-watch.pid"
stop_watcher "9AM" "live-9am-sweep" "$PID_FILE"

# Only this checkout's exact feed process is ever stopped; a feed owned by another checkout is untouched.
if [[ "${SHARED_FEED:-0}" == "1" ]]; then
  echo "Shared feed mode: feed process left running."
else
  node scripts/feed-control.cjs stop || echo "No running Databento live feed found for this checkout"
fi
rm -f "$FEED_PID_FILE"

if [[ "$RESET_LIVE_STATE" == "1" ]]; then
  cd "$ROOT_DIR"
  node <<'EOF'
const fs = require('fs');
const path = require('path');
for (const filename of [
  'state.json',
  'state-nq-fresh-level-retest.json',
  'state-nq-vwap-stretch-reversion.json'
]) {
  const statePath = path.join(process.cwd(), filename);
  if (!fs.existsSync(statePath)) continue;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.live = {
    ...(state.live || {}),
    openSignalKey: null,
    openPlan: null,
    openTriggeredAt: null,
    signalHistory: []
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}
EOF
  echo "Cleared transient live signal state"
fi
