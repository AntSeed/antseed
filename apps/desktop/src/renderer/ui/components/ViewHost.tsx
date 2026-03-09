import type { ViewName } from '../types';
import { ChatView } from './views/ChatView';
import { ConfigView } from './views/ConfigView';
import { ConnectionView } from './views/ConnectionView';
import { DesktopView } from './views/DesktopView';
import { ExternalClientsView } from './views/ExternalClientsView';
import { OverviewView } from './views/OverviewView';
import { PeersView } from './views/PeersView';

type ViewHostProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

export function ViewHost({ activeView, onSelectView }: ViewHostProps) {
  return (
    <section className="view-host">
      <OverviewView active={activeView === 'overview'} />
      <PeersView active={activeView === 'peers'} />
      <ChatView active={activeView === 'chat'} onSelectView={onSelectView} />
      <ConnectionView active={activeView === 'connection'} />
      <ConfigView active={activeView === 'config'} />
      <DesktopView active={activeView === 'desktop'} />
      <ExternalClientsView active={activeView === 'external-clients'} />
    </section>
  );
}
