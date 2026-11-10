import AppHeader from '../../components/app-header';
import BacktestRunner from '../../components/backtest-runner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacktestsPage() {
  return (
    <main className="page-shell research-page" id="main-content">
      <AppHeader section="Historical simulations" />
      <section className="research-hero backtest-hero">
        <div>
          <p className="eyebrow">All NQ candles since January 2025</p>
          <h1>Simulate the rules before trusting the recommendation.</h1>
          <p>Each strategy receives the same historical market window and cost model. Sizing stays explicit: each model uses its documented research rules.</p>
        </div>
        <aside className="research-safety"><strong>Evidence stays separated</strong><p>Historical trades can reach the 50-trade backtest gate. Only real forward-paper trades count toward live promotion.</p></aside>
      </section>
      <BacktestRunner />
    </main>
  );
}
