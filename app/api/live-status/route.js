import { NextResponse } from 'next/server';
import { getStrategySnapshots } from '../../../lib/live-status.cjs';
import { createRequestLog } from '../../../lib/request-log.mjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  const log = createRequestLog(request, '/api/live-status');
  try {
    const payload = await getStrategySnapshots();
    log.done(200, { source: payload.source, strategies: payload.strategies?.length || 0 });
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      }
    });
  } catch (error) {
    log.failed(error);
    return NextResponse.json(
      {
        ok: false,
        error: error.message
      },
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0'
        }
      }
    );
  }
}
