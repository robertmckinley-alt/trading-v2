import { NextResponse } from 'next/server';
import { backtestConfigured, getBacktestStatus, requestBacktestRefresh } from '../../../lib/backtest-service.cjs';
import { isOperatorAuthConfigured, isOperatorRequest, isTrustedMutationOrigin } from '../../../lib/operator-auth.mjs';
import { createRequestLog } from '../../../lib/request-log.mjs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  const status = await getBacktestStatus();
  return NextResponse.json({
    ok: true,
    configured: backtestConfigured(),
    operatorConfigured: isOperatorAuthConfigured(),
    authenticated: isOperatorRequest(request),
    defaultStartYear: 2025,
    ...status
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  const log = createRequestLog(request, '/api/backtest');
  if (!isTrustedMutationOrigin(request)) {
    log.done(403, { errorType: 'origin' });
    return NextResponse.json({ ok: false, error: 'Untrusted request origin.' }, { status: 403 });
  }
  if (!isOperatorRequest(request)) {
    log.done(401, { errorType: 'authentication' });
    return NextResponse.json({ ok: false, error: 'Unlock operator access before running a paid historical backtest.' }, { status: 401 });
  }
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 4096) throw new Error('Backtest request is too large.');
    const body = await request.json();
    const startYear = Math.trunc(Number(body.startYear) || 2025);
    if (startYear < 2000 || startYear > new Date().getUTCFullYear()) throw new Error('Invalid backtest start year.');
    const status = await requestBacktestRefresh({ startYear });
    log.done(status.pending ? 202 : 200, { startYear, pending: status.pending });
    return NextResponse.json({ ok: true, ...status }, { status: status.pending ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    log.done(503, { errorType: error.name });
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
  }
}
