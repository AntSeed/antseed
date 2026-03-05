import type { ViewName } from '../types';
import { ChatView } from './views/ChatView';
import { ConfigView } from './views/ConfigView';
import { ConnectionView } from './views/ConnectionView';
import { DesktopView } from './views/DesktopView';
import { OverviewView } from './views/OverviewView';
import { PeersView } from './views/PeersView';

type ViewHostProps = {
  activeView: ViewName;
};

export function ViewHost({ activeView }: ViewHostProps) {
  return (
    <section className="view-host">
      <OverviewView active={activeView === 'overview'} />
      <PeersView active={activeView === 'peers'} />
      <ChatView active={activeView === 'chat'} />
      <ConnectionView active={activeView === 'connection'} />
      <ConfigView active={activeView === 'config'} />
      <DesktopView active={activeView === 'desktop'} />
    </section>
  );
}
