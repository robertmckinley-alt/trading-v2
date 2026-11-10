#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p runtime
pattern='^node paper-trader.cjs watch-live --provider=databento-live --interval=60000 --strategy=nq-vwap-stretch-reversion$'
pid=$(pgrep -f "$pattern" | head -n 1 || true)
if [[ -n "$pid" ]]; then
  echo "VWAP already running as PID $pid"
else
  nohup node paper-trader.cjs watch-live --provider=databento-live --interval=60000 --strategy=nq-vwap-stretch-reversion >> runtime/nq-vwap-stretch-reversion-watch.log 2>&1 < /dev/null &
  pid=$!
  echo "VWAP launched as PID $pid; check its log for startup confirmation"
fi
echo "$pid" > runtime/nq-vwap-stretch-reversion-watch.pid
