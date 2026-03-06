import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { StreamingIndicator } from './components/StreamingIndicator';
import { TitleBar } from './components/TitleBar';
import { ViewHost } from './components/ViewHost';
import { useUiSnapshot } from './hooks/useUiSnapshot';
import type { ViewName } from './types';

export function AppShell() {
  const { devMode } = useUiSnapshot();
  const [activeView, setActiveView] = useState<ViewName>('chat');

  useEffect(() => {
    if (!devMode && (activeView === 'connection' || activeView === 'peers' || activeView === 'desktop')) {
      setActiveView('overview');
    }
  }, [activeView, devMode]);

  return (
    <>
      <TitleBar />
      <div className="app-container">
        <Sidebar activeView={activeView} onSelectView={setActiveView} />
        <main className="main-content">
          <ViewHost activeView={activeView} />
        </main>
      </div>
      <StreamingIndicator />
    </>
  );
}
