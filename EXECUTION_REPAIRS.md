> **Historical record from v1.** Strategies and subsystems named here that are not in `README.md` were removed in v2; see `V2_CHANGES.md`.

# Execution repair v1

Strategy definitions, entry prices, structural stops and targets are frozen. The
existing ORB maximum stop cap is enforced by rejecting over-cap signals, never
clamping their stops. All 33 historical strategy definitions remain in place.

## Changes

1. ORB close detector and isolated forward accounts enforce maximumStopPoints.
2. Every signal-built plan gets a three-minute maximum lifetime and a final
   cash-minute exit (15:59 New York, 12:59 on reviewed early closes). Earlier
   explicit deadlines remain binding. Unfilled orders release shared reservations;
   a known pending order also expires during a feed outage. Filled positions need
   an observable price to exit: missing close data produces a flagged delayed exit.
3. Limit entry requires one tick through and includes adverse entry cost. Config
   `limitFillModel: "legacy-touch"` selects the old touch/no-entry-slippage model.
   This is an adverse-cost simulation, not a claim that an exchange would fill a
   real limit beyond its limit price.
4. ORB consumes the session on submission. Backtest, isolated forward and live use
   the same configured context count and deadlines. Forward observation latency
   can still delay availability; replay parity assumes the same observation time.
   Existing repeat-trade strategies retain their own daily stopping rules.
5. Live cache retains instrumentId. Detectors drop old-contract context and exclude
   a visible roll session. DMC hourly pivots and ATR require temporal continuity.
6. Partial cash sessions are excluded in every historical runner. UTC cache entries
   require the complete expected regular NQ minute set, including overnight time.
   Cash early-close/holiday UTC files are conservatively left uncached where their
   full Globex schedule is not reviewed. Legacy partial caches fail validation.
7. DMC market orders expire three minutes after availability.
8. Evidence gates use equal-risk R, MAE-inclusive drawdown, finite PF and complete
   risk/MAE records. Approximate expectancy SE/95% bands are reported with their
   independence assumption. At least 50 explicitly forward trades are required
   before strategy-learning may nominate a challenger; old unlabeled trades do not
   silently become verified forward evidence.
9. Regular CME weekend/daily closures are distinguished from stale data. Process
   failures, stale heartbeats and configuration errors remain visible. Calendar
   also reads the existing reviewed `runtime/feed-watchdog-closures.json` UTC
   holiday intervals. Dates without a reviewed exception use regular futures hours.
10. Bridge startup requires LIVE_STATUS_TOKEN. SHA-256 digest comparison uses
    timingSafeEqual; bind is loopback only. /healthz remains public and read-only.

## Tests and baseline

`npm test` covers execution, exact touch, expiry/risk release, early close, same-data
ORB replay parity, roll/gaps, partial cache/day exclusion, evidence and bridge auth.
Targeted regressions for each repair were run against the preceding implementation
and failed before their fixes. Existing tests that intentionally asserted touch
fills now opt into the legacy flag; historical fixtures now supply complete sessions.

The published pre-repair report retrieved 2026-10-04 UTC covered 621,003 candles,
2025-01-01 through 2026-10-03 exclusive, across 33 strategies. It completed at
2026-10-03T07:11:21.076Z. This is a baseline, not proof of repaired profitability.

## VPS rollout

Run in the existing checkout inside the existing Docker container. No journal or
balance resets are required. Open paper positions must finish before watcher reload.

```sh
git pull --ff-only origin main
npm ci
npm test
node scripts/restart-execution-watchers.cjs
```

Before restarting the bridge, configure the reverse proxy in the **same network
namespace** as the Node service to forward to `127.0.0.1:3210`. A proxy on the Docker
host cannot reach container loopback through an old published port. Adapt the
container/proxy topology first. Keep the existing private token shared with Vercel;
do not print it or paste it into chat. Set LIVE_STATUS_HOST=127.0.0.1 in .env.local
(or remove its old non-loopback override), and ensure LIVE_STATUS_TOKEN is nonempty.

```sh
node scripts/restart-status-server.cjs
```

The restart helper validates token/host before stopping the existing server. Check
the external dashboard after restarting; local /healthz alone does not verify proxy
connectivity.

## Identical-data before/after run

After rollout, run:

```sh
mkdir -p runtime/execution-audit
nohup node scripts/compare-execution-backtests.cjs > runtime/execution-audit/run.log 2>&1 < /dev/null &
```

This runner uses only saved historical candles: **no API calls or billed downloads**.
It verifies the input fingerprint against the latest saved report, archives commit
266b9dcc569e7c3882687131b12df298ba637fed, replays all strategies before and after,
and writes both reports, frozen config, progress and `comparison.csv`. If the saved
cache cannot reproduce that report, it stops without inventing data or comparing
inconsistent inputs. The full pair may take several hours. A crash leaves a lock:
inspect its PID before removing a stale lock.

```sh
cat runtime/execution-audit/progress.json
cat runtime/execution-audit/comparison.csv
```

The dashboard reads the completed comparison and shows a per-strategy PF table and
comparison chart. Repaired strategy cards use the newer completed repaired report.
Daily reports do not erase the saved comparison. Comparison dates and fingerprint
remain explicit. Existing records are preserved under their original evidence epoch.

Do not describe this repair as historically profitable until the paired run has
finished. Passing tests establish implementation behavior, not an edge.
