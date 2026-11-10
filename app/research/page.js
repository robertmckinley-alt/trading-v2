import Link from 'next/link';
import AppHeader from '../../components/app-header';
import { getStrategySnapshots } from '../../lib/live-status.cjs';
import { buildResearchLab } from '../../lib/research-lab.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}

function number(value) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(2);
}

function verdictClass(verdict) {
  if (verdict === 'PAPER CANDIDATE') return 'research-verdict-good';
  if (verdict === 'REJECT') return 'research-verdict-bad';
  return 'research-verdict-warn';
}

function MetricSet({ label, metrics }) {
  return (
    <section className="research-split" aria-label={`${label} performance`}>
      <h4>{label}</h4>
      <dl>
        <div><dt>Trades</dt><dd>{metrics.trades}</dd></div>
        <div><dt>Win rate</dt><dd>{metrics.winRate}%</dd></div>
        <div><dt>Expectancy</dt><dd>{money(metrics.expectancyUsd)}</dd></div>
        <div><dt>Profit factor</dt><dd>{number(metrics.profitFactor)}</dd></div>
      </dl>
    </section>
  );
}

export default async function ResearchPage() {
  const snapshot = await getStrategySnapshots();
  const lab = buildResearchLab(snapshot);

  return (
    <main className="page-shell research-page" id="main-content">
      <AppHeader section="Evidence and review" />

      <section className="research-hero">
        <div>
          <p className="eyebrow">Independent evidence layer</p>
          <h1>Find weak strategies before they reach live capital.</h1>
          <p>This lab audits explicitly labelled forward paper trades, compares the earlier 70% with the latest 30%, and keeps failed ideas visible. This rolling split is descriptive, not a locked or untouched holdout. It cannot place trades or change execution rules.</p>
        </div>
        <aside className="research-safety">
          <strong>Paper-only boundary</strong>
          <p>Read-only analysis of closed trades. Live watchers, entries, exits, and risk sizing remain unchanged.</p>
        </aside>
      </section>

      <dl className="research-summary" aria-label="Research summary">
        <div><dt>Strategies tracked</dt><dd>{lab.summary.strategies}</dd></div>
        <div><dt>Forward closed trades</dt><dd>{lab.summary.closedTrades}</dd></div>
        <div><dt>Paper candidates</dt><dd>{lab.summary.paperCandidates}</dd></div>
        <div><dt>Data errors</dt><dd>{lab.summary.qualityErrors}</dd></div>
      </dl>

      <section className="research-section" id="strategy-reviews" aria-labelledby="strategy-reviews-title">
        <div className="section-heading">
          <div><span className="section-kicker">Backtest reviewer</span><h2 id="strategy-reviews-title">Earlier vs. latest forward sample</h2></div>
          <p>70% oldest trades / 30% newest trades</p>
        </div>
        <div className="research-review-grid">
          {lab.reports.map((report) => (
            <article className="research-review-card" key={report.slug}>
              <header>
                <div><span>{report.family}</span><h3>{report.name}</h3></div>
                <strong className={`research-verdict ${verdictClass(report.review.verdict)}`}>{report.review.verdict}</strong>
              </header>
              <p>{report.review.total.trades} explicitly labelled forward trades. {report.review.excludedTrades} legacy or replay trades excluded from validation. All journal P&amp;L: {money(report.review.allJournal.netPnlUsd)}.</p>
              <div className="research-splits">
                <MetricSet label="Earlier 70%" metrics={report.review.training} />
                <MetricSet label="Latest 30%" metrics={report.review.holdout} />
              </div>
              <dl className="research-total-row">
                <div><dt>Total P&amp;L</dt><dd>{money(report.review.total.netPnlUsd)}</dd></div>
                <div><dt>Max drawdown</dt><dd>{money(report.review.total.maxDrawdownUsd)}</dd></div>
                <div><dt>Avg R</dt><dd>{number(report.review.total.averageR)}</dd></div>
                <div><dt>Quality</dt><dd>{report.quality.ok ? 'Pass' : `${report.quality.errors} errors`}</dd></div>
              </dl>
              <div className="research-flags">
                <strong>Reviewer notes</strong>
                {report.review.redFlags.length ? (
                  <ul>{report.review.redFlags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
                ) : <p>No current red flags.</p>}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="research-section research-memory" id="memory" aria-labelledby="memory-title">
        <div className="section-heading">
          <div><span className="section-kicker">Research memory</span><h2 id="memory-title">Every hypothesis keeps its record</h2></div>
          <p>Rejected and unfinished ideas stay visible.</p>
        </div>
        <div className="research-table-wrap">
          <table>
            <thead><tr><th>Strategy</th><th>Family</th><th>Stage</th><th>Verdict</th><th>Trades</th><th>Primary reason</th></tr></thead>
            <tbody>
              {lab.registry.map((item) => (
                <tr key={item.slug}>
                  <th scope="row"><Link href={`/strategies/${item.slug}`}>{item.name}</Link></th>
                  <td>{item.family}</td><td>{item.hypothesisStage}</td><td>{item.verdict}</td><td>{item.trades}</td><td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="research-footer">
        <p>Methodology adapted for NQ paper research from TraderMonty’s MIT-licensed trading skills. Results are research evidence, not financial advice or a promise of future returns.</p>
        <a href="https://github.com/tradermonty/claude-trading-skills" target="_blank" rel="noreferrer">View upstream methodology</a>
      </footer>
    </main>
  );
}
