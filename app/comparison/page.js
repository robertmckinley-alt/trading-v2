import AppHeader from '../../components/app-header';
import Comparison from '../../components/buy-hold-comparison';
export const metadata = { title: 'Buy & Hold Comparison | DoctorTrades' };
export default function ComparisonPage() {
  return (
    <main className="page-shell research-page" id="main-content">
      <AppHeader section="Benchmark comparison" />
      <section className="research-hero comparison-hero">
        <div><p className="eyebrow">All strategies · same historical candles</p><h1>Are we beating buy and hold?</h1><p>Compare every historical strategy against continuous NQ buy-and-hold proxies with $50,000 starting equity. Forward-paper results remain separate.</p></div>
        <aside className="research-safety"><strong>Compare exposure, not just dollars</strong><p>One NQ contract and a $50,000 cash-exposure proxy carry different risk. Drawdown and return belong beside P&amp;L.</p></aside>
      </section>
      <Comparison />
    </main>
  );
}
