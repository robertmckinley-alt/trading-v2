import { NextResponse } from 'next/server';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = Date.now();
  try {
    const snapshot = await getStrategySnapshots();
    const watchers = (snapshot.strategies || []).filter((strategy) => strategy.mode === 'live-watcher');
    const unhealthy = watchers.filter((strategy) => !(strategy.watcher?.isHealthy ?? strategy.watcher?.isRunning));
    const latestDataAt = watchers
      .map((strategy) => strategy.live?.lastCandle?.timestamp)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const bridgeFresh = !['remote-bridge-cache', 'remote-bridge-fallback'].includes(snapshot.source);
    const healthy = Boolean(snapshot.ok) && bridgeFresh && watchers.length > 0 && unhealthy.length === 0;
    const body = {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      generatedAt: new Date().toISOString(),
      source: snapshot.source,
      watchers: { healthy: watchers.length - unhealthy.length, total: watchers.length },
      unhealthyStrategies: unhealthy.map((strategy) => strategy.slug),
      portfolioRisk: snapshot.portfolioRisk ? {
        status: snapshot.portfolioRisk.status,
        capUsd: snapshot.portfolioRisk.capUsd,
        reservedRiskUsd: snapshot.portfolioRisk.reservedRiskUsd,
        availableRiskUsd: snapshot.portfolioRisk.availableRiskUsd,
        families: snapshot.portfolioRisk.families?.map((family) => ({
          family: family.family,
          status: family.status,
          capUsd: family.capUsd,
          reservedRiskUsd: family.reservedRiskUsd
        })) || []
      } : null,
      latestDataAt,
      durationMs: Date.now() - startedAt
    };
    console.log(JSON.stringify({ level: healthy ? 'info' : 'warn', message: 'Health check complete', ...body }));
    return NextResponse.json(body, {
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Health check failed', error: error.message, durationMs: Date.now() - startedAt }));
    return NextResponse.json({ ok: false, status: 'unavailable', generatedAt: new Date().toISOString() }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' }
    });
  }
}
