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
  parseCsvText,
  replayPlan,
  toJournalTrade,
  validateSetup
} from '../../../lib/trader-core.cjs';

function loadConfig() {
  return normalizeConfig(loadJson(path.join(process.cwd(), 'config.json')));
}

export async function POST(request) {
  const log = createRequestLog(request, '/api/replay');
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 2_500_000) {
      log.done(413);
      return NextResponse.json({ ok: false, error: 'Replay request is too large.' }, { status: 413 });
    }
    const { setup, csvText, journalState, journalTrade = false } = await request.json();
    if (typeof csvText !== 'string' || csvText.length > 2_000_000) {
      log.done(400, { errorType: 'invalid-csv' });
      return NextResponse.json({ ok: false, error: 'CSV input must be text under 2 MB.' }, { status: 400 });
    }
    const config = loadConfig();
    const normalizedSetup = normalizeSetup(setup, config);
    const validation = validateSetup(normalizedSetup, config);

    if (!validation.valid) {
      log.done(400, { validationErrors: validation.errors.length });
      return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
    }

    const state = journalState ? hydrateState(journalState, config) : createEmptyState(config);
    const plan = buildTradePlan(normalizedSetup, config, state);
    const candles = parseCsvText(csvText);
    const replayResult = replayPlan(plan, candles, config);
    const trade = journalTrade ? toJournalTrade(plan, replayResult) : null;

    log.done(200, { symbol: normalizedSetup.symbol, replayStatus: replayResult.status, journalTrade: Boolean(journalTrade) });
    return NextResponse.json({ ok: true, config, plan, replayResult, trade });
  } catch (error) {
    log.done(400, { errorType: error.name });
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
