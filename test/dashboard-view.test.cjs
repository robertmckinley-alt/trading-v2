const test = require('node:test');
const assert = require('node:assert/strict');
const { dashboardView, dashboardHistory, sessionDate } = require('../lib/dashboard-view.cjs');
const date = '2026-10-02';
const account = (slug, pnl, trades = [], extra = {}) => ({ slug, journal: { dailyRecaps: [{ date, realizedPnlUsd: pnl, trades: trades.length, tradesList: trades, ...extra }] } });
test('one account can have wins and losses; zero P&L trade is not no-trade', () => {
  const rows = [account('mixed', 5, [{ id: '1', realizedPnlUsd: 10 }, { id: '2', realizedPnlUsd: -5 }, { id: '3', realizedPnlUsd: 0 }]), account('idle', 0)];
  const day = dashboardView(rows, date);
  assert.equal(day.positive.length, 1); assert.equal(day.negative.length, 1); assert.equal(day.flat.length, 1);
  assert.deepEqual(day.idle.map(s => s.slug), ['idle']); assert.equal(day.realized, 5);
});
test('pending, partial exits and open marks remain separate from closed trades', () => {
  const day = dashboardView([account('open', 0, [], { openTradeStatus: 'open', activeRealizedPnlUsd: 20, activeUnrealizedPnlUsd: -7 }), account('pending', 0, [], { openTradeStatus: 'not-filled' })], date);
  assert.equal(day.active.length, 2); assert.equal(day.idle.length, 0); assert.equal(day.positive.length, 0);
  assert.equal(day.realized, 0); assert.equal(day.partial, 20); assert.equal(day.unrealized, -7);
});
test('missing journals and pre-activation accounts are unavailable, not idle', () => {
  assert.equal(dashboardView([{ slug: 'missing' }, { ...account('new', 0), activationTime: '2026-10-03T12:00:00Z' }], date).unavailable.length, 2);
});
test('history totals only closed journal results; dates are New York calendar days', () => {
  assert.deepEqual(dashboardHistory([account('a', 10), account('b', -4, [], { activeUnrealizedPnlUsd: 90 })]), [{ date, realized: 6, cumulative: 6 }]);
  assert.equal(sessionDate('2026-10-04T01:00:00Z'), '2026-10-03');
});
test('lifetime groups are independent of the selected daily results', () => {
  const { lifetimeView } = require('../lib/dashboard-view.cjs');
  const a = { slug: 'lifetime-winner', journal: { realizedPnlUsd: 100, trades: 5, dailyRecaps: [{ date, realizedPnlUsd: -50, trades: 1, tradesList: [{ id: 'loss', realizedPnlUsd: -50 }] }] } };
  const b = { slug: 'lifetime-loser', journal: { realizedPnlUsd: -200, trades: 3 } };
  const flat = { slug: 'flat', journal: { realizedPnlUsd: 0, trades: 2 } };
  const idle = { slug: 'idle', journal: { realizedPnlUsd: 0, trades: 0 } };
  const groups = lifetimeView([a,b,flat,idle]);
  assert.deepEqual(groups.positive.map(s=>s.slug), ['lifetime-winner']);
  assert.deepEqual(groups.negative.map(s=>s.slug), ['lifetime-loser']);
  assert.equal(groups.flat.length, 1); assert.equal(groups.idle.length, 1);
  assert.equal(dashboardView([a], date).negative.length, 1);
});
