# Research Lab provenance and controls

The Research Lab adapts methodology concepts from
[`tradermonty/claude-trading-skills`](https://github.com/tradermonty/claude-trading-skills)
at commit `43230dbe1f52b48a8b9b30e32ce978e0023eef60` (MIT License).

No upstream Python package is installed or executed by the trading platform. The
implementation in `lib/research-lab.cjs` is a native JavaScript adaptation focused
on this platform's NQ forward-paper journals.

## Adapted concepts

- chronological training and locked holdout evaluation;
- sample-size, expectancy, profit-factor, drawdown, and degradation checks;
- data-quality checks for duplicate, malformed, and out-of-order records;
- postmortem grouping by session, side, and exit reason;
- a permanent registry that retains rejected and unfinished strategies.

## Safety boundary

The Research Lab is read-only. It consumes sanitized strategy snapshots and cannot
place orders, start watchers, change strategy rules, or increase risk. Existing
portfolio and per-trade limits remain authoritative.

## Sixty-day historical backtests

The Backtest Results page requests the most recent 60 calendar days of `NQ.v.0`
one-minute OHLCV candles from Databento's `GLBX.MDP3` historical service. It runs
the six registered strategies against the same window with the production risk,
commission, slippage, and same-candle conflict settings.

Signals are evaluated without later candles, and simulated fills start on the
next candle after confirmation. The newest 30% of simulated trades are kept as a
chronological holdout. Contract-roll transition days are skipped when instrument
metadata identifies a change.

Historical simulated trades use a separate evidence label and never increase the
forward-paper trade count. Passing 50 historical trades can only recommend that a
strategy advance to forward testing.
