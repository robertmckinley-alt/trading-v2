'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import ExecutionComparison from './execution-comparison';
import FreshLevelHistory from './fresh-level-history';

const STORAGE_KEY = 'doctortrades-since-2025-backtest-v1';

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}

function recommendationClass(value) {
  if (value === 'ADVANCE TO FORWARD TEST') return 'research-verdict-good';
  if (value === 'REJECT CURRENT RULES') return 'research-verdict-bad';
  return 'research-verdict-warn';
}

function BacktestCard({ strategy, validation, qualification }) {
  const [accountView, setAccountView] = useState(false);
  const research = strategy.research;
  const source = accountView ? strategy : research;
  const review = source?.review;
  if (!review) return <article className="backtest-card"><h2>{strategy.name}</h2><p>Full-history research results need an updated VPS run. The older account-limited result is not being presented as full-history performance.</p><details><summary>Previous guarded account result</summary><p>{strategy.metrics.trades} trades · {money(strategy.metrics.netPnlUsd)} net P&amp;L</p></details></article>;
  const recommendation = review.recommendation === 'MORE HISTORY NEEDED' ? 'TOO FEW ACCEPTED TRADES' : review.recommendation;
  return (
    <article className="backtest-card">
      <header>
        <div><span>{strategy.family}</span><h2>{strategy.name}</h2></div>
        <strong className={`research-verdict ${recommendationClass(review.recommendation)}`}>{recommendation}</strong>
      </header>
      <p>{accountView ? 'Separate account simulation with accumulated loss limits.' : 'Full-history research. Accumulated losses never stop the simulation.'}</p>
      {qualification && <div className="research-flags"><strong>{qualification.frozenCodeChanged ? 'Paper candidate needs code review' : qualification.paperSelected ? 'Selected for independent $50,000 forward paper account' : 'Historical candidate only'}</strong><p>Retrospective screening; future paper performance remains unverified.</p>{qualification.issues?.length > 0 && <ul>{qualification.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}</div>}
      <button className="secondary-button" type="button" onClick={() => setAccountView(!accountView)}>{accountView ? 'Show full-history research' : 'Show account with loss limits'}</button>
      <dl className="backtest-metrics">
        <div><dt>Simulated trades</dt><dd>{review.total.trades}</dd></div>
        <div><dt>Net P&amp;L</dt><dd>{money(review.total.netPnlUsd)}</dd></div>
        <div><dt>Win rate</dt><dd>{review.total.winRate}%</dd></div>
        <div><dt>Profit factor</dt><dd>{review.total.profitFactor === null ? '—' : review.total.profitFactor.toFixed(2)}</dd></div>
        <div><dt>Expectancy</dt><dd>{money(review.total.expectancyUsd)}</dd></div>
        <div><dt>Max drawdown</dt><dd>{money(review.total.maxDrawdownUsd)}</dd></div>
        <div><dt>Trailing 30% trades</dt><dd>{review.holdout.trades}</dd></div>
        <div><dt>Trailing expectancy</dt><dd>{money(review.holdout.expectancyUsd)}</dd></div>
      </dl>
      {review.total.constantRisk && <p>Equal-risk evidence: expectancy {review.total.constantRisk.expectancyR?.toFixed(3) ?? '—'}R; standard error {review.total.constantRisk.expectancyStandardErrorR?.toFixed(3) ?? '—'}R; MAE-inclusive drawdown {review.total.constantRisk.maxDrawdownR.toFixed(2)}R. {review.total.constantRisk.bandMethod}</p>}
      {strategy.slug === 'nq-fresh-level-retest' && <FreshLevelHistory source={source} accountView={accountView} />}
      <div className="backtest-gates" aria-label={`${strategy.name} backtest gates`}>
        {Object.entries(review.gates).map(([gate, passed]) => (
          <span className={passed ? 'backtest-gate-pass' : 'backtest-gate-fail'} key={gate}>{passed ? 'Pass' : 'Fail'} · {gate.replace('lockedHoldout', 'trailingSample').replace('positiveHoldout', 'positiveTrailingSample').replace(/([A-Z])/g, ' $1')}</span>
        ))}
      </div>
      <div className="research-flags">
        <strong>Recommendation notes</strong>
        {review.redFlags.length ? <ul>{review.redFlags.map((flag) => <li key={flag}>{flag.replace(/holdout/gi, 'trailing retrospective sample')}</li>)}</ul> : <p>{review.recommendation === 'ADVANCE TO FORWARD TEST' ? 'Historical checks passed. This is a forward-paper research candidate.' : 'Review the failed checks above. This result has not passed all research gates.'}</p>}
      </div>
      {Object.keys(source.rejectionReasons || {}).length > 0 && <ul>{Object.entries(source.rejectionReasons).map(([reason, count]) => <li key={reason}>{count}: {reason}</li>)}</ul>}
      <p className="backtest-fill-note">{source.signals} signals · {source.rejectedSignals || 0} rejected by position sizing · {source.notFilled} unfilled · {strategy.rolloverDaysSkipped} rollover days skipped</p>
      {validation ? <details className="backtest-validation"><summary>Validation and overfit checks</summary>
        <dl className="backtest-metrics">
          <div><dt>Walk-forward months</dt><dd>{validation.walkForward.folds.length}</dd></div>
          <div><dt>Positive test months</dt><dd>{validation.walkForward.positiveFoldRate}%</dd></div>
          <div><dt>Walk-forward expectancy</dt><dd>{money(validation.walkForward.aggregate.expectancyUsd)}</dd></div>
          <div><dt>Double-cost expectancy</dt><dd>{money(validation.walkForward.doubledCosts.expectancyUsd)}</dd></div>
          <div><dt>Monte Carlo median drawdown</dt><dd>{money(validation.sequenceRisk.maxDrawdownUsd?.p50)}</dd></div>
          <div><dt>Monte Carlo 95% drawdown</dt><dd>{money(validation.sequenceRisk.maxDrawdownUsd?.p95)}</dd></div>
        </dl>
        <p>Trade P&amp;L distribution: 5th percentile {money(validation.distribution.p05Usd)}, median {money(validation.distribution.medianUsd)}, 95th percentile {money(validation.distribution.p95Usd)}.</p>
        <div className="backtest-gates">{Object.entries(validation.gates).map(([gate, passed]) => <span className={passed ? 'backtest-gate-pass' : 'backtest-gate-fail'} key={gate}>{passed ? 'Pass' : 'Fail'} · {gate.replace(/([A-Z])/g, ' $1')}</span>)}</div>
      </details> : null}
    </article>
  );
}

export default function BacktestRunner({ view = 'all' }) {
  const [access, setAccess] = useState({ checking: true, configured: false, operatorConfigured: false, authenticated: false });
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let saved = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // A saved result is optional.
    }
    if (saved) Promise.resolve(saved).then(setResult);
    requestJson('/api/backtest')
      .then((data) => {
        setAccess(data);
        setProgress(data.progress);
        setPending(Boolean(data.pending));
        if (data.error) setError(data.error);
        if (data.result) {
          setResult(data.result);
          try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data.result)); } catch { /* optional cache */ }
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setAccess((current) => ({ ...current, checking: false })));
  }, []);

  useEffect(() => {
    let active = true;
    let timer;
    async function poll() {
      try {
        const data = await requestJson('/api/backtest');
        if (!active) return;
        setProgress(data.progress);
        setPending(Boolean(data.pending));
        if (data.result) {
          setResult(data.result);
          try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data.result)); } catch { /* optional */ }
        }
        setError(data.error || (data.progress?.phase === 'failed' ? data.progress.error : ''));
      } catch (err) { if (active) setError(err.message); }
      if (active) timer = setTimeout(poll, pending ? 15_000 : 60_000);
    }
    timer = setTimeout(poll, pending ? 15_000 : 60_000);
    return () => { active = false; clearTimeout(timer); };
  }, [pending]);

  async function unlock(event) {
    event.preventDefault();
    setBusy('unlock');
    setError('');
    try {
      await requestJson('/api/operator-session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode })
      });
      const status = await requestJson('/api/backtest');
      setAccess({ ...status, checking: false });
      setPasscode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runBacktest() {
    setBusy('run');
    setError('');
    try {
      const data = await requestJson('/api/backtest', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startYear: 2025 })
      });
      setPending(Boolean(data.pending));
      setProgress(data.progress);
      if (data.result) {
        setResult(data.result);
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data.result)); } catch { /* optional cache */ }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const visibleStrategies = result?.strategies || [];

  return (
    <div className="backtest-runner">
      <ExecutionComparison audit={result?.executionAudit} progress={result?.executionAuditProgress} />
      <section className="backtest-control panel" aria-labelledby="backtest-control-title">
        <div>
          <span className="section-kicker">January 2025 to present · retrospective research</span>
          <h2 id="backtest-control-title">Run every strategy against the same NQ history</h2>
          <p>Completed historical candles feed versioned experiments. Cached candles are reused on later runs.</p>
        </div>
        {access.checking ? <p role="status">Checking backtest access…</p> : !access.operatorConfigured ? (
          <p className="live-inline-meta">Results refresh automatically once per day on the private data server. The latest completed report appears below.</p>
        ) : !access.authenticated ? (
          <form className="operator-form backtest-unlock" onSubmit={unlock}>
            <label htmlFor="backtest-passcode">Operator passcode</label>
            <div>
              <input id="backtest-passcode" type="password" autoComplete="current-password" maxLength="512" required value={passcode} onChange={(event) => setPasscode(event.target.value)} />
              <button className="secondary-button" disabled={Boolean(busy)} type="submit">{busy === 'unlock' ? 'Unlocking…' : 'Unlock'}</button>
            </div>
          </form>
        ) : (
          <div className="backtest-action">
            <button className="primary-button" disabled={Boolean(busy) || pending || !access.configured} onClick={runBacktest} type="button">
              {pending ? 'Simulation in progress…' : busy === 'run' ? 'Starting simulation…' : 'Run from January 2025'}
            </button>
            {!access.configured ? <p className="live-inline-warning">Historical data is not connected yet. Add Databento access on Vercel or update the VPS bridge.</p> : null}
          </div>
        )}
        {error ? <p className="error-box" role="alert">{error}</p> : null}
        {pending && <div className="orb-progress" role="status"><strong>Simulation running</strong><p>{progress?.strategy ? `Strategy ${progress.strategyIndex} of ${progress.strategyTotal}: ${progress.strategy}` : progress?.phase || 'Preparing worker'}</p>{progress?.daysTotal ? <><progress max={progress.daysTotal} value={progress.daysCompleted || 0} /><p>{progress.daysCompleted || 0} of {progress.daysTotal} dates processed for this strategy · {progress.date || ''}</p></> : null}<small>Latest update: {progress?.updatedAt || 'waiting for first progress report'}. The previous completed report stays visible below.</small></div>}
      </section>

      {!result?.strategies?.some(s => s.slug === 'nq-fresh-level-retest') && <section className="backtest-card"><h2><Link href="/strategies/nq-fresh-level-retest">Fresh Level Retest</Link></h2><p>Registered for a separate $50,000 paper account with a $250 risk cap. Historical simulation pending on the data server. Equity, drawdown and monthly results will appear after the run completes.</p></section>}
      {result ? (
        <section className="backtest-results" aria-labelledby="backtest-results-title">
          <div className="section-heading">
            <div><span className="section-kicker">Historical simulated evidence</span><h2 id="backtest-results-title">Strategy results</h2></div>
            <p>{result.window?.startYear ? `${result.window.startYear} to present` : result.window?.year ? `${result.window.year} year to date` : `${result.window?.days || 60} days`} · {result.provenance?.tradingDates?.length ?? result.tradingDays} cash-session dates · {result.candles.toLocaleString()} candles</p>
          </div>
          <aside className="backtest-disclosure"><strong>Not verified forward trades.</strong> These results can recommend advancing a strategy to forward paper testing. They cannot promote a strategy directly to live trading.</aside>
          {result.validation ? <aside className="backtest-disclosure"><strong>Overfit controls active.</strong> Every strategy now receives rolling six-month/one-month walk-forward diagnostics, doubled-cost stress, a trade-outcome distribution, and 250-run block-bootstrap sequence testing. Parameter search remains limited to declared variants; automatic optimization is disabled.</aside> : null}
          <p>Report completed: {result.generatedAt}</p>
          {result.researchVersion !== 'all-strategy-fixed-risk-v1' && <aside className="backtest-disclosure"><strong>Updated simulation required.</strong> This saved run predates the current research version. Run a fresh simulation on the data server.</aside>}
          <p>Research results keep evaluating eligible setups through the full date range without an accumulated loss limit. Per-trade sizing and execution costs still apply. The optional guarded account view answers a different question: how a limited account would have performed.</p>
          <div className="backtest-grid">{visibleStrategies.map((strategy) => <BacktestCard key={strategy.slug} strategy={strategy} validation={result.validation?.strategies?.find(item => item.slug === strategy.slug)} />)}</div>
          <p className="backtest-method">{result.methodology} Cost model: {result.costs.slippageTicks} tick slippage per applicable fill and ${result.costs.commissionPerContractUsd} round-trip commission per contract. The trailing 30% account sample is retrospective, not an untouched holdout.</p>
        </section>
      ) : null}
    </div>
  );
}
