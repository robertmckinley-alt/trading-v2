const fs = require('fs');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function num(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${label}`);
  }
  return parsed;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatUsd(value) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPoints(value) {
  return `${round(value, 2).toFixed(2)} pts`;
}

function accountFloorUsd(config) {
  return round(config.startingBalanceUsd * (1 - (config.maxAccountDrawdownPercent / 100)), 2);
}

function remainingDrawdownRoomUsd(balanceUsd, config) {
  return round(balanceUsd - accountFloorUsd(config), 2);
}

function createEmptyState(config) {
  return {
    startingBalanceUsd: config.startingBalanceUsd,
    balanceUsd: config.startingBalanceUsd,
    realizedPnlUsd: 0,
    trades: [],
    lastUpdatedAt: null
  };
}

function hydrateState(rawState, config) {
  const state = rawState ? { ...rawState } : createEmptyState(config);
  state.realizedPnlUsd ??= 0;
  state.startingBalanceUsd = config.startingBalanceUsd;
  state.balanceUsd = round(config.startingBalanceUsd + state.realizedPnlUsd, 2);
  state.trades = Array.isArray(state.trades) ? state.trades : [];
  state.lastUpdatedAt ??= null;
  return state;
}

function normalizeConfig(rawConfig) {
  const config = { ...rawConfig };
  config.symbol = String(config.symbol || 'NQ').toUpperCase();
  config.startingBalanceUsd = num(config.startingBalanceUsd ?? 50000, 'startingBalanceUsd');
  config.maxAccountDrawdownPercent = num(config.maxAccountDrawdownPercent ?? 0, 'maxAccountDrawdownPercent');
  config.maxRiskPerTradeUsd = num(config.maxRiskPerTradeUsd ?? 250, 'maxRiskPerTradeUsd');
  config.maxPortfolioOpenRiskUsd = Math.max(
    0,
    num(config.maxPortfolioOpenRiskUsd ?? 2500, 'maxPortfolioOpenRiskUsd')
  );
  config.maxStrategyFamilyOpenRiskUsd = Object.fromEntries(
    Object.entries(config.maxStrategyFamilyOpenRiskUsd || {}).map(([family, value]) => [
      String(family),
      Math.max(0, num(value, `maxStrategyFamilyOpenRiskUsd.${family}`))
    ])
  );
  config.adaptiveRiskFloorUsd = Math.min(
    config.maxRiskPerTradeUsd,
    Math.max(0, num(config.adaptiveRiskFloorUsd ?? 0, 'adaptiveRiskFloorUsd'))
  );
  config.maxDailyLossUsd = num(config.maxDailyLossUsd ?? 750, 'maxDailyLossUsd');
  config.tickSize = num(config.tickSize ?? 0.25, 'tickSize');
  config.tickValueUsd = num(config.tickValueUsd ?? 5, 'tickValueUsd');
  // Commission is the full round-trip charge per contract, charged once on exit.
  config.commissionPerContractUsd = Math.max(0, num(config.commissionPerContractUsd ?? 0, 'commissionPerContractUsd'));
  // Slippage is adverse ticks per executed leg; limit entries remain at their limit.
  config.slippageTicks = Math.max(0, num(config.slippageTicks ?? 0, 'slippageTicks'));
  config.minimumRMultiple = num(config.minimumRMultiple ?? 0, 'minimumRMultiple');
  config.sameCandleConflict = String(config.sameCandleConflict || 'stop-first');
  config.defaultScaleOuts = Array.isArray(config.defaultScaleOuts)
    ? config.defaultScaleOuts.map((scale) => ({
      targetIndex: num(scale.targetIndex, 'defaultScaleOuts.targetIndex'),
      closeFraction: num(scale.closeFraction, 'defaultScaleOuts.closeFraction')
    }))
    : [];
  return config;
}

function normalizeSetup(rawSetup, config) {
  const setup = { ...rawSetup };
  setup.symbol = String(setup.symbol || config.symbol || 'NQ').toUpperCase();
  setup.side = String(setup.side || '').toLowerCase();
  setup.execution = String(setup.execution || 'limit-touch').toLowerCase();
  setup.entry = num(setup.entry, 'entry');
  setup.stop = num(setup.stop, 'stop');
  setup.targets = Array.isArray(setup.targets) ? setup.targets.map((target, index) => num(target, `targets[${index}]`)) : [];
  setup.thesis = String(setup.thesis || '').trim();
  setup.session = String(setup.session || 'unspecified');
  setup.date = String(setup.date || new Date().toISOString().slice(0, 10));
  setup.setup = setup.setup || {};
  setup.setup.reaction = String(setup.setup.reaction || '').toLowerCase();
  setup.setup.entryModel = String(setup.setup.entryModel || '').toLowerCase();
  setup.setup.gapType = String(setup.setup.gapType || '').toLowerCase();
  setup.setup.entryTimeframe = String(setup.setup.entryTimeframe || '').toUpperCase();
  setup.setup.liquidityPool = String(setup.setup.liquidityPool || '').toLowerCase();
  setup.setup.activationTime = String(setup.setup.activationTime || '').trim();
  setup.setup.stopPlacement = String(setup.setup.stopPlacement || '').toLowerCase();
  setup.setup.referenceSessions = Array.isArray(setup.setup.referenceSessions)
    ? setup.setup.referenceSessions.map((item) => String(item).toLowerCase())
    : [];
  setup.setup.drawOnLiquidity = Array.isArray(setup.setup.drawOnLiquidity)
    ? setup.setup.drawOnLiquidity.map((item) => String(item).toLowerCase())
    : [];
  return setup;
}

function validateSetup(setup, config) {
  const errors = [];
  const entryModel = setup.setup.entryModel;
  if (!['limit-touch', 'next-bar-market'].includes(setup.execution || 'limit-touch')) {
    errors.push('execution must be limit-touch or next-bar-market');
  }
  for (const field of ['detectedAt', 'signalAvailableAt', 'orderExpiresAt', 'flattenAt']) {
    if (setup[field] && !Number.isFinite(Date.parse(setup[field]))) errors.push(`${field} must be a valid timestamp`);
  }
  const modelRules = {
    'fresh-level-retest': { sweep: false, gapTypes: ['swing-level'], timeframes: ['M1'] },
    'vwap-stretch-reversion': { sweep: false, gapTypes: ['vwap-stretch'], timeframes: ['M1'] },
    'session-sweep-fvg-reversal': { sweep: true, gapTypes: ['fvg'], timeframes: ['M1'] },
    'mss-fvg': { sweep: true, gapTypes: ['fvg'], timeframes: ['M1'] },
    'mss-ifvg': { sweep: true, gapTypes: ['ifvg'], timeframes: ['M1'] },
    'amd-fvg': { sweep: true, gapTypes: ['fvg'], timeframes: ['M1'] },
    'amd-ifvg': { sweep: true, gapTypes: ['ifvg'], timeframes: ['M1'] },
  };
  const modelRule = modelRules[entryModel];
  if (!['long', 'short'].includes(setup.side)) {
    errors.push('side must be "long" or "short"');
  }
  if (!setup.targets.length) {
    errors.push('at least one target is required');
  }
  if (!setup.thesis) {
    errors.push('thesis is required');
  }
  if (modelRule?.sweep && !setup.setup.liquiditySweep) {
    errors.push('setup.liquiditySweep must be true');
  }
  if (!['bullish', 'bearish'].includes(setup.setup.reaction)) {
    errors.push('setup.reaction must be "bullish" or "bearish"');
  }
  if (!modelRule) {
    errors.push(`setup.entryModel is not supported: ${entryModel || 'missing'}`);
  }
  if (modelRule && !modelRule.gapTypes.includes(setup.setup.gapType)) {
    errors.push(`setup.gapType must be ${modelRule.gapTypes.join(' or ')} for ${entryModel}`);
  }
  if (modelRule && !modelRule.timeframes.includes(setup.setup.entryTimeframe)) {
    errors.push(`setup.entryTimeframe must be ${modelRule.timeframes.join(' or ')} for ${entryModel}`);
  }
  if (!setup.setup.liquidityPool) {
    errors.push('setup.liquidityPool is required');
  }
  if (!setup.setup.referenceSessions.length) {
    errors.push('setup.referenceSessions must include the session ranges you marked out, like asia/london');
  }
  if (!setup.setup.activationTime) {
    errors.push('setup.activationTime is required');
  }
  if (!['swing-low', 'swing-high', 'swing-extreme', 'six-bar-structural-atr'].includes(setup.setup.stopPlacement)) {
    errors.push('setup.stopPlacement must be swing-low, swing-high, swing-extreme, or six-bar-structural-atr');
  }
  if (!setup.setup.drawOnLiquidity.length) {
    errors.push('setup.drawOnLiquidity must include at least one target narrative like vwap/current-week-low');
  }
  if (setup.side === 'long' && setup.setup.reaction !== 'bullish') {
    errors.push('long setups must use a bullish reaction');
  }
  if (setup.side === 'short' && setup.setup.reaction !== 'bearish') {
    errors.push('short setups must use a bearish reaction');
  }
  if (setup.side === 'long') {
    if (setup.stop >= setup.entry) {
      errors.push('for long trades, stop must be below entry');
    }
    if (setup.targets.some((target) => target <= setup.entry)) {
      errors.push('for long trades, every target must be above entry');
    }
  }
  if (setup.side === 'short') {
    if (setup.stop <= setup.entry) {
      errors.push('for short trades, stop must be above entry');
    }
    if (setup.targets.some((target) => target >= setup.entry)) {
      errors.push('for short trades, every target must be below entry');
    }
  }

  const stopDistancePoints = Math.abs(setup.entry - setup.stop);
  if (stopDistancePoints <= 0) {
    errors.push('stop distance must be greater than zero');
  }

  const bestTarget = setup.side === 'long' ? Math.max(...setup.targets) : Math.min(...setup.targets);
  const rewardPoints = Math.abs(bestTarget - setup.entry);
  const rr = stopDistancePoints > 0 ? rewardPoints / stopDistancePoints : 0;
  if (config.minimumRMultiple > 0 && rr < config.minimumRMultiple) {
    errors.push(`best target only offers ${round(rr, 2)}R, below the ${config.minimumRMultiple}R minimum`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function buildTradePlan(setup, config, state) {
  const stopDistancePoints = Math.abs(setup.entry - setup.stop);
  const tickDistance = stopDistancePoints / config.tickSize;
  const riskPerContractUsd = tickDistance * config.tickValueUsd;
  const slippageUsd = config.slippageTicks * config.tickValueUsd * (setup.execution === 'next-bar-market' ? 2 : 1);
  const totalRiskPerContractUsd = riskPerContractUsd + slippageUsd + config.commissionPerContractUsd;
  const drawdownRoomUsd = remainingDrawdownRoomUsd(state.balanceUsd, config);
  const riskBudgetUsd = Math.min(config.maxRiskPerTradeUsd, Math.max(0, drawdownRoomUsd));
  const maxContracts = Math.floor(riskBudgetUsd / totalRiskPerContractUsd);

  if (drawdownRoomUsd <= 0) {
    throw new Error(
      `Account drawdown guard active: balance ${formatUsd(state.balanceUsd)} is too close to the ${formatUsd(accountFloorUsd(config))} floor to take another trade.`
    );
  }

  if (maxContracts < 1) {
    throw new Error(
      `No trade: minimum 1-contract risk ${formatUsd(totalRiskPerContractUsd)} exceeds the current ${formatUsd(riskBudgetUsd)} risk budget.`
    );
  }

  const actualRiskUsd = round(maxContracts * totalRiskPerContractUsd, 2);
  const scaleOuts = config.defaultScaleOuts
    .filter((scale) => scale.targetIndex < setup.targets.length)
    .map((scale) => ({ ...scale }));

  const targets = setup.targets.map((target, index) => {
    const rewardPoints = Math.abs(target - setup.entry);
    const rr = rewardPoints / stopDistancePoints;
    const scaleOut = scaleOuts.find((item) => item.targetIndex === index);
    return {
      price: target,
      rewardPoints: round(rewardPoints, 2),
      rewardTicks: round(rewardPoints / config.tickSize, 2),
      rMultiple: round(rr, 2),
      closeFraction: scaleOut ? scaleOut.closeFraction : 0
    };
  });

  return {
    executionModelVersion: 'bounded-fill-v1',
    intrabarPolicyVersion: 'post-fill-evidence-v1',
    strategy: `doctortrades-${setup.setup.entryModel || 'paper'}-paper-trader`,
    setup,
    sizing: {
      accountBalanceUsd: round(state.balanceUsd, 2),
      accountFloorUsd: accountFloorUsd(config),
      remainingDrawdownRoomUsd: drawdownRoomUsd,
      riskBudgetUsd: round(riskBudgetUsd, 2),
      stopDistancePoints: round(stopDistancePoints, 2),
      stopDistanceTicks: round(tickDistance, 2),
      riskPerContractUsd: round(riskPerContractUsd, 2),
      slippageUsd: round(slippageUsd, 2),
      totalRiskPerContractUsd: round(totalRiskPerContractUsd, 2),
      maxContracts,
      actualRiskUsd
    },
    targets,
    narrative: {
      activationTime: setup.setup.activationTime,
      referenceSessions: setup.setup.referenceSessions,
      liquidityPool: setup.setup.liquidityPool,
      reaction: setup.setup.reaction,
      entryModel: setup.setup.entryModel,
      gapType: setup.setup.gapType,
      entryTimeframe: setup.setup.entryTimeframe,
      stopPlacement: setup.setup.stopPlacement,
      drawOnLiquidity: setup.setup.drawOnLiquidity
    }
  };
}

function parseCsvText(rawCsv) {
  const raw = String(rawCsv || '').trim();
  if (!raw) {
    throw new Error('CSV data is required');
  }
  const lines = raw.split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(',').map((cell) => cell.trim());
  return rows.filter(Boolean).map((line, rowIndex) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index];
    });
    if (!record.timestamp) {
      throw new Error(`CSV row ${rowIndex + 2} is missing timestamp`);
    }
    return {
      timestamp: record.timestamp,
      open: num(record.open, `row ${rowIndex + 2} open`),
      high: num(record.high, `row ${rowIndex + 2} high`),
      low: num(record.low, `row ${rowIndex + 2} low`),
      close: num(record.close, `row ${rowIndex + 2} close`)
    };
  });
}

function parseCsvFile(csvPath) {
  return parseCsvText(fs.readFileSync(csvPath, 'utf8'));
}

function priceTouched(candle, price) {
  return candle.low <= price && candle.high >= price;
}

function stopHit(candle, stop, side) {
  return side === 'long' ? candle.low <= stop : candle.high >= stop;
}

function targetHit(candle, target, side) {
  return side === 'long' ? candle.high >= target : candle.low <= target;
}

function pnlForMove(entry, exit, contracts, side, config) {
  const points = side === 'long' ? (exit - entry) : (entry - exit);
  const ticks = points / config.tickSize;
  const gross = ticks * config.tickValueUsd * contracts;
  const commissions = config.commissionPerContractUsd * contracts;
  return round(gross - commissions, 2);
}

function trackTradeLifecycle(plan, candles, config, options = {}) {
  options = { ...options, flattenAt: options.flattenAt || plan.setup.flattenAt };
  const closeOpenAtEnd = options.closeOpenAtEnd !== false;
  // Explicit one-contract simulation option; also used by isolated forward-paper accounts.
  const fixedResearchContract = options.researchFixedContracts === 1;
  const side = plan.setup.side;
  const direction = side === 'long' ? 1 : -1;
  const execution = plan.setup.execution || 'limit-touch';
  const marketEntry = execution === 'next-bar-market';
  const boundedFill = plan.executionModelVersion === 'bounded-fill-v1';
  const postFillEvidence = plan.intrabarPolicyVersion === 'post-fill-evidence-v1';
  const conservativeLimit = !marketEntry && config.limitFillModel !== 'legacy-touch';
  const requestedEntry = plan.setup.entry;
  let stop = plan.setup.stop;
  const trailBars = [];
  const protection = ['profit-lock-v1','partial-trail-v1'].includes(plan.setup.profitProtection) ? plan.setup.profitProtection : null;
  const stopChanges = [];
  let initialRiskPoints = null;
  let bestClose = null;
  const slipPoints = config.slippageTicks * config.tickSize;
  const availableAt = Date.parse(plan.setup.signalAvailableAt);
  const detectedAt = Date.parse(plan.setup.detectedAt);
  const expiresAt = Date.parse(plan.setup.orderExpiresAt);
  const orderedTargets = [...plan.targets].sort((a, b) => direction * (a.price - b.price));
  const hitTargetsSeen = [];
  let entry = requestedEntry;
  let contracts = fixedResearchContract ? 1 : plan.sizing.maxContracts;
  let actualRiskUsd = plan.sizing.actualRiskUsd;
  let remainingContracts = contracts;
  let filledAt = null;
  let exitedAt = null;
  let exitReason = null;
  let finalExitPrice = null;
  let realizedPnlUsd = 0;
  let slippageCostUsd = 0;
  let markPrice = candles.length ? candles[candles.length - 1].close : null;
  let maxFavorablePoints = 0;
  let maxAdversePoints = 0;
  const exitAt = (referencePrice, quantity, candle, reason) => {
    const fill = round(referencePrice - direction * slipPoints, 8);
    realizedPnlUsd += pnlForMove(entry, fill, quantity, side, config);
    slippageCostUsd += config.slippageTicks * config.tickValueUsd * quantity;
    remainingContracts -= quantity;
    finalExitPrice = fill;
    exitReason = reason;
    if (!remainingContracts) exitedAt = candle.timestamp;
  };

  for (const candle of candles) {
    if (filledAt && Number.isFinite(Date.parse(options.flattenAt)) && Date.parse(candle.timestamp) >= Date.parse(options.flattenAt)) {
      // An overdue scheduled exit uses the first observable open, never that
      // later candle's high/low/close to award a target after the deadline.
      exitAt(candle.open, remainingContracts, candle, Date.parse(candle.timestamp) === Date.parse(options.flattenAt) ? 'scheduled cash-session close' : 'delayed session exit; review required');
      break;
    }
    if (!filledAt) {
      const at = Date.parse(candle.timestamp);
      if (postFillEvidence && Number.isFinite(Date.parse(options.flattenAt)) && at >= Date.parse(options.flattenAt)) {
        exitReason = 'entry after session exit deadline'; break;
      }
      if (plan.setup.executionPolicyVersion && (![availableAt, expiresAt].every(Number.isFinite) || expiresAt <= availableAt)) {
        exitReason = 'invalid order timing'; break;
      }
      if (Number.isFinite(availableAt) && at < availableAt) continue;
      if (!Number.isFinite(availableAt) && Number.isFinite(detectedAt) && at <= detectedAt) continue;
      if (Number.isFinite(expiresAt) && at >= expiresAt) {
        exitReason = 'order expired';
        break;
      }
      const through = side === 'long' ? candle.low <= requestedEntry - config.tickSize && candle.high >= requestedEntry : candle.high >= requestedEntry + config.tickSize && candle.low <= requestedEntry;
      if (marketEntry || (conservativeLimit && through)) {
        entry = round((marketEntry ? candle.open : requestedEntry) + (marketEntry || !boundedFill ? direction * slipPoints : 0), 8);
        // Do not move the structural stop or count targets crossed before entry as profit.
        if (direction * (entry - stop) <= 0 || orderedTargets.some(target => direction * (target.price - entry) <= 0)) {
          exitReason = 'entry gap beyond stop or target';
          break;
        }
        if (Number.isFinite(plan.setup.maximumAdverseEntryRiskFraction) && direction * (entry - requestedEntry) > Math.abs(requestedEntry - plan.setup.stop) * plan.setup.maximumAdverseEntryRiskFraction) {
          exitReason = 'entry drift exceeds limit'; break;
        }
        if (Number.isFinite(plan.setup.minimumRemainingStopRiskFraction) &&
            Math.abs(entry - stop) < Math.abs(requestedEntry - plan.setup.stop) * plan.setup.minimumRemainingStopRiskFraction) {
          exitReason = 'entry leaves insufficient structural stop distance'; break;
        }
        const riskPerContract = Math.abs(entry - stop) / config.tickSize * config.tickValueUsd
          + config.slippageTicks * config.tickValueUsd + config.commissionPerContractUsd;
        if (plan.setup.minimumEntryRewardRisk) {
          const reward = direction * (orderedTargets[0].price - entry) / config.tickSize * config.tickValueUsd
            - config.slippageTicks * config.tickValueUsd - config.commissionPerContractUsd;
          if (reward / riskPerContract < plan.setup.minimumEntryRewardRisk) {
            exitReason = 'entry gap below minimum reward/risk';
            break;
          }
        }
        // New plans may never consume more than their atomically reserved risk.
        // Older persisted plans retain their original replay behavior.
        const budget = boundedFill
          ? Math.min(plan.sizing.riskBudgetUsd ?? Infinity, plan.sizing.actualRiskUsd)
          : plan.sizing.riskBudgetUsd ?? plan.sizing.actualRiskUsd;
        contracts = fixedResearchContract ? 1 : Math.min(contracts, Math.floor(budget / riskPerContract));
        if (contracts < 1) {
          exitReason = 'entry gap exceeds risk budget';
          break;
        }
        remainingContracts = contracts;
        actualRiskUsd = round(contracts * riskPerContract, 2);
        slippageCostUsd = marketEntry || !boundedFill ? config.slippageTicks * config.tickValueUsd * contracts : 0;
        filledAt = candle.timestamp;
        initialRiskPoints = Math.abs(entry - plan.setup.stop);
        bestClose = entry;
        if (protection === 'partial-trail-v1') {
          const partialPrice = (direction === 1 ? Math.ceil : Math.floor)((entry + direction * initialRiskPoints) / config.tickSize) * config.tickSize;
          if (orderedTargets.length && direction * (orderedTargets[0].price - partialPrice) > 0) orderedTargets.unshift({price: partialPrice, closeFraction: 0.5, profitPartial: true});
        }
      } else if (!conservativeLimit && priceTouched(candle, entry)) {
        filledAt = candle.timestamp;
      } else {
        continue;
      }
    }

    const favorablePoints = side === 'long' ? candle.high - entry : entry - candle.low;
    const adversePoints = side === 'long' ? entry - candle.low : candle.high - entry;
    maxFavorablePoints = Math.max(maxFavorablePoints, favorablePoints, 0);
    maxAdversePoints = Math.max(maxAdversePoints, adversePoints, 0);

    const pendingTargets = orderedTargets.filter(target => !hitTargetsSeen.includes(target.price) && !(target.profitPartial && !marketEntry && candle.timestamp === filledAt));
    const hitStop = stopHit(candle, stop, side);
    const touchedTargets = pendingTargets.filter(target => targetHit(candle, target.price, side));
    const hitTargets = touchedTargets.filter(target => {
      if (!targetHit(candle, target.price, side)) return false;
      // A resting limit may fill after the candle's favorable extreme. Without
      // ticks, only an opening marketable limit or a close through the target
      // establishes that the target was reachable after entry. Persisted plans
      // without this version keep their original replay accounting.
      if (postFillEvidence && !marketEntry && candle.timestamp === filledAt) {
        return direction * (candle.open - requestedEntry) <= 0 || direction * (candle.close - target.price) >= 0;
      }
      return true;
    });
    // A subsequent candle opening beyond the stop fills at that open, before later targets.
    // For a newly touched limit order, the earlier opening print predates its entry.
    const stopGap = (marketEntry || candle.timestamp !== filledAt) && direction * (candle.open - stop) <= 0;
    const stopReference = stopGap ? candle.open : stop;
    if (stopGap || (hitStop && touchedTargets.length && config.sameCandleConflict === 'stop-first')) {
      exitAt(stopReference, remainingContracts, candle, stopGap ? 'stop-loss gap' : 'stop-loss same-candle conflict');
      break;
    }

    for (const target of hitTargets) {
      if (remainingContracts <= 0) break;
      // Contracts are indivisible: one contract exits entirely at the first target.
      const closeContracts = Math.min(remainingContracts, Math.max(1, Math.round(contracts * target.closeFraction)));
      exitAt(target.price, closeContracts, candle, `target ${target.price}`);
      hitTargetsSeen.push(target.price);
    }
    if (remainingContracts <= 0) break;
    if (hitStop) {
      exitAt(stopReference, remainingContracts, candle, 'stop-loss');
      break;
    }
    // Completed CLOSE evidence only. A tightened stop becomes executable next bar.
    // Never infer the order of a limit fill and an earlier intrabar high/low.
    if (protection && initialRiskPoints > 0 && (marketEntry || candle.timestamp !== filledAt)) {
      bestClose = direction === 1 ? Math.max(bestClose, candle.close) : Math.min(bestClose, candle.close);
      const reachedR = direction * (bestClose - entry) / initialRiskPoints;
      const costPoints = slipPoints + config.commissionPerContractUsd / config.tickValueUsd * config.tickSize;
      let candidate = stop;
      if (reachedR >= 1) candidate = entry + direction * costPoints;
      if (reachedR >= 2) candidate = bestClose - direction * initialRiskPoints;
      candidate = (direction === 1 ? Math.ceil : Math.floor)(candidate / config.tickSize) * config.tickSize;
      if (direction * (candidate - stop) > 0) {
        stopChanges.push({decidedAt:candle.timestamp, effectiveAt:new Date(Date.parse(candle.timestamp)+60000).toISOString(), from:stop, to:candidate});
        stop = candidate;
      }
    }
  }

  const executionDetails = {
    model: execution,
    modelVersion: plan.executionModelVersion || 'legacy-unbounded-fill',
    intrabarPolicyVersion: plan.intrabarPolicyVersion || 'legacy-full-entry-candle',
    excursionConvention: 'full-candle-extremes-intrabar-sequence-unknown',
    excursionIsRealizableProfit: false,
    reservedRiskUsd: plan.sizing.actualRiskUsd,
    limitFillModel: config.limitFillModel || 'trade-through-one-tick',
    sizingMode: fixedResearchContract ? 'one-contract-research' : 'risk-budget',
    slippageTicksPerLeg: config.slippageTicks,
    commissionConvention: 'round-trip-per-contract',
    scaleOutConvention: 'whole-contract-rounding-minimum-one-first-target',
    requestedEntry,
    currentStop: stop,
    protection, stopChanges,
    policyVersion: plan.setup.executionPolicyVersion || null,
    signalOriginAvailableAt: plan.setup.signalOriginAvailableAt || null,
    observedAt: plan.setup.observedAt || null,
    signalAvailableAt: plan.setup.signalAvailableAt || null,
    orderExpiresAt: plan.setup.orderExpiresAt || null,
    minimumEntryRewardRisk: plan.setup.minimumEntryRewardRisk || null,
    maximumAdverseEntryRiskFraction: plan.setup.maximumAdverseEntryRiskFraction ?? null,
    minimumRemainingStopRiskFraction: plan.setup.minimumRemainingStopRiskFraction ?? null,
    actualRiskUsd: filledAt ? actualRiskUsd : 0
  };
  if (!filledAt) {
    return {
      status: 'not-filled', filledAt: null, exitedAt: null, filledEntryPrice: null,
      exitReason: exitReason || (Number.isFinite(options.now) && options.now >= expiresAt ? 'order expired' : 'entry never traded'), realizedPnlUsd: 0, unrealizedPnlUsd: 0,
      rMultiple: 0, targetsHit: [], contracts: 0, remainingContracts: 0,
      finalExitPrice: null, markPrice, mfePoints: 0, maePoints: 0, mfeUsd: 0, maeUsd: 0,
      actualRiskUsd: 0, slippageCostUsd: 0, execution: executionDetails
    };
  }
  if (remainingContracts > 0) {
    const lastCandle = candles[candles.length - 1];
    if (closeOpenAtEnd) {
      exitAt(lastCandle.close, remainingContracts, lastCandle, 'end-of-data close');
    } else {
      finalExitPrice = null;
      exitReason = 'still open';
    }
  }
  // Estimated liquidation value includes adverse exit slippage and the round-trip fee.
  const unrealizedPnlUsd = remainingContracts > 0 && markPrice != null
    ? pnlForMove(entry, markPrice - direction * slipPoints, remainingContracts, side, config) : 0;
  return {
    status: remainingContracts > 0 ? 'open' : 'closed', filledAt, exitedAt,
    filledEntryPrice: entry, exitReason, finalExitPrice,
    realizedPnlUsd: round(realizedPnlUsd, 2), unrealizedPnlUsd: round(unrealizedPnlUsd, 2),
    rMultiple: actualRiskUsd > 0 ? round(realizedPnlUsd / actualRiskUsd, 2) : 0,
    targetsHit: hitTargetsSeen, contracts, remainingContracts, markPrice,
    actualRiskUsd, slippageCostUsd: round(slippageCostUsd, 2), execution: executionDetails,
    mfePoints: round(maxFavorablePoints, 2), maePoints: round(maxAdversePoints, 2),
    mfeUsd: round((maxFavorablePoints / config.tickSize) * config.tickValueUsd * contracts, 2),
    maeUsd: round(-((maxAdversePoints / config.tickSize) * config.tickValueUsd * contracts), 2)
  };
}

function replayPlan(plan, candles, config, options = {}) {
  return trackTradeLifecycle(plan, candles, config, { researchFixedContracts: options.researchFixedContracts, closeOpenAtEnd: true });
}

function toJournalTrade(plan, replayResult) {
  return {
    id: `${plan.setup.symbol}-${plan.setup.date}-${Date.now()}`,
    symbol: plan.setup.symbol,
    date: plan.setup.date,
    session: plan.setup.session,
    side: plan.setup.side,
    entry: replayResult.filledEntryPrice ?? plan.setup.entry,
    requestedEntry: plan.setup.entry,
    execution: replayResult.execution || null,
    actualRiskUsd: replayResult.actualRiskUsd ?? plan.sizing.actualRiskUsd,
    slippageCostUsd: replayResult.slippageCostUsd ?? null,
    exitedAt: replayResult.exitedAt ?? null,
    stop: plan.setup.stop,
    targets: plan.setup.targets,
    thesis: plan.setup.thesis,
    liquidityLabel: plan.setup.setup.liquidityLabel || null,
    liquidityPool: plan.setup.setup.liquidityPool || null,
    reaction: plan.setup.setup.reaction || null,
    entryModel: plan.setup.setup.entryModel || null,
    gapType: plan.setup.setup.gapType || null,
    entryTimeframe: plan.setup.setup.entryTimeframe || null,
    drawOnLiquidity: plan.setup.setup.drawOnLiquidity || [],
    contracts: replayResult.contracts,
    filledAt: replayResult.filledAt,
    exitReason: replayResult.exitReason,
    finalExitPrice: replayResult.finalExitPrice || null,
    realizedPnlUsd: replayResult.realizedPnlUsd,
    rMultiple: replayResult.rMultiple,
    targetsHit: replayResult.targetsHit,
    mfePoints: replayResult.mfePoints,
    maePoints: replayResult.maePoints,
    mfeUsd: replayResult.mfeUsd,
    maeUsd: replayResult.maeUsd,
    adaptive: plan.adaptive || null,
    strategyFamily: plan.strategyFamily || null,
    signalContext: plan.signalContext || null,
    researchCouncil: plan.researchCouncil || null,
    status: replayResult.status,
    createdAt: new Date().toISOString()
  };
}

function computeReport(state, config) {
  const totalTrades = state.trades.length;
  const wins = state.trades.filter((trade) => trade.realizedPnlUsd > 0).length;
  const losses = state.trades.filter((trade) => trade.realizedPnlUsd < 0).length;
  const winRate = totalTrades ? round((wins / totalTrades) * 100, 1) : 0;
  const avgR = totalTrades
    ? round(state.trades.reduce((sum, trade) => sum + Number(trade.rMultiple || 0), 0) / totalTrades, 2)
    : 0;
  const floorUsd = accountFloorUsd(config);
  const drawdownRoomUsd = remainingDrawdownRoomUsd(state.balanceUsd, config);

  return {
    balanceUsd: state.balanceUsd,
    realizedPnlUsd: state.realizedPnlUsd,
    totalTrades,
    wins,
    losses,
    winRate,
    avgR,
    floorUsd,
    drawdownRoomUsd,
    maxDailyLossUsd: config.maxDailyLossUsd,
    maxRiskPerTradeUsd: config.maxRiskPerTradeUsd,
    locked: drawdownRoomUsd <= 0,
    recentTrades: state.trades.slice(-10)
  };
}

function printPlan(plan) {
  const lines = [];
  lines.push(`Strategy: ${plan.strategy}`);
  lines.push(`Setup: ${plan.setup.side.toUpperCase()} ${plan.setup.symbol} | ${plan.setup.session} | ${plan.setup.date}`);
  lines.push(`Entry ${plan.setup.entry} | Stop ${plan.setup.stop} | Thesis: ${plan.setup.thesis}`);
  lines.push(`Model: ${plan.narrative.activationTime} | mark ${plan.narrative.referenceSessions.join(', ')} highs/lows | ${plan.narrative.reaction} reaction off ${plan.narrative.liquidityPool} -> ${plan.narrative.entryModel.toUpperCase()} on ${plan.narrative.entryTimeframe} ${plan.narrative.gapType.toUpperCase()} | stop: ${plan.narrative.stopPlacement} | draw: ${plan.narrative.drawOnLiquidity.join(', ')}`);
  lines.push(`Account: ${formatUsd(plan.sizing.accountBalanceUsd)} | Floor: ${formatUsd(plan.sizing.accountFloorUsd)} | Drawdown room: ${formatUsd(plan.sizing.remainingDrawdownRoomUsd)}`);
  lines.push(`Risk: ${formatPoints(plan.sizing.stopDistancePoints)} | ${plan.sizing.stopDistanceTicks} ticks | ${formatUsd(plan.sizing.totalRiskPerContractUsd)} / contract`);
  lines.push(`Size: ${plan.sizing.maxContracts} contracts | planned risk ${formatUsd(plan.sizing.actualRiskUsd)} | risk budget ${formatUsd(plan.sizing.riskBudgetUsd)}`);
  lines.push('Targets:');
  for (const target of plan.targets) {
    lines.push(`- ${target.price} | ${target.rMultiple}R | ${target.rewardTicks} ticks | scale ${Math.round(target.closeFraction * 100)}%`);
  }
  return lines.join('\n');
}

function printReplay(plan, replayResult) {
  const lines = [];
  lines.push(`Replay result: ${replayResult.status}`);
  lines.push(`Filled at: ${replayResult.filledAt || 'not filled'}`);
  lines.push(`Exit reason: ${replayResult.exitReason}`);
  if (replayResult.finalExitPrice != null) {
    lines.push(`Final exit: ${replayResult.finalExitPrice}`);
  }
  lines.push(`Targets hit: ${replayResult.targetsHit.length ? replayResult.targetsHit.join(', ') : 'none'}`);
  lines.push(`Contracts: ${replayResult.contracts}`);
  lines.push(`Realized PnL: ${formatUsd(replayResult.realizedPnlUsd)}`);
  lines.push(`R multiple: ${replayResult.rMultiple}`);
  lines.push(`Planned risk: ${formatUsd(plan.sizing.actualRiskUsd)}`);
  return lines.join('\n');
}

function printReport(state, config) {
  const report = computeReport(state, config);
  const lines = [];
  lines.push(`Balance: ${formatUsd(report.balanceUsd)} | Realized: ${formatUsd(report.realizedPnlUsd)} | Trades: ${report.totalTrades}`);
  lines.push(`Account model: start ${formatUsd(config.startingBalanceUsd)} | max drawdown ${config.maxAccountDrawdownPercent}% | floor ${formatUsd(report.floorUsd)} | room left ${formatUsd(report.drawdownRoomUsd)}`);
  lines.push(`Win rate: ${report.winRate}% | Wins: ${report.wins} | Losses: ${report.losses} | Avg R: ${report.avgR}`);
  lines.push(`Daily max loss guard: ${formatUsd(report.maxDailyLossUsd)} | Per-trade risk: ${formatUsd(report.maxRiskPerTradeUsd)}`);
  if (report.locked) {
    lines.push('Status: drawdown floor breached, no new trades should be planned until the account is reset.');
  }
  if (!report.totalTrades) {
    lines.push('No journaled trades yet.');
  } else {
    lines.push('Recent trades:');
    for (const trade of report.recentTrades) {
      lines.push(`- ${trade.date} ${trade.symbol} ${trade.side} | ${trade.session} | PnL ${formatUsd(trade.realizedPnlUsd)} | ${trade.rMultiple}R | ${trade.exitReason}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  accountFloorUsd,
  buildTradePlan,
  computeReport,
  createEmptyState,
  formatPoints,
  formatUsd,
  hydrateState,
  loadJson,
  normalizeConfig,
  normalizeSetup,
  parseCsvFile,
  parseCsvText,
  printPlan,
  printReplay,
  printReport,
  replayPlan,
  remainingDrawdownRoomUsd,
  saveJson,
  trackTradeLifecycle,
  toJournalTrade,
  validateSetup
};
