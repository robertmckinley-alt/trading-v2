# DoctorTrades NQ Paper Trader — v2

Paper-only NQ futures research platform, cut down on 2026-11-10 to the three strategies that were net positive in forward paper trading. It is a separate repo and deployment from v1; v1 keeps running untouched.

**Funded strategies (one $50,000 paper account each)**

| Strategy | Slug | Why it stayed |
| --- | --- | --- |
| 9AM Asia/London Sweep | `live-9am-sweep` | Only strategy with positive history (138 backtest trades, PF 1.51) and positive forward results (32 trades, PF 2.02). |
| VWAP Stretch Reversion | `nq-vwap-stretch-reversion` | Forward positive (29 trades, PF 1.54). Backtest negative (24 trades, PF 0.63): keep watching. |
| Fresh Level Retest | `nq-fresh-level-retest` | Forward positive (22 trades, 3 wins at ~13:1 reward). Backtest negative (46 trades, PF 0.35): keep watching. |

One historical-only research variant, `live-9am-sweep-min-stop` ("9AM Test: Minimum 10-Point Stop"), runs in the backtest and never trades paper.

See [V2_CHANGES.md](./V2_CHANGES.md) for what was removed and why, and for the side-by-side VPS rollout.

## What runs

- **Watchers** — `node paper-trader.cjs watch-live --strategy=<slug>` per strategy. One shared Databento live 1-minute feed (`scripts/databento-live-feed.py`).
- **Fixed-risk guard** — `lib/risk-guard.cjs`. Risk per trade is the configured dollar amount (no adaptive multipliers). New entries pause at the daily loss limit (`maxDailyLossUsd`) and at the account drawdown floor. Shared `$2,500` open-risk cap and per-family caps in `lib/portfolio-risk.cjs` still apply.
- **Status bridge** — `scripts/live-status-server.cjs` serves `/api/live-status` for the Vercel dashboard. Loopback-only; token required.
- **Backtests** — `scripts/run-backtest-worker.cjs` replays all four definitions on the same NQ history with the same cost model.
- **Dashboard** — Next.js app: `/` live board, `/strategies/<slug>`, `/backtests`, `/comparison`, `/research`.

## Install

```sh
npm ci
npm test                      # 141 Node tests
python3 test/feed-cache-test.py && python3 test/feed-watchdog.test.py && python3 test/operations-monitor.test.py && python3 test/operations-market-closure.test.py
npm run build
```

## Configuration

`config.json` holds the account model, costs, and 9AM session windows. VWAP and Fresh Level override account settings in `lib/vwap-stretch.cjs` and `lib/fresh-level-retest.cjs`.

Environment (`.env.local` on the VPS, Project Settings on Vercel):

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABENTO_API_KEY` | VPS | Live and historical candles |
| `LIVE_STATUS_TOKEN` | VPS + Vercel | Bearer token for the status bridge (required) |
| `LIVE_STATUS_PORT` | VPS | Bridge port. Use a port v1 is not using (v1 uses 3210) |
| `LIVE_STATUS_SOURCE_URL` | Vercel | Public URL of the v2 bridge |
| `LIVE_DATA_CACHE_PATH` | VPS | Optional. Point at v1's `runtime/databento-live.json` to share one Databento connection |
| `SHARED_FEED=1` | VPS shell scripts | With the above: never start or stop a feed process from this checkout |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | VPS | Optional fill/close alerts |
| `DATABASE_URL` | Vercel | Optional Neon journal (see `deploy/sql`) |

## Operate

```sh
npm run trader:watch:start    # starts the three watchers (and the feed unless SHARED_FEED=1)
npm run trader:watch:status
npm run trader:watch:stop
node scripts/strategy-watchdog.cjs      # restarts any missing watcher; safe for cron
node scripts/restart-status-server.cjs
```

Each strategy has its own state file (`state.json` for 9AM, `state-<slug>.json` otherwise), PID and log under `runtime/`. Process matching is scoped to this checkout's directory, so a v1 checkout on the same host is never touched.

## Strategy docs

- 9AM sweep: the "Strategy Contract" below and `lib/live-trader.cjs`
- [VWAP_STRETCH.md](./VWAP_STRETCH.md)
- [FRESH_LEVEL_RETEST.md](./FRESH_LEVEL_RETEST.md)
- [RESEARCH_LAB.md](./RESEARCH_LAB.md), [EXECUTION_REPAIRS.md](./EXECUTION_REPAIRS.md), [FEED_WATCHDOG.md](./FEED_WATCHDOG.md)

### 9AM strategy contract

- `NQ` / Nasdaq futures; wake at `9AM` New York
- mark `Asia` and `London` highs/lows
- liquidity sweep first, then a bullish or bearish reaction
- drop to the `1m` chart; `FVG` reversal entry back toward the other side
- stop at the swing low/high; target the next draw on liquidity

## Not a broker

Simulated fills with modeled slippage and commission. Nothing here places real orders. Historical results and 50 forward trades do not establish an edge.
