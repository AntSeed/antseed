import React, { useState } from 'react';
import { Overview } from './pages/Overview';
import { Peers } from './pages/Peers';
import { Channels } from './pages/Channels';
import { Earnings } from './pages/Earnings';
import { Settings } from './pages/Settings';
import { Sidebar, NavItem } from './components/Sidebar';

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'peers', label: 'Peers', icon: 'users' },
  { id: 'channels', label: 'Channels', icon: 'activity' },
  { id: 'earnings', label: 'Earnings', icon: 'dollar' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App() {
  const [activePage, setActivePage] = useState<string>('overview');

  const renderPage = () => {
    switch (activePage) {
      case 'overview': return <Overview />;
      case 'peers': return <Peers />;
      case 'channels': return <Channels />;
      case 'earnings': return <Earnings />;
      case 'settings': return <Settings />;
      default: return <Overview />;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        items={NAV_ITEMS}
        activeItem={activePage}
        onNavigate={setActivePage}
      />
      <main className="main-content">
        {renderPage()}
      </main>
    </div>
  );
}
