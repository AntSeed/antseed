import type { ReactNode } from 'react';

export type TabId = 'dashboard' | 'channels' | 'emissions';

interface SidebarProps {
  activeTab: TabId;
  onSelect: (tab: TabId) => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: ReactNode;
}

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1" strokeLinejoin="round"/>
      <rect x="10" y="2.5" width="5.5" height="5.5" rx="1" strokeLinejoin="round"/>
      <rect x="2.5" y="10" width="5.5" height="5.5" rx="1" strokeLinejoin="round"/>
      <rect x="10" y="10" width="5.5" height="5.5" rx="1" strokeLinejoin="round"/>
    </svg>
  );
}

function ChannelsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="9" cy="9" r="2.5"/>
      <circle cx="3" cy="5" r="1.5"/>
      <circle cx="15" cy="5" r="1.5"/>
      <circle cx="3" cy="13" r="1.5"/>
      <circle cx="15" cy="13" r="1.5"/>
      <path d="M7 7.5L4.5 6M11 7.5L13.5 6M7 10.5L4.5 12M11 10.5L13.5 12"/>
    </svg>
  );
}

function EmissionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M9 2L10.2 6.5H15L11.4 9.2L12.6 13.7L9 11L5.4 13.7L6.6 9.2L3 6.5H7.8L9 2Z" strokeLinejoin="round"/>
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14M3.8 3.8L4.8 4.8M11.2 11.2L12.2 12.2M3.8 12.2L4.8 11.2M11.2 4.8L12.2 3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.5 10A5.5 5.5 0 016 2.5 5.5 5.5 0 108 13.5a5.5 5.5 0 005.5-3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>
  );
}

function AntIcon({ size = 22 }: { size?: number }) {
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

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
  { id: 'channels',  label: 'Channels',  icon: <ChannelsIcon /> },
  { id: 'emissions', label: 'Emissions', icon: <EmissionsIcon /> },
];

export function Sidebar({ activeTab, onSelect, isDark, onToggleTheme }: SidebarProps) {
  return (
    <aside className="dash-sidebar">
      <div className="dash-sidebar-brand">
        <AntIcon size={22} />
        <span className="dash-sidebar-title">AntSeed</span>
      </div>

      <nav className="dash-sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`dash-sidebar-item${activeTab === item.id ? ' dash-sidebar-item--active' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <span className="dash-sidebar-item-icon">{item.icon}</span>
            <span className="dash-sidebar-item-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="dash-sidebar-footer">
        <div className="dash-sidebar-footer-row">
          <button
            type="button"
            className="dash-sidebar-theme-toggle"
            onClick={onToggleTheme}
            title={isDark ? 'Switch to light' : 'Switch to dark'}
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
          <div className="dash-sidebar-network">
            <span className="dash-sidebar-network-dot" />
            Base
          </div>
        </div>
      </div>
    </aside>
  );
}
