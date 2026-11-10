import { NextResponse } from 'next/server';
import { isCloudJournalConfigured } from '../../../lib/cloud-journal.mjs';
import {
  isOperatorAuthConfigured,
  isOperatorRequest,
  isTrustedMutationOrigin,
  OPERATOR_COOKIE,
  operatorCookieOptions,
  operatorSessionValue,
  verifyOperatorPasscode
} from '../../../lib/operator-auth.mjs';

export const dynamic = 'force-dynamic';

const attempts = new Map();
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function sessionStatus(request) {
  return {
    ok: true,
    configured: isOperatorAuthConfigured(),
    storageConfigured: isCloudJournalConfigured(),
    authenticated: isOperatorRequest(request)
  };
}

function clientKey(request) {
  return (request.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
}

function isRateLimited(request) {
  const key = clientKey(request);
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < ATTEMPT_WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > MAX_ATTEMPTS;
}

export async function GET(request) {
  return NextResponse.json(sessionStatus(request), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  if (!isTrustedMutationOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Untrusted request origin.' }, { status: 403 });
  }
  if (!isOperatorAuthConfigured()) {
    return NextResponse.json({ ok: false, error: 'Operator access is not configured.' }, { status: 503 });
  }
  if (isRateLimited(request)) {
    return NextResponse.json({ ok: false, error: 'Too many sign-in attempts. Try again in five minutes.' }, { status: 429 });
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 4096) {
    return NextResponse.json({ ok: false, error: 'Sign-in request is too large.' }, { status: 413 });
  }
  const { passcode = '' } = await request.json();
  if (typeof passcode !== 'string' || passcode.length > 512 || !verifyOperatorPasscode(passcode)) {
    return NextResponse.json({ ok: false, error: 'Invalid operator passcode.' }, { status: 401 });
  }

  attempts.delete(clientKey(request));
  const response = NextResponse.json({ ...sessionStatus(request), authenticated: true });
  response.cookies.set(OPERATOR_COOKIE, operatorSessionValue(), operatorCookieOptions());
  return response;
}

export async function DELETE(request) {
  if (!isTrustedMutationOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Untrusted request origin.' }, { status: 403 });
  }
  const response = NextResponse.json({ ...sessionStatus(request), authenticated: false });
  response.cookies.set(OPERATOR_COOKIE, '', { ...operatorCookieOptions(), maxAge: 0 });
  return response;
}
