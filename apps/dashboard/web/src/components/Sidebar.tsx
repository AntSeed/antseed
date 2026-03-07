import React from 'react';

export interface NavItem {
  id: string;
  label: string;
  icon: string;
}

interface SidebarProps {
  items: NavItem[];
  activeItem: string;
  onNavigate: (id: string) => void;
}

function SidebarIcon({ name }: { name: string }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  switch (name) {
    case 'grid':
      return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
    case 'users':
      return <svg {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case 'activity':
      return <svg {...props}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case 'dollar':
      return <svg {...props}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
    case 'settings':
      return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    default:
      return <span style={{ width: 18, display: 'inline-block' }}>{name[0]}</span>;
  }
}

export function Sidebar({ items, activeItem, onNavigate }: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <svg className="sidebar-logo-mark" width="24" height="24" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <ellipse cx="32" cy="33" rx="7" ry="10" stroke="currentColor" strokeWidth="3"/>
            <ellipse cx="32" cy="20" rx="5" ry="6" stroke="currentColor" strokeWidth="3"/>
            <ellipse cx="32" cy="47" rx="9" ry="8" stroke="currentColor" strokeWidth="3"/>
            <line x1="24" y1="24" x2="11" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <line x1="24" y1="32" x2="8" y2="32" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <line x1="24" y1="40" x2="11" y2="49" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <line x1="40" y1="24" x2="53" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <line x1="40" y1="32" x2="56" y2="32" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            <line x1="40" y1="40" x2="53" y2="49" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
          </svg>
          <h1 className="sidebar-title"><span className="ant">ANT</span><span className="seed">SEED</span></h1>
        </div>
        <div className="sidebar-tagline">P2P AI Services Network</div>
        <div className="sidebar-version">v0.1.0</div>
      </div>
      <ul className="sidebar-nav">
        {items.map((item) => (
          <li key={item.id}>
            <button
              className={`sidebar-btn ${activeItem === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <SidebarIcon name={item.icon} />
              <span className="sidebar-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <div className="sidebar-footer-text">Local Runtime Dashboard</div>
      </div>
    </nav>
  );
}
