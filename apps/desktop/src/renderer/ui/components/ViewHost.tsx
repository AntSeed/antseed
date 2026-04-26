import type { ViewName } from '../types';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { ChatView } from './views/ChatView';
import { ConfigView } from './views/ConfigView';
import { ConnectionView } from './views/ConnectionView';
import { DesktopView } from './views/DesktopView';
import { DiscoverView } from './views/DiscoverView';
import { ExternalClientsView } from './views/ExternalClientsView';
import { OverviewView } from './views/OverviewView';
import { PeersView } from './views/PeersView';
import { StudioView } from './views/StudioView';

type ViewHostProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

export function ViewHost({ activeView, onSelectView }: ViewHostProps) {
  const snap = useUiSnapshot();
  const isStudioMode = snap.experienceMode === 'studio';

  return (
    <section className="view-host">
      <OverviewView active={activeView === 'overview'} />
      <PeersView active={activeView === 'peers'} />
      {isStudioMode ? (
        <StudioView active={activeView === 'chat'} />
      ) : (
        <ChatView active={activeView === 'chat'} onSelectView={onSelectView} />
      )}
      <ConnectionView active={activeView === 'connection'} />
      <ConfigView active={activeView === 'config'} />
      <DesktopView active={activeView === 'desktop'} />
      <ExternalClientsView active={activeView === 'external-clients'} />
      <DiscoverView active={activeView === 'discover'} onSelectView={onSelectView} />
    </section>
  );
}
