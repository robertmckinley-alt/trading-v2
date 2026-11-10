> **Historical record from v1.** Strategies and subsystems named here that are not in `README.md` were removed in v2; see `V2_CHANGES.md`.

# DoctorTrades Strategy Research Register

Updated: 2026-09-02

This register treats public strategy repositories as research leads, not proof that a strategy will make money. GitHub is unbounded and changes continuously, so an exhaustive review of “all repositories” is not possible. The first screening pass prioritizes NQ/futures relevance, explicit rules, reproducible tests, honest limitations, and a license that permits reuse.

All strategies in this application are paper-only. They share the same Databento Live OHLCV stream and the same account model: $50,000 starting balance per strategy, 10% drawdown floor, $500 maximum paper risk per trade, $750 daily loss guard, modeled commission and slippage, and one trade per strategy per day.

The $2,500 network cap is supplemented by thesis-family caps: $750 for liquidity reversals, $750 for cash-session breakouts, $500 for trend momentum, and $500 for value reversion. These limits prevent several correlated bots from treating the same NQ move as independent risk.

## Installed research network

| Strategy | Research basis | Implementation status | Important limitation |
| --- | --- | --- | --- |
| 9AM Asia/London Sweep | Original DoctorTrades rules | Existing baseline; independent paper account | Results are forward paper observations, not a historical proof |
| 1H Sweep + iFVG + 1M BOS | Original DoctorTrades rules | Existing baseline; independent paper account | Pattern definitions require continued audit against live charts |
| NQ Opening Range Breakout | [giovannibrusco/nq-intraday-breakout](https://github.com/giovannibrusco/nq-intraday-breakout), MIT | Independently implemented as a 90-minute cash ORB | The repository uses a 100-point stop that cannot fit this platform's $500 NQ risk cap; this build uses a clearly labeled volatility-scaled variant |
| EMA 20/60 Momentum | [QuantConnect LEAN FuturesMomentumAlgorithm](https://github.com/QuantConnect/Lean/blob/master/Algorithm.CSharp/FuturesMomentumAlgorithm.cs), Apache-2.0 | Independently implemented on completed NQ 15-minute bars | The reference is an example, not an NQ profitability claim; this adaptation needs its own evidence |
| Volume POC Reversion | [s4g4cr/nq-quant-research](https://github.com/s4g4cr/nq-quant-research), no detected license | Concept independently implemented; no source code copied | One-minute OHLCV cannot reproduce a true tick-level volume profile, so this is explicitly a bar-volume POC proxy |
| NQ 15M Opening Range Retest | User-supplied strategy video | Independently specified as a 09:30–09:45 range break, retest within 10 one-minute bars, and aligned 5-minute EMA 8/21 order flow | The video did not define order flow, stops, or targets precisely; these implementation choices are hypotheses that must earn forward evidence |

## Video strategy decisions

- The Asia accumulation, London manipulation, and New York distribution concept is logged as context on the existing 9AM strategy. London sweeps of the Asia high or low are measured but do not alter entries until an A/B sample supports that change.
- The multi-agent trading-firm concepts are implemented as a deterministic, advisory-only research council. It records feed health, setup evidence, market regime, risk-veto state, and post-trade learning. It cannot place trades, change setup rules, or increase risk.
- The Power of Three pullback concept remains execution-disabled because the source did not specify testable trend, entry, stop, target, timeframe, and session rules.
- The hundreds-of-bots concept is not installed. A small set of named, auditable roles is easier to test and less likely to amplify one correlated error.

## Screened but not installed

| Repository | Decision | Reason |
| --- | --- | --- |
| [dws-data/nas-orb-backtester](https://github.com/dws-data/nas-orb-backtester) | Research reference only | Useful NQ ORB/retrace claims, but no license was detected; do not copy code |
| [cayao2012/ICT-bot](https://github.com/cayao2012/ICT-bot) | Not installed | Reported test covers only 41 trading days and no license was detected; overfitting and reuse risk are too high |
| [Lumiwealth/lumibot](https://github.com/Lumiwealth/lumibot) | Framework reference | A trading framework is not evidence that a strategy works; adding it would duplicate the current engine |
| [SolomonBell/strategy-foundry](https://github.com/SolomonBell/strategy-foundry) | Rejected as evidence | Its published metrics are described as simulated/synthetic and do not establish out-of-sample performance |

## Evidence gates

A bot remains in `Warming up` or `Collecting evidence` until its own forward paper journal supports evaluation. `Paper candidate` requires all of these:

- at least 50 closed paper trades
- at least 20 distinct trading days
- profit factor of at least 1.20

## Automatic challenger controls

- A baseline strategy must first close at least 20 forward paper trades and fall below a `1.00` profit factor.
- A proposed exclusion must be supported by at least five losing observations for the same side or market regime.
- Only versioned experiments in the executable catalog can create an account. Narrative recommendations remain advisory.
- Every challenger starts with a separate `$50,000` paper balance, the same `10%` drawdown pattern and portfolio/family caps, frozen parent entry rules, and its own forward journal.
- Challengers cannot create child challengers. A parent may have at most two automatic challengers.
- A watchlist strategy stays in the full-system ledger even when it is removed from focus-group headline statistics.
- positive expectancy per trade
- positive average R
- maximum test drawdown no greater than $1,500

Passing these gates does not authorize real-money execution. It only means the strategy has earned deeper review, longer walk-forward testing, parameter perturbation, and an independent data-quality audit.

## Research integrity rules

- Never merge journals between bots.
- Never delete losing trades from an evaluation window.
- Never tune a strategy on the same window used to score it.
- Record the exact fill convention, costs, session timezone, continuous-contract mapping, and same-candle stop/target rule.
- Treat missing licenses as “read concepts only”; do not copy source code.
- Keep Telegram limited to actual paper fills and closes.
- Do not connect a broker or enable real orders through this research network.
