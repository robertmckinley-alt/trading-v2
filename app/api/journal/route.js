import { NextResponse } from 'next/server';
import {
  clearJournalEntries,
  isCloudJournalConfigured,
  listJournalEntries,
  upsertJournalEntries
} from '../../../lib/cloud-journal.mjs';
import {
  isOperatorAuthConfigured,
  isOperatorRequest,
  isTrustedMutationOrigin
} from '../../../lib/operator-auth.mjs';

export const dynamic = 'force-dynamic';

function unavailableStatus() {
  return {
    ok: true,
    configured: isCloudJournalConfigured(),
    authConfigured: isOperatorAuthConfigured(),
    authenticated: false,
    trades: []
  };
}

function authorize(request, { mutation = false } = {}) {
  if (!isCloudJournalConfigured() || !isOperatorAuthConfigured()) return null;
  if (mutation && !isTrustedMutationOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Untrusted request origin.' }, { status: 403 });
  }
  if (!isOperatorRequest(request)) {
    return NextResponse.json({ ok: false, error: 'Operator authentication required.' }, { status: 401 });
  }
  return undefined;
}

export async function GET(request) {
  if (!isCloudJournalConfigured() || !isOperatorAuthConfigured()) {
    return NextResponse.json(unavailableStatus(), { headers: { 'Cache-Control': 'no-store' } });
  }
  const authorizationError = authorize(request);
  if (authorizationError) return authorizationError;

  try {
    const trades = await listJournalEntries();
    return NextResponse.json({ ok: true, configured: true, authConfigured: true, authenticated: true, trades }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Cloud journal read failed', error: error.message }));
    return NextResponse.json({ ok: false, error: 'Cloud journal could not be read.' }, { status: 500 });
  }
}

export async function POST(request) {
  const authorizationError = authorize(request, { mutation: true });
  if (authorizationError === null) {
    return NextResponse.json({ ok: false, error: 'Cloud journal and operator access must both be configured.' }, { status: 503 });
  }
  if (authorizationError) return authorizationError;

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 2_000_000) {
    return NextResponse.json({ ok: false, error: 'Journal sync request is too large.' }, { status: 413 });
  }

  try {
    const { trades } = await request.json();
    const saved = await upsertJournalEntries(trades);
    return NextResponse.json({ ok: true, saved });
  } catch (error) {
    const inputError = /accepts up to|must include|too large/.test(error.message);
    if (!inputError) console.error(JSON.stringify({ level: 'error', message: 'Cloud journal write failed', error: error.message }));
    return NextResponse.json({ ok: false, error: inputError ? error.message : 'Cloud journal could not be updated.' }, { status: inputError ? 400 : 500 });
  }
}

export async function DELETE(request) {
  const authorizationError = authorize(request, { mutation: true });
  if (authorizationError === null) {
    return NextResponse.json({ ok: false, error: 'Cloud journal and operator access must both be configured.' }, { status: 503 });
  }
  if (authorizationError) return authorizationError;

  try {
    const deleted = await clearJournalEntries();
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'Cloud journal reset failed', error: error.message }));
    return NextResponse.json({ ok: false, error: 'Cloud journal could not be reset.' }, { status: 500 });
  }
}
