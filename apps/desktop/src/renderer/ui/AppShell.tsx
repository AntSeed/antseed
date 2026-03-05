import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { StreamingIndicator } from './components/StreamingIndicator';
import { ViewHost } from './components/ViewHost';
import type { ViewName } from './types';

export function AppShell() {
  const [activeView, setActiveView] = useState<ViewName>('chat');

  return (
    <>
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
