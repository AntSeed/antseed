import { useState, useEffect, useCallback } from 'react';
import { Sidebar, type Page } from './components/Sidebar';
import { Overview } from './pages/Overview';
import { Identity } from './pages/Identity';
import { Staking } from './pages/Staking';
import { Earnings } from './pages/Earnings';
import { Sessions } from './pages/Sessions';
import { Network } from './pages/Network';
import { Settings } from './pages/Settings';
import { fetchJson } from './api';

interface StatusResponse {
  state: string;
  peerCount: number;
  earningsToday: string;
  tokensToday: number;
  activeSessions: number;
  uptime: string;
  walletAddress: string | null;
  proxyPort: number | null;
  capacityUsedPercent: number;
  daemonPid: number | null;
  daemonAlive: boolean;
}

export function App() {
  const [page, setPage] = useState<Page>('overview');
  const [status, setStatus] = useState<StatusResponse | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchJson<StatusResponse>('/api/status');
      setStatus(data);
    } catch { /* offline */ }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const renderPage = () => {
    switch (page) {
      case 'overview': return <Overview status={status} />;
      case 'identity': return <Identity />;
      case 'staking': return <Staking />;
      case 'earnings': return <Earnings />;
      case 'sessions': return <Sessions />;
      case 'network': return <Network />;
      case 'settings': return <Settings />;
    }
  };

  return (
    <div className="dashboard-layout">
      <Sidebar active={page} onNavigate={setPage} nodeState={status?.state} />
      <main className="dashboard-main">
        <div className="dashboard-content">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}
