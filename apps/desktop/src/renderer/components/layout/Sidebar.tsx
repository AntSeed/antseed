import antseedMark from '../../assets/antseed-mark.svg';
import type { ViewModelProps } from '../types';

type SidebarProps = {
  vm: ViewModelProps['vm'];
};

function tabClass(active: boolean): string {
  return active ? 'sidebar-btn active' : 'sidebar-btn';
}

function runtimeBadgeClass(running: boolean, hasError = false): string {
  if (running) return 'running';
  if (hasError) return 'error';
  return 'stopped';
}

export function Sidebar({ vm }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img className="sidebar-logo-mark" src={antseedMark} alt="AntSeed mark" />
          <h1 className="sidebar-title">
            <span className="sidebar-title-ant">Ant</span><span className="sidebar-title-seed">Seed</span>
          </h1>
        </div>
        <p className="sidebar-version">Desktop Runtime Console</p>
        <p id="runtimeSummary" className="sidebar-status">{vm.runtimeSummary}</p>
        <p id="connectWarning" className="sidebar-warning" hidden={!vm.connectWarning}>{vm.connectWarning ?? ''}</p>
      </div>
      <ul className="sidebar-nav" role="tablist" aria-label="Dashboard Views">
        <li className="sidebar-nav-label">Chat Interface</li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'chat')}
            data-view="chat"
            role="tab"
            aria-selected={vm.shellState.activeView === 'chat' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('chat')}
          >
            AI Chat
          </button>
        </li>
        <li className="sidebar-nav-divider" aria-hidden="true" />
        <li className="sidebar-nav-label">Network Overview</li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'overview')}
            data-view="overview"
            role="tab"
            aria-selected={vm.shellState.activeView === 'overview' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('overview')}
          >
            Overview
          </button>
        </li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'peers')}
            data-view="peers"
            role="tab"
            aria-selected={vm.shellState.activeView === 'peers' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('peers')}
          >
            Peers
          </button>
        </li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'connection')}
            data-view="connection"
            role="tab"
            aria-selected={vm.shellState.activeView === 'connection' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('connection')}
          >
            Connection
          </button>
        </li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'config')}
            data-view="config"
            role="tab"
            aria-selected={vm.shellState.activeView === 'config' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('config')}
          >
            Settings
          </button>
        </li>
        <li data-mode="connect">
          <button
            className={tabClass(vm.shellState.activeView === 'desktop')}
            data-view="desktop"
            role="tab"
            aria-selected={vm.shellState.activeView === 'desktop' ? 'true' : 'false'}
            onClick={() => vm.setActiveView('desktop')}
          >
            Logs
          </button>
        </li>
      </ul>

      <aside className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button id="chatNewBtn" className="chat-new-btn" onClick={() => void vm.createNewConversation()}>+ New Chat</button>
        </div>
        <div id="chatConversations" className="chat-conversation-list">
          {vm.chatConversationRows.length > 0 ? vm.chatConversationRows : <div className="chat-empty">No conversations yet</div>}
        </div>
      </aside>

      <div className="sidebar-footer">
        <div className="runtime-chip-wrap">
          <span className="runtime-chip" data-mode="connect">
            Buyer <strong id="connectBadge" className={runtimeBadgeClass(vm.buyerRunning, Boolean(vm.connectProcess?.lastError))}>{vm.buyerRunning ? 'Running' : 'Stopped'}</strong>
          </span>
        </div>
      </div>
    </aside>
  );
}
