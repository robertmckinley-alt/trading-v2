import { NextResponse } from 'next/server';
import { remoteBacktestUrls } from '../../../lib/backtest-service.cjs';

export const dynamic = 'force-dynamic';
export async function GET() {
  const urls = remoteBacktestUrls().map(url => url.replace(/\/api\/backtest$/, '/api/buy-hold'));
  try {
    if (!urls.length) throw new Error('No bridge');
    const result = await Promise.any(urls.map(async url => {
      const token = process.env.LIVE_STATUS_TOKEN || process.env.BACKTEST_SOURCE_TOKEN;
      const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Bridge unavailable');
      return response.json();
    }));
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ ok: true, result: null, message: 'Buy-and-hold comparison is awaiting the VPS update or benchmark calculation.' }, { headers: { 'Cache-Control': 'no-store' } }); }
}
