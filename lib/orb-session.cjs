// Cash-open ORB policy, NOT the CME futures trading calendar.
// Reviewed dates: NYSE hours-calendars (2026); ICE's 2023/24/25 calendar
// and its Carter national-day-of-mourning notice (2025-01-09).
const VERSION = 'cash-orb-2025-2026-v1';
const holidays = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'
]);
const early = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24']);
function session(date) {
  if (!/^202[56]-\d{2}-\d{2}$/.test(date)) return { known: false, open: false, reason: 'ORB calendar needs review for this date' };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const open = day !== 0 && day !== 6 && !holidays.has(date);
  return { known: true, open, closeMinute: open ? (early.has(date) ? 780 : 960) : null,
    reason: open ? (early.has(date) ? 'Shortened cash session' : 'Regular cash session') : 'No cash opening session' };
}
module.exports = { VERSION, session };
