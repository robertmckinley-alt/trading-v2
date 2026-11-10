import Link from 'next/link';
import AppHeader from '../components/app-header';
import LiveStrategyBoard from '../components/live-strategy-board';
import { getStrategySnapshots } from '../lib/live-status.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  const liveStatus = await getStrategySnapshots();

  return (
    <main className="page-shell command-page" id="main-content">
      <AppHeader section="Live paper operations" />

      <div id="strategy-network">
        <LiveStrategyBoard compact initialData={liveStatus} />
      </div>

      <section className="workspace-links" aria-labelledby="workspace-links-title">
        <div className="workspace-links-head">
          <div><span className="section-kicker">Research workspaces</span><h2 id="workspace-links-title">Go deeper without crowding the live board.</h2></div>
          <p>Live execution, forward evidence, and retrospective simulations remain clearly separated.</p>
        </div>
        <div className="workspace-link-grid">
          <Link href="/backtests"><span>Historical research</span><strong>All Backtests</strong><p>Inspect every strategy, trade count, P&amp;L, and drawdown.</p><i>View results →</i></Link>
          <Link href="/comparison"><span>Benchmarking</span><strong>Strategy Comparison</strong><p>Measure each model against NQ buy-and-hold approximations.</p><i>Compare →</i></Link>
          <Link href="/research"><span>Evidence controls</span><strong>Research Lab</strong><p>Review qualification gates, holdouts, and strategy memory.</p><i>Review evidence →</i></Link>
        </div>
      </section>

      <footer className="command-footer">
        <strong>Paper trading only.</strong>
        <span>Simulated fills, modeled slippage, and historical results do not establish future profitability.</span>
      </footer>
    </main>
  );
}
