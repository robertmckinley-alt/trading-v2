# VWAP Stretch Reversion

Slug: `nq-vwap-stretch-reversion`. Separate paper account. Existing strategy rules and journals are retained.

Video states: long Nasdaq at least 2 ATR below VWAP, trading a recovery toward VWAP; no mirrored short. Its reported performance has not been replicated.

Explicit implementation assumptions, absent from the video:
- Completed one-minute candles. Cash VWAP resets at 09:30 New York; typical price (H+L+C)/3 weighted by bar volume is an approximation to trade-level VWAP.
- ATR is the simple average of the previous 14 completed one-minute true ranges, excluding the signal bar. Needs complete cash-session history. No lookahead.
- New close at least 2 ATR below current VWAP, following a close above prior VWAP minus the same ATR threshold. The fresh-cross condition avoids repeatedly buying one continuous stretch.
- Next unseen minute entry, one ATR stop below the signal close, target fixed at signal-time VWAP. No additional reversal candle required. Gap beyond stop/target cancels entry.
- Scans every minute after warmup at 09:44 until 15:57 New York, earlier on reviewed half days. Leaves two minutes for live observation and an executable entry before close. Closes at the first observable bar open at/after session close. A data gap can delay this exit.
- Repeat setups allowed, one open position at a time. TWO net losing closed trades (after costs, not necessarily consecutive) stop entries until the next cash session. Wins do not reset this count.
- $50,000 starting balance; fixed 5% starting-capital loss floor at $47,500, not trailing drawdown. Up to $500 planned risk per trade, reduced to remaining floor room. Structural stops enforce planned risk; price gaps/slippage can exceed it. This account stop does not reset daily. No auto-refunding.
- Uses existing portfolio risk reservations. Adaptive performance veto/sizing does not replace the explicit two-loss rule for this strategy.

The guarded backtest uses those limits. The separate research diagnostic removes accumulated account cutoff, but keeps the two-loss session stop. These are distinct curves, not claims of future returns.

Start just this watcher with `bash scripts/start-vwap-watcher.sh` inside the existing container/repository. It does not restart the feed or other watchers. The status server needs updated code to expose the new account and trigger a 30-strategy backtest.

Any existing frozen discovery candidates detect changes to shared execution code and pause new entries for review, retaining evidence/journals. Do not delete their ledgers to bypass this review.
