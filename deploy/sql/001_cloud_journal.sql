CREATE TABLE IF NOT EXISTS trading_journal_entries (
  id TEXT PRIMARY KEY,
  trade_date DATE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trading_journal_entries_trade_date_idx
  ON trading_journal_entries (trade_date DESC);
