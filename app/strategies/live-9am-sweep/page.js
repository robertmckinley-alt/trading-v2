import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import AppHeader from '../../../components/app-header';
import LiveStrategyBoard from '../../../components/live-strategy-board';
import TraderDashboard from '../../../components/trader-dashboard';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { normalizeConfig } from '../../../lib/trader-core.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LiveNineAmSweepPage() {
  const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')));
  const sampleSetup = fs.readFileSync(path.join(process.cwd(), 'examples', 'lucid-sweep-short.setup.json'), 'utf8');
  const liveFixture = fs.readFileSync(path.join(process.cwd(), 'examples', 'live-signal-nq-1m.csv'), 'utf8');
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell" id="main-content">
      <AppHeader section="Paper Account A · strategy detail" />
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Strategy A · 9AM session sweep</p>
          <h1>Asia and London liquidity, monitored live.</h1>
          <p className="hero-lede">
            The watcher builds the overnight ranges, waits for a post-9AM sweep, confirms the one-minute FVG reversal,
            and sizes the paper trade within the account risk limits.
          </p>
          <div className="hero-badges">
            <span>Automated watcher</span>
            <span>{config.startingBalanceUsd.toLocaleString()} USD account</span>
            <span>{config.maxAccountDrawdownPercent}% max drawdown</span>
          </div>
          <div className="hero-actions">
            <Link className="ghost-link" href="/">
              Back to homepage lab
            </Link>
          </div>
        </div>
        <div className="hero-card">
          <p className="eyebrow">Entry checklist</p>
          <ul className="hero-list">
            <li>Auto-detect Asia and London highs or lows</li>
            <li>Activate only after 9:00 AM America/New_York</li>
            <li>Confirm the sweep with a 1-minute FVG reversal</li>
            <li>Keep one paper trade alive until stop or liquidity target</li>
          </ul>
        </div>
      </section>

      <section className="strategy-strip">
        <article className="strategy-card">
          <p className="eyebrow">Session model</p>
          <h2>One setup, one trade per trading day.</h2>
          <p className="strategy-copy">
            The daily cap limits repeated signals while the journal preserves each closed outcome for later review.
          </p>
        </article>
        <article className="strategy-card strategy-card-accent">
          <p className="eyebrow">Replay workspace</p>
          <h2>Validate the live rule set before risking a signal.</h2>
          <p className="strategy-copy">
            The lab below starts with a full-session fixture that can exercise the same planning and lifecycle code used by the watcher.
          </p>
        </article>
      </section>

      <LiveStrategyBoard initialData={liveStatus} />

      <TraderDashboard
        initialConfig={config}
        initialSetupText={sampleSetup}
        initialCsvText={liveFixture}
        storageKey="lucid-nq-paper-trader-live-9am-sweep-journal-v1"
      />
    </main>
  );
}
