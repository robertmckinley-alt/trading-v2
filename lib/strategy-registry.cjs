const path = require('path');

// v2: the three strategies with positive forward paper results. Everything else was retired on 2026-11-10.
const STRATEGIES = Object.freeze([
  {
    slug: 'live-9am-sweep',
    name: '9AM Asia/London Sweep',
    shortName: '9AM sweep',
    paperAccountLabel: 'Paper Account A',
    strategyFamily: 'liquidity-reversal',
    strategyFamilyName: 'Liquidity reversal',
    activationTime: '09:00 America/New_York',
    researchStage: 'Forward paper test',
    evidenceLabel: 'Original platform strategy',
    description: 'Sweeps an overnight Asia or London extreme, then requires a one-minute fair-value-gap reversal.',
    source: {
      label: 'DoctorTrades rule set',
      url: null,
      license: 'User-supplied rules',
      status: 'Internal baseline'
    }
  },
  {slug:'nq-vwap-stretch-reversion',name:'VWAP Stretch Reversion',shortName:'VWAP Stretch',paperAccountLabel:'Paper Account J',
    strategyFamily:'vwap-reversion',strategyFamilyName:'VWAP mean reversion',activationTime:'09:44–15:57 America/New_York',
    researchStage:'Unvalidated paper experiment',evidenceLabel:'Video-inspired; execution assumptions documented',
    description:'Long at least 2 ATR below cash-session VWAP. One-minute signals throughout the session. Separate $50k account with a 5% starting-balance drawdown limit.',
    source:{label:'User-supplied Quant Lab video',url:null,license:'Independent implementation',status:'Not an exact replication'}} ,
  {slug:'nq-fresh-level-retest',name:'Fresh Level Retest',shortName:'Fresh retest',paperAccountLabel:'Fresh Retest $50k',
    strategyFamily:'trend-momentum',strategyFamilyName:'Trend momentum',activationTime:'09:35–15:30 America/New_York',
    researchStage:'Unvalidated paper experiment',evidenceLabel:'Frozen October 2026 video adaptation',
    description:'First M1 retest after an M5 swing break. Fresh opposing target, 1.5R after costs, $250 risk. Three initial wins unlock trading until the first non-winning trade.',
    source:{label:'User-supplied October 1 level-to-level video',url:null,license:'Independent implementation',status:'Profitability unverified'}}
]);

// Historical-only research variants. Not forward-paper accounts.
const STRATEGY_RESEARCH_VARIANTS = Object.freeze([
  {
    slug: 'live-9am-sweep-min-stop', name: '9AM Test: Minimum 10-Point Stop', shortName: '9AM min stop',
    strategyFamily: 'liquidity-reversal', strategyFamilyName: 'Liquidity reversal', activationTime: '09:00 America/New_York',
    researchStage: 'Historical candidate', evidenceLabel: 'Single-variable stop-width test',
    description: 'Keeps the 9AM sweep rules but rejects setups with less than 10 NQ points of structural risk.',
    source: { label: '2026 weakness audit', url: null, license: 'Internal research rule', status: 'Backtest-only candidate' }
  }
]);

const BACKTEST_STRATEGIES = Object.freeze([...STRATEGIES, ...STRATEGY_RESEARCH_VARIANTS]);

function validStrategySlug(slug) {
  return /^[a-z0-9][a-z0-9-]{1,119}$/.test(String(slug || ''));
}

function getStrategyDefinitions() {
  return [...STRATEGIES];
}

function getStrategyDefinition(slug) {
  return STRATEGIES.find((strategy) => strategy.slug === slug) || null;
}

function requireStrategyDefinition(slug) {
  const strategy = getStrategyDefinition(slug);
  if (!strategy) {
    throw new Error(`Unknown strategy: ${slug}. Choose one of: ${STRATEGIES.map((item) => item.slug).join(', ')}`);
  }
  return strategy;
}

function runtimeFilesForStrategy(rootDir, slug) {
  requireStrategyDefinition(slug);
  const isLegacyNineAm = slug === 'live-9am-sweep';
  return {
    statePath: path.join(rootDir, isLegacyNineAm ? 'state.json' : `state-${slug}.json`),
    pidPath: path.join(rootDir, 'runtime', isLegacyNineAm ? 'lucid-nq-paper-trader-watch.pid' : `${slug}-watch.pid`),
    logPath: path.join(rootDir, 'runtime', isLegacyNineAm ? 'lucid-nq-paper-trader-watch.log' : `${slug}-watch.log`)
  };
}

module.exports = {
  BACKTEST_STRATEGIES,
  STRATEGY_RESEARCH_VARIANTS,
  STRATEGIES,
  validStrategySlug,
  getStrategyDefinitions,
  getStrategyDefinition,
  requireStrategyDefinition,
  runtimeFilesForStrategy
};
