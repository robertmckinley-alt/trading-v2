const fs = require('fs');
const path = require('path');

const { getStrategyDefinitions, requireStrategyDefinition, runtimeFilesForStrategy } = require('./strategy-registry.cjs');

const LOCK_MAX_AGE_MS = 30_000;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function readAccountState(filePath) {
  let state;
  try { state = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unreadable account state'); }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      (!state.live && !Array.isArray(state.trades)) ||
      (state.trades !== undefined && !Array.isArray(state.trades)) ||
      (state.balanceUsd !== undefined && !Number.isFinite(state.balanceUsd)) ||
      (state.live != null && (typeof state.live !== 'object' || Array.isArray(state.live)))) {
    throw new Error('Invalid account state');
  }
  return state;
}

function planRiskUsd(plan, lifecycle) {
  if (!plan) return 0;
  const planned = Number(plan.sizing?.actualRiskUsd);
  const budget = Number(plan.sizing?.riskBudgetUsd ?? planned);
  const actual = Number(lifecycle?.actualRiskUsd ?? 0);
  if (![planned, budget, actual].every(Number.isFinite) || planned <= 0 || budget <= 0 || actual < 0) {
    throw new Error('Invalid open-plan risk');
  }
  // Old plans can fill up to their budget. Reserve that ceiling immediately,
  // even before a lifecycle update, without changing their saved execution.
  return Math.max(planned, actual, plan.executionModelVersion === 'bounded-fill-v1' ? 0 : budget);
}

function familyCapUsd(config, family) {
  const portfolioCap = Math.max(0, Number(config.maxPortfolioOpenRiskUsd || 0));
  const configured = Number(config.maxStrategyFamilyOpenRiskUsd?.[family]);
  return Number.isFinite(configured) ? Math.max(0, Math.min(portfolioCap, configured)) : portfolioCap;
}

function getPortfolioRiskSnapshot(rootDir, config) {
  const capUsd = Math.max(0, Number(config.maxPortfolioOpenRiskUsd || 0));
  const issues = [];
  // A corrupt challenger manifest must not silently remove its risk accounts.
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'runtime/challenger-accounts.json'), 'utf8'));
    if (!Array.isArray(manifest?.accounts)) throw new Error('Invalid manifest');
  } catch (error) { if (error.code !== 'ENOENT') issues.push({ file: 'runtime/challenger-accounts.json', reason: 'Unreadable challenger registry' }); }
  const strategies = getStrategyDefinitions(rootDir);
  const reservations = strategies.flatMap((strategy) => {
    const files = runtimeFilesForStrategy(rootDir, strategy.slug);
    let state, riskUsd;
    try {
      state = readAccountState(files.statePath);
      if (!state && (fs.existsSync(files.pidPath) || fs.existsSync(files.logPath))) throw new Error('Missing initialized account state');
      riskUsd = planRiskUsd(state?.live?.openPlan, state?.live?.openLifecycle);
    } catch (error) {
      issues.push({ strategySlug: strategy.slug, reason: error.message });
      return [];
    }
    const openPlan = state?.live?.openPlan;
    if (!openPlan || riskUsd <= 0) return [];
    return [{
      strategySlug: strategy.slug,
      strategyName: strategy.name,
      paperAccountLabel: strategy.paperAccountLabel,
      strategyFamily: strategy.strategyFamily,
      strategyFamilyName: strategy.strategyFamilyName,
      riskUsd: round(riskUsd),
      reservedAt: state.live?.openTriggeredAt || null
    }];
  });
  const reservedRiskUsd = round(reservations.reduce((sum, reservation) => sum + reservation.riskUsd, 0));
  const availableRiskUsd = issues.length ? 0 : round(Math.max(0, capUsd - reservedRiskUsd));
  const families = [...new Map(strategies.map((strategy) => [strategy.strategyFamily, strategy.strategyFamilyName])).entries()]
    .map(([family, name]) => {
      const familyReservations = reservations.filter((reservation) => reservation.strategyFamily === family);
      const familyReservedRiskUsd = round(familyReservations.reduce((sum, reservation) => sum + reservation.riskUsd, 0));
      const familyCap = familyCapUsd(config, family);
      return {
        family,
        name,
        capUsd: round(familyCap),
        reservedRiskUsd: familyReservedRiskUsd,
        availableRiskUsd: round(Math.max(0, familyCap - familyReservedRiskUsd)),
        utilizationPercent: familyCap > 0 ? round((familyReservedRiskUsd / familyCap) * 100, 1) : 100,
        status: familyReservedRiskUsd >= familyCap ? 'cap-reached' : 'clear',
        reservations: familyReservations
      };
    });
  const familyAtCap = families.some((family) => family.status === 'cap-reached');

  return {
    mode: 'paper-only-shared-cap',
    issues,
    status: issues.length ? 'state-error' : reservedRiskUsd >= capUsd ? 'cap-reached' : familyAtCap ? 'family-cap-reached' : 'clear',
    capUsd: round(capUsd),
    reservedRiskUsd,
    availableRiskUsd,
    utilizationPercent: capUsd > 0 ? round((reservedRiskUsd / capUsd) * 100, 1) : 100,
    families,
    reservations
  };
}

function acquirePortfolioLock(rootDir) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const lockPath = path.join(runtimeDir, 'portfolio-risk.lock');
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      return { handle, lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (ageMs <= LOCK_MAX_AGE_MS || attempt > 0) return null;
      fs.unlinkSync(lockPath);
    }
  }
  return null;
}

function releasePortfolioLock(lock) {
  if (!lock) return;
  try {
    fs.closeSync(lock.handle);
  } finally {
    try {
      fs.unlinkSync(lock.lockPath);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }
}

function reservePortfolioRisk({ rootDir, config, strategySlug, proposedRiskUsd, commit }) {
  const proposed = round(Math.max(0, Number(proposedRiskUsd || 0)));
  const lock = acquirePortfolioLock(rootDir);
  if (!lock) {
    return {
      ...getPortfolioRiskSnapshot(rootDir, config),
      allowed: false,
      busy: true,
      proposedRiskUsd: proposed,
      reason: 'Another strategy is reserving paper risk. This signal will be checked again on the next live tick.'
    };
  }

  try {
    const snapshot = getPortfolioRiskSnapshot(rootDir, config);
    const definition = requireStrategyDefinition(strategySlug, rootDir);
    const strategyFamily = definition.strategyFamily;
    const familySnapshot = snapshot.families.find((family) => family.family === strategyFamily);
    const projectedRiskUsd = round(snapshot.reservedRiskUsd + proposed);
    const projectedFamilyRiskUsd = round(Number(familySnapshot?.reservedRiskUsd || 0) + proposed);
    const existingReservation = snapshot.reservations.find(
      (reservation) => reservation.strategySlug === strategySlug
    );
    const withinPortfolioCap = projectedRiskUsd <= snapshot.capUsd;
    const withinFamilyCap = projectedFamilyRiskUsd <= Number(familySnapshot?.capUsd ?? snapshot.capUsd);
    const allowed = !snapshot.issues.length && Number.isFinite(proposed) && !existingReservation && proposed > 0 && withinPortfolioCap && withinFamilyCap;
    const decision = {
      ...snapshot,
      allowed,
      busy: false,
      strategySlug,
      strategyFamily,
      strategyFamilyName: definition.strategyFamilyName,
      proposedRiskUsd: proposed,
      projectedRiskUsd,
      familyCapUsd: Number(familySnapshot?.capUsd ?? snapshot.capUsd),
      familyReservedRiskUsd: Number(familySnapshot?.reservedRiskUsd || 0),
      projectedFamilyRiskUsd,
      reason: snapshot.issues.length ? 'Account state is unreadable or invalid; new entries are blocked until repaired.' : existingReservation
        ? `${existingReservation.strategyName} already holds a $${existingReservation.riskUsd.toFixed(2)} paper-risk reservation.`
        : !withinFamilyCap
          ? `Proposed $${proposed.toFixed(2)} risk would raise the ${definition.strategyFamilyName} family to $${projectedFamilyRiskUsd.toFixed(2)}, above its $${Number(familySnapshot?.capUsd ?? snapshot.capUsd).toFixed(2)} cap.`
          : allowed
          ? `Shared paper risk remains within the $${snapshot.capUsd.toFixed(2)} portfolio cap.`
          : `Proposed $${proposed.toFixed(2)} risk would raise shared open risk to $${projectedRiskUsd.toFixed(2)}, above the $${snapshot.capUsd.toFixed(2)} cap.`
    };
    if (allowed && typeof commit === 'function') commit(decision);
    return decision;
  } finally {
    releasePortfolioLock(lock);
  }
}

module.exports = {
  getPortfolioRiskSnapshot,
  planRiskUsd,
  readAccountState,
  reservePortfolioRisk
};
