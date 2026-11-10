import { notFound } from 'next/navigation';
import AppHeader from '../../../components/app-header';
import LiveStrategyBoard from '../../../components/live-strategy-board';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { STRATEGIES, getStrategyDefinition } from '../../../lib/strategy-registry.cjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function generateStaticParams() {
  return STRATEGIES
    .filter((strategy) => strategy.slug !== 'live-9am-sweep')
    .map((strategy) => ({ slug: strategy.slug }));
}

export default async function ResearchStrategyPage({ params }) {
  const [{ slug }, liveStatus] = await Promise.all([params, getStrategySnapshots()]);
  const strategy = getStrategyDefinition(slug) || liveStatus?.strategies?.find((item) => item.slug === slug);
  if (!strategy) notFound();
  const source = strategy.source || strategy.research?.source || {};
  const researchStage = strategy.researchStage || strategy.research?.stage;
  const evidenceLabel = strategy.evidenceLabel || strategy.research?.evidenceLabel;
  const description = strategy.description || strategy.research?.description;

  return (
    <main className="page-shell" id="main-content">
      <AppHeader section={`${strategy.paperAccountLabel} · strategy detail`} />

      <section className="strategy-detail-intro">
        <div>
          <span className="section-kicker">{strategy.paperAccountLabel} · paper only</span>
          <h1>{strategy.name}</h1>
          <p>{description}</p>
        </div>
        <dl className="strategy-research-facts">
          <div><dt>Stage</dt><dd>{researchStage}</dd></div>
          <div><dt>Evidence</dt><dd>{evidenceLabel}</dd></div>
          <div><dt>Activation</dt><dd>{strategy.activationTime}</dd></div>
          <div><dt>Risk family</dt><dd>{strategy.strategyFamilyName}</dd></div>
          <div><dt>License</dt><dd>{source.license}</dd></div>
        </dl>
      </section>

      <p className="research-disclaimer">
        This is an independent paper-trading experiment. Repository results have not been reproduced on this feed and do not predict future returns.
      </p>

      {source.url ? <p className="strategy-source-link"><a href={source.url} rel="noreferrer" target="_blank">Open research source →</a></p> : null}

      <LiveStrategyBoard initialData={liveStatus} />
    </main>
  );
}
