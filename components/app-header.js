import Link from 'next/link';

const navigation = [
  { href: '/', label: 'Dashboard' },
  { href: '/strategies/live-9am-sweep', label: 'Strategies' },
  { href: '/backtests', label: 'Backtests' },
  { href: '/comparison', label: 'Compare' },
  { href: '/research', label: 'Research' }
];

export default function AppHeader({ section = 'NQ paper research' }) {
  return (
    <header className="app-header app-header-shell">
      <Link className="brand-lockup brand-link" href="/" aria-label="DoctorTrades dashboard">
        <span className="brand-mark" aria-hidden="true">DT</span>
        <span className="brand-copy">
          <strong>DoctorTrades</strong>
          <small>{section}</small>
        </span>
      </Link>
      <nav className="app-nav app-nav-primary" aria-label="Primary navigation">
        {navigation.map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
      </nav>
      <span className="paper-mode-badge"><i aria-hidden="true" />Paper only</span>
    </header>
  );
}
