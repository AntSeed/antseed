import { useState, useEffect } from 'react';

export type Page = 'overview' | 'identity' | 'staking' | 'earnings' | 'sessions' | 'network' | 'settings';

interface SidebarProps {
  active: Page;
  onNavigate: (page: Page) => void;
  nodeState?: string;
}

function AntIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 9.625C14.9665 9.625 15.75 8.763 15.75 7.7C15.75 6.637 14.9665 5.775 14 5.775C13.0335 5.775 12.25 6.637 12.25 7.7C12.25 8.763 13.0335 9.625 14 9.625Z" fill="currentColor"/>
      <path d="M14 15.4C15.353 15.4 16.45 14.146 16.45 12.6C16.45 11.054 15.353 9.8 14 9.8C12.647 9.8 11.55 11.054 11.55 12.6C11.55 14.146 12.647 15.4 14 15.4Z" fill="currentColor"/>
      <path d="M14 23.45C15.74 23.45 17.15 21.57 17.15 19.25C17.15 16.93 15.74 15.05 14 15.05C12.26 15.05 10.85 16.93 10.85 19.25C10.85 21.57 12.26 23.45 14 23.45Z" fill="currentColor"/>
      <path opacity="0.6" d="M12.95 5.95L9.8 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round"/>
      <path opacity="0.6" d="M15.05 5.95L18.2 2.1" stroke="currentColor" strokeWidth="0.6" strokeLinecap="round"/>
      <circle cx="9.8" cy="2.1" r="0.875" fill="currentColor"/>
      <circle cx="18.2" cy="2.1" r="0.875" fill="currentColor"/>
      <path opacity="0.4" d="M12.25 11.2L6.125 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round"/>
      <path opacity="0.4" d="M15.75 11.2L21.875 7.7" stroke="currentColor" strokeWidth="0.52" strokeLinecap="round"/>
      <circle cx="6.3" cy="7.7" r="0.875" fill="currentColor"/>
      <circle cx="21.7" cy="7.7" r="0.875" fill="currentColor"/>
    </svg>
  );
}

function ThemeToggle() {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('antseed-seeder-theme');
    if (saved) return saved === 'dark';
    return true; // default dark for monitoring dashboard
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('antseed-seeder-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <button className="theme-toggle" onClick={() => setIsDark(d => !d)} title={isDark ? 'Switch to light' : 'Switch to dark'}>
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14M3.8 3.8L4.8 4.8M11.2 11.2L12.2 12.2M3.8 12.2L4.8 11.2M11.2 4.8L12.2 3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 10A5.5 5.5 0 016 2.5 5.5 5.5 0 108 13.5a5.5 5.5 0 005.5-3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
      )}
    </button>
  );
}

const navItems: { page: Page; label: string; icon: JSX.Element }[] = [
  {
    page: 'overview', label: 'Overview',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="10" y="2" width="6" height="6" rx="1"/><rect x="2" y="10" width="6" height="6" rx="1"/><rect x="10" y="10" width="6" height="6" rx="1"/></svg>,
  },
  {
    page: 'identity', label: 'Identity',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="9" cy="6" r="3"/><path d="M3 16c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>,
  },
  {
    page: 'staking', label: 'Staking',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M9 2v14M5 6l4-4 4 4M5 12l4 4 4-4"/></svg>,
  },
  {
    page: 'earnings', label: 'Earnings',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="9" cy="9" r="7"/><path d="M9 5v8M7 7h4c.6 0 1 .4 1 1s-.4 1-1 1H7M7 9h4.5c.6 0 1 .4 1 1s-.4 1-1 1H7"/></svg>,
  },
  {
    page: 'sessions', label: 'Sessions',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2 3h14M2 7h10M2 11h14M2 15h8"/></svg>,
  },
  {
    page: 'network', label: 'Network',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="9" cy="9" r="2"/><circle cx="3" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="15" cy="13" r="1.5"/><path d="M4.3 5.7L7.2 7.8M13.7 5.7L10.8 7.8M4.3 12.3L7.2 10.2M13.7 12.3L10.8 10.2"/></svg>,
  },
  {
    page: 'settings', label: 'Settings',
    icon: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="9" cy="9" r="2.5"/><path d="M9 2v2M9 14v2M2 9h2M14 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M4.2 13.8l1.4-1.4M12.4 5.6l1.4-1.4"/></svg>,
  },
];

export function Sidebar({ active, onNavigate, nodeState }: SidebarProps) {
  const isActive = nodeState === 'seeding' || nodeState === 'connected';

  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-brand">
        <AntIcon size={22} />
        <span className="sidebar-title">AntSeed</span>
        <div style={{ marginLeft: 'auto' }}>
          <ThemeToggle />
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ page, label, icon }) => (
          <button
            key={page}
            className={`sidebar-item ${active === page ? 'sidebar-item--active' : ''}`}
            onClick={() => onNavigate(page)}
          >
            <span className="sidebar-icon">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-status">
          <span className={`sidebar-status-dot ${isActive ? 'sidebar-status-dot--active' : ''}`} />
          {nodeState === 'seeding' ? 'Seeding' : nodeState === 'connected' ? 'Connected' : 'Offline'}
        </div>
      </div>
    </aside>
  );
}
