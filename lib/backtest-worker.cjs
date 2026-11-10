const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const defaultWorkerPath = path.join(__dirname, '..', 'scripts', 'run-backtest-worker.cjs');

function saveBacktestResult(cachePath, result) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(result));
  fs.renameSync(temporaryPath, cachePath);
}

function readBacktestResult(cachePath) {
  return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
}

function runBacktestWorker(options = {}) {
  const requestedDays = Number(options.days || 60);
  const days = Number.isFinite(requestedDays)
    ? Math.min(365, Math.max(1, Math.trunc(requestedDays)))
    : 60;
  const cachePath = options.cachePath;
  if (!cachePath) return Promise.reject(new Error('A backtest cache path is required.'));

  return new Promise((resolve, reject) => {
    const worker = new (options.WorkerClass || Worker)(options.workerPath || defaultWorkerPath, {
      workerData: { days, year: options.year || null, startYear: options.startYear || null, cachePath }
    });
    let settled = false;

    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolve(readBacktestResult(cachePath));
      else reject(new Error(message?.error || 'Backtest worker failed.'));
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Backtest worker exited before completion (code ${code}).`));
    });
  });
}

module.exports = { readBacktestResult, runBacktestWorker, saveBacktestResult };
