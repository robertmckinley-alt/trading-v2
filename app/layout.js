import './globals.css';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

export const metadata = {
  title: 'DoctorTrades Paper Dashboard',
  description: 'Live paper-strategy monitoring, daily performance analytics, trade history, planning, and replay.'
};

export const viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0c111d' }
  ]
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to dashboard</a>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
