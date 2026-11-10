#!/usr/bin/env node
const { parentPort, workerData } = require('worker_threads');
const { executeBacktest } = require('../lib/backtest-service.cjs');
const { saveBacktestResult } = require('../lib/backtest-worker.cjs');

async function main() {
  const progressPath = `${workerData.cachePath}.progress.json`;
  const startedAt = new Date().toISOString();
  const onProgress = (progress) => {
    const status = { ...progress, startedAt, updatedAt: new Date().toISOString() };
    saveBacktestResult(progressPath, status);
    console.log(`[backtest progress] ${JSON.stringify(status)}`);
  };
  try {
    const result = await executeBacktest({ days: workerData.days, year: workerData.year, startYear: workerData.startYear, onProgress });
    // Persist each run's rules and evaluation so daily refreshes do not erase the research trail.
    const archivePath = require('node:path').join(require('node:path').dirname(workerData.cachePath), 'research-history',
      `${result.generatedAt.replace(/[:.]/g, '-')}-${result.learning.manifestHash.slice(0, 12)}.json`);
    saveBacktestResult(archivePath, { generatedAt: result.generatedAt, window: result.window,
      provenance: result.provenance, learning: result.learning, discovery: result.discovery });
    saveBacktestResult(workerData.cachePath, result);
    onProgress({ phase: 'completed', strategies: result.strategies.length, generatedAt: result.generatedAt });
    parentPort.postMessage({ ok: true });
  } catch (error) {
    try { onProgress({ phase: 'failed', error: error.message }); } catch { /* Preserve the original worker failure. */ }
    parentPort.postMessage({ ok: false, error: error.message });
  }
}

void main();
