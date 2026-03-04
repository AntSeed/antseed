import { Sidebar } from './components/layout/Sidebar';
import {
  OverviewView,
  PeersView,
  ChatView,
  ConnectionView,
  ConfigView,
  LogsView,
} from './components/views';
import { useDesktopViewModel } from './hooks/useDesktopViewModel';

export function AppShell() {
  const vm = useDesktopViewModel();

  return (
    <div className="app-container">
      <Sidebar vm={vm} />
      <main className="main-content">
        <section className="view-host">
          <OverviewView vm={vm} />
          <PeersView vm={vm} />
          <ChatView vm={vm} />
          <ConnectionView vm={vm} />
          <ConfigView vm={vm} />
          <LogsView vm={vm} />
        </section>
      </main>
    </div>
  );
}
