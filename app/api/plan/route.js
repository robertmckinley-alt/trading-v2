import path from 'path';
import { NextResponse } from 'next/server';
import { createRequestLog } from '../../../lib/request-log.mjs';
import {
  buildTradePlan,
  createEmptyState,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  validateSetup
} from '../../../lib/trader-core.cjs';

function loadConfig() {
  return normalizeConfig(loadJson(path.join(process.cwd(), 'config.json')));
}

export async function POST(request) {
  const log = createRequestLog(request, '/api/plan');
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 250_000) {
      log.done(413);
      return NextResponse.json({ ok: false, error: 'Plan request is too large.' }, { status: 413 });
    }
    const { setup, journalState } = await request.json();
    const config = loadConfig();
    const normalizedSetup = normalizeSetup(setup, config);
    const validation = validateSetup(normalizedSetup, config);

    if (!validation.valid) {
      log.done(400, { validationErrors: validation.errors.length });
      return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
    }

    const state = journalState ? hydrateState(journalState, config) : createEmptyState(config);
    const plan = buildTradePlan(normalizedSetup, config, state);
    log.done(200, { symbol: normalizedSetup.symbol, side: normalizedSetup.side });
    return NextResponse.json({ ok: true, config, plan });
  } catch (error) {
    log.done(400, { errorType: error.name });
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
