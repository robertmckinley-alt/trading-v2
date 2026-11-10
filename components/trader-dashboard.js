'use client';

import { useEffect, useMemo, useState } from 'react';

const DEFAULT_STORAGE_KEY = 'lucid-nq-paper-trader-journal-v1';
const MAX_SETUP_CHARACTERS = 100_000;
const MAX_CSV_CHARACTERS = 2_000_000;
const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
});

const defaultSetup = {
  symbol: 'NQ',
  date: '2026-08-24',
  session: '9AM New York',
  side: 'short',
  entry: 23215.25,
  stop: 23224.75,
  targets: [23202.75, 23195.25, 23184.75],
  thesis: 'At 9AM New York, mark the Asia and London highs or lows, wait for the sweep, then take the 1-minute FVG reversal back into the next draw on liquidity.',
  setup: {
    liquiditySweep: true,
    reaction: 'bearish',
    entryModel: 'session-sweep-fvg-reversal',
    gapType: 'fvg',
    entryTimeframe: 'M1',
    activationTime: '09:00 America/New_York',
    referenceSessions: ['asia', 'london'],
    stopPlacement: 'swing-high',
    liquidityPool: 'london-or-asia-high',
    liquidityLabel: 'Asia / London session high',
    drawOnLiquidity: ['vwap', 'intraday-sell-side', 'current-week-low']
  }
};

function buildEmptyState(config) {
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: config.startingBalanceUsd,
    realizedPnlUsd: 0,
    trades: [],
    lastUpdatedAt: null
  };
}

function hydrateState(rawState, config) {
  if (!rawState) {
    return buildEmptyState(config);
  }
  const realized = Number(rawState.realizedPnlUsd || 0);
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: Number((config.startingBalanceUsd + realized).toFixed(2)),
    realizedPnlUsd: Number(realized.toFixed(2)),
    trades: Array.isArray(rawState.trades) ? rawState.trades : [],
    lastUpdatedAt: rawState.lastUpdatedAt || null
  };
}

function mergeTrades(...tradeLists) {
  const byId = new Map();
  for (const trade of tradeLists.flat()) {
    if (trade?.id) byId.set(trade.id, trade);
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt || a.date).localeCompare(String(b.createdAt || b.date)));
}

function stateFromTrades(trades, config) {
  const realizedPnlUsd = trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd || 0), 0);
  return hydrateState({
    trades,
    realizedPnlUsd,
    lastUpdatedAt: trades.at(-1)?.createdAt || null
  }, config);
}

function computeReport(state, config) {
  const totalTrades = state.trades.length;
  const wins = state.trades.filter((trade) => trade.realizedPnlUsd > 0).length;
  const losses = state.trades.filter((trade) => trade.realizedPnlUsd < 0).length;
  const floorUsd = Number((config.startingBalanceUsd * (1 - (config.maxAccountDrawdownPercent / 100))).toFixed(2));
  const drawdownRoomUsd = Number((state.balanceUsd - floorUsd).toFixed(2));
  const avgR = totalTrades
    ? Number((state.trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / totalTrades).toFixed(2))
    : 0;

  return {
    totalTrades,
    wins,
    losses,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0,
    avgR,
    floorUsd,
    drawdownRoomUsd,
    locked: drawdownRoomUsd <= 0
  };
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function formatStamp(value) {
  if (!value) return 'Fresh slate';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : timestampFormatter.format(date);
}

function StatCard({ label, value, hint }) {
  return (
    <article className="stat-card">
      <p>{label}</p>
      <h3>{value}</h3>
      <span>{hint}</span>
    </article>
  );
}

export default function TraderDashboard({
  initialConfig,
  initialSetupText,
  initialCsvText,
  storageKey = DEFAULT_STORAGE_KEY
}) {
  const [setupText, setSetupText] = useState(initialSetupText);
  const [csvText, setCsvText] = useState(initialCsvText);
  const [journalState, setJournalState] = useState(() => buildEmptyState(initialConfig));
  const [plan, setPlan] = useState(null);
  const [replayResult, setReplayResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [operatorPasscode, setOperatorPasscode] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [operator, setOperator] = useState({
    checking: true,
    configured: false,
    storageConfigured: false,
    authenticated: false,
    busy: '',
    message: '',
    error: ''
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        try {
          setJournalState(hydrateState(JSON.parse(stored), initialConfig));
        } catch {
          window.localStorage.removeItem(storageKey);
          setStorageError('The saved browser journal was unreadable, so a fresh journal was opened.');
        }
      }
      setStorageLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialConfig, storageKey]);

  useEffect(() => {
    if (!storageLoaded) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(journalState));
    } catch {
      queueMicrotask(() => {
        setStorageError('This browser could not save the journal. Export or copy important results before leaving.');
      });
    }
  }, [journalState, storageKey, storageLoaded]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/operator-session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((status) => {
        if (!cancelled) setOperator((current) => ({ ...current, ...status, checking: false }));
      })
      .catch(() => {
        if (!cancelled) setOperator((current) => ({ ...current, checking: false, error: 'Operator status is unavailable.' }));
      });
    return () => { cancelled = true; };
  }, []);

  const report = useMemo(() => computeReport(journalState, initialConfig), [journalState, initialConfig]);

  function parseSetup() {
    if (setupText.length > MAX_SETUP_CHARACTERS) {
      throw new Error('Setup JSON is too large. Keep it under 100,000 characters.');
    }
    const parsed = JSON.parse(setupText);
    return { ...defaultSetup, ...parsed, setup: { ...defaultSetup.setup, ...(parsed.setup || {}) } };
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.errors ? data.errors.join('\n') : data.error || 'Request failed');
    }
    return data;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function syncCloudJournal(localTrades = journalState.trades) {
    setOperator((current) => ({ ...current, busy: 'sync', message: '', error: '' }));
    try {
      const cloud = await requestJson('/api/journal');
      const trades = mergeTrades(cloud.trades || [], localTrades);
      if (localTrades.length) {
        await requestJson('/api/journal', {
          method: 'POST',
          body: JSON.stringify({ trades: localTrades.slice(-250) })
        });
      }
      setJournalState(stateFromTrades(trades, initialConfig));
      setOperator((current) => ({ ...current, busy: '', authenticated: true, message: `${trades.length} journal trades synchronized.`, error: '' }));
    } catch (err) {
      setOperator((current) => ({ ...current, busy: '', error: err.message, message: '' }));
    }
  }

  async function handleOperatorSignIn(event) {
    event.preventDefault();
    setOperator((current) => ({ ...current, busy: 'signin', message: '', error: '' }));
    try {
      const status = await requestJson('/api/operator-session', {
        method: 'POST',
        body: JSON.stringify({ passcode: operatorPasscode })
      });
      setOperatorPasscode('');
      setOperator((current) => ({ ...current, ...status, busy: '', authenticated: true }));
      await syncCloudJournal();
    } catch (err) {
      setOperator((current) => ({ ...current, busy: '', error: err.message, message: '' }));
    }
  }

  async function handleOperatorSignOut() {
    setOperator((current) => ({ ...current, busy: 'signout', message: '', error: '' }));
    try {
      const status = await requestJson('/api/operator-session', { method: 'DELETE' });
      setOperator((current) => ({ ...current, ...status, busy: '', message: 'Cloud journal locked.', error: '' }));
    } catch (err) {
      setOperator((current) => ({ ...current, busy: '', error: err.message }));
    }
  }

  async function persistCloudTrade(trade) {
    if (!operator.authenticated || !operator.storageConfigured) return;
    try {
      await requestJson('/api/journal', {
        method: 'POST',
        body: JSON.stringify({ trades: [trade] })
      });
      setOperator((current) => ({ ...current, message: 'New trade saved to the cloud journal.', error: '' }));
    } catch (err) {
      setOperator((current) => ({ ...current, error: `Browser save succeeded; cloud save failed: ${err.message}` }));
    }
  }

  async function handlePlan() {
    setBusy('plan');
    setError('');
    try {
      const setup = parseSetup();
      const data = await postJson('/api/plan', { setup, journalState });
      setPlan(data.plan);
      setReplayResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function handleReplay({ saveTrade }) {
    setBusy(saveTrade ? 'journal' : 'replay');
    setError('');
    try {
      if (csvText.length > MAX_CSV_CHARACTERS) {
        throw new Error('CSV input is too large. Keep it under 2 MB for browser replay.');
      }
      const setup = parseSetup();
      const data = await postJson('/api/replay', { setup, csvText, journalState, journalTrade: saveTrade });
      setPlan(data.plan);
      setReplayResult(data.replayResult);
      if (saveTrade && data.trade) {
        setJournalState((current) => hydrateState({
          ...current,
          trades: [...current.trades, data.trade],
          realizedPnlUsd: Number((current.realizedPnlUsd + data.trade.realizedPnlUsd).toFixed(2)),
          lastUpdatedAt: new Date().toISOString()
        }, initialConfig));
        void persistCloudTrade(data.trade);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function resetJournal() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setOperator((current) => ({ ...current, busy: 'reset', message: '', error: '' }));
    try {
      if (operator.authenticated && operator.storageConfigured) {
        await requestJson('/api/journal', { method: 'DELETE' });
      }
    } catch (err) {
      setOperator((current) => ({ ...current, busy: '', error: `Journal was not reset: ${err.message}` }));
      return;
    }
    const empty = buildEmptyState(initialConfig);
    setJournalState(empty);
    window.localStorage.setItem(storageKey, JSON.stringify(empty));
    setConfirmReset(false);
    setOperator((current) => ({ ...current, busy: '', message: 'Journal reset complete.', error: '' }));
  }

  return (
    <section className="dashboard-grid">
      <div className="editor-stack">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Setup JSON</p>
              <h2>Plan the exact clip model</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setSetupText(initialSetupText)}>Reload sample</button>
          </div>
          <label className="sr-only" htmlFor={`${storageKey}-setup`}>Trade setup JSON</label>
          <textarea
            id={`${storageKey}-setup`}
            maxLength={MAX_SETUP_CHARACTERS}
            value={setupText}
            onChange={(event) => setSetupText(event.target.value)}
            spellCheck="false"
          />
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">1m CSV</p>
              <h2>Replay against candles</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setCsvText(initialCsvText)}>Reload sample</button>
          </div>
          <label className="sr-only" htmlFor={`${storageKey}-csv`}>One-minute candle CSV</label>
          <textarea
            className="csv-box"
            id={`${storageKey}-csv`}
            maxLength={MAX_CSV_CHARACTERS}
            value={csvText}
            onChange={(event) => setCsvText(event.target.value)}
            spellCheck="false"
          />
        </article>

        <div className="action-row">
          <button className="primary-button" type="button" onClick={handlePlan} disabled={Boolean(busy)}>
            {busy === 'plan' ? 'Planning...' : 'Run plan'}
          </button>
          <button className="secondary-button" type="button" onClick={() => handleReplay({ saveTrade: false })} disabled={Boolean(busy)}>
            {busy === 'replay' ? 'Replaying...' : 'Replay only'}
          </button>
          <button className="secondary-button" type="button" onClick={() => handleReplay({ saveTrade: true })} disabled={Boolean(busy)}>
            {busy === 'journal' ? 'Journaling...' : 'Replay + journal'}
          </button>
        </div>
        {error ? <p className="error-box" role="alert">{error}</p> : null}
        {storageError ? <p className="live-inline-warning" role="status">{storageError}</p> : null}
      </div>

      <div className="results-stack">
        <article className="panel highlight-panel">
          <p className="eyebrow">Account guardrails</p>
          <div className="stat-grid">
            <StatCard label="Balance" value={formatUsd(journalState.balanceUsd)} hint={operator.authenticated && operator.storageConfigured ? 'Cloud and browser journal' : 'Browser-local journal state'} />
            <StatCard label="Floor" value={formatUsd(report.floorUsd)} hint="10% max drawdown floor" />
            <StatCard label="Room left" value={formatUsd(report.drawdownRoomUsd)} hint={report.locked ? 'Locked until reset' : 'Available before floor'} />
            <StatCard label="Win rate" value={`${report.winRate}%`} hint={`${report.totalTrades} journaled trades`} />
          </div>
        </article>

        <article className="panel cloud-journal-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Operator access</p>
              <h2>Cloud journal</h2>
            </div>
            <span className={operator.authenticated ? 'operator-state operator-state-good' : 'operator-state'}>
              {operator.checking ? 'Checking…' : operator.authenticated ? 'Unlocked' : 'Locked'}
            </span>
          </div>
          {!operator.configured || !operator.storageConfigured ? (
            <p className="empty-copy">
              Browser persistence remains active. Cloud sync will enable automatically after the project receives its database and operator-secret environment values.
            </p>
          ) : operator.authenticated ? (
            <div className="operator-actions">
              <p>Authorized for protected cross-device journal reads and writes.</p>
              <div className="action-row">
                <button className="secondary-button" disabled={Boolean(operator.busy)} onClick={() => syncCloudJournal()} type="button">
                  {operator.busy === 'sync' ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="ghost-button" disabled={Boolean(operator.busy)} onClick={handleOperatorSignOut} type="button">
                  {operator.busy === 'signout' ? 'Locking…' : 'Lock cloud access'}
                </button>
              </div>
            </div>
          ) : (
            <form className="operator-form" onSubmit={handleOperatorSignIn}>
              <label htmlFor={`${storageKey}-operator-passcode`}>Operator passcode</label>
              <div>
                <input
                  autoComplete="current-password"
                  id={`${storageKey}-operator-passcode`}
                  maxLength="512"
                  onChange={(event) => setOperatorPasscode(event.target.value)}
                  required
                  type="password"
                  value={operatorPasscode}
                />
                <button className="secondary-button" disabled={Boolean(operator.busy)} type="submit">
                  {operator.busy === 'signin' ? 'Unlocking…' : 'Unlock'}
                </button>
              </div>
            </form>
          )}
          {operator.message ? <p className="live-inline-meta" role="status">{operator.message}</p> : null}
          {operator.error ? <p className="live-inline-warning" role="alert">{operator.error}</p> : null}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Current plan</p>
              <h2>Sizing and narrative</h2>
            </div>
          </div>
          {plan ? (
            <div className="result-body">
              <div className="mini-grid">
                <div>
                  <span>Contracts</span>
                  <strong>{plan.sizing.maxContracts}</strong>
                </div>
                <div>
                  <span>Planned risk</span>
                  <strong>{formatUsd(plan.sizing.actualRiskUsd)}</strong>
                </div>
                <div>
                  <span>Stop distance</span>
                  <strong>{plan.sizing.stopDistancePoints} pts</strong>
                </div>
                <div>
                  <span>Model</span>
                  <strong>{plan.narrative.entryModel}</strong>
                </div>
              </div>
              <pre>{JSON.stringify(plan, null, 2)}</pre>
            </div>
          ) : (
            <p className="empty-copy">Run a plan to see contract sizing, target R multiples, and the exact rule payload sent to the engine.</p>
          )}
        </article>

        <article className="panel">
          <p className="eyebrow">Replay result</p>
          <h2>Outcome on uploaded candles</h2>
          {replayResult ? (
            <div className="result-body">
              <div className="mini-grid">
                <div>
                  <span>Status</span>
                  <strong>{replayResult.status}</strong>
                </div>
                <div>
                  <span>PnL</span>
                  <strong>{formatUsd(replayResult.realizedPnlUsd)}</strong>
                </div>
                <div>
                  <span>R multiple</span>
                  <strong>{replayResult.rMultiple}R</strong>
                </div>
                <div>
                  <span>Filled at</span>
                  <strong>{replayResult.filledAt || 'Not filled'}</strong>
                </div>
                <div>
                  <span>Max favorable</span>
                  <strong>{formatUsd(replayResult.mfeUsd)} / {replayResult.mfePoints || 0} pts</strong>
                </div>
                <div>
                  <span>Max adverse</span>
                  <strong>{formatUsd(replayResult.maeUsd)} / {replayResult.maePoints || 0} pts</strong>
                </div>
              </div>
              <pre>{JSON.stringify(replayResult, null, 2)}</pre>
            </div>
          ) : (
            <p className="empty-copy">Replay the setup to inspect fills, target hits, stop behavior, and end-of-data closes.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Journal</p>
              <h2>Vercel-safe local persistence</h2>
            </div>
            <button className="ghost-button danger" disabled={operator.busy === 'reset'} type="button" onClick={resetJournal}>
              {operator.busy === 'reset' ? 'Resetting…' : confirmReset ? 'Confirm reset' : 'Reset journal'}
            </button>
          </div>
          <div className="mini-grid journal-grid">
            <div>
              <span>Realized</span>
              <strong>{formatUsd(journalState.realizedPnlUsd)}</strong>
            </div>
            <div>
              <span>Avg R</span>
              <strong>{report.avgR}R</strong>
            </div>
            <div>
              <span>Wins / Losses</span>
              <strong>{report.wins} / {report.losses}</strong>
            </div>
            <div>
              <span>Last update</span>
              <strong>{formatStamp(journalState.lastUpdatedAt)}</strong>
            </div>
          </div>
          <div className="trade-list">
            {journalState.trades.length ? journalState.trades.slice().reverse().map((trade) => (
              <article key={trade.id} className="trade-card">
                <div>
                  <p>{trade.date} {trade.symbol} {trade.side.toUpperCase()}</p>
                  <span>{trade.exitReason}</span>
                </div>
                <strong>{formatUsd(trade.realizedPnlUsd)}</strong>
              </article>
            )) : <p className="empty-copy">No saved trades yet. Use Replay + journal to build a track record.</p>}
          </div>
        </article>
      </div>
    </section>
  );
}
