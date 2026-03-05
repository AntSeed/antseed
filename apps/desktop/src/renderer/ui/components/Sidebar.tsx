import { memo } from 'react';
import type { ViewName } from '../types';

type SidebarProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

type NavEntry = {
  label: string;
  view: ViewName;
};

const chatEntry: NavEntry = { label: 'AI Chat', view: 'chat' };

const networkEntries: NavEntry[] = [
  { label: 'Overview', view: 'overview' },
  { label: 'Peers', view: 'peers' },
  { label: 'Connection', view: 'connection' },
  { label: 'Settings', view: 'config' },
  { label: 'Logs', view: 'desktop' },
];

const SidebarHeader = memo(function SidebarHeader() {
  return (
    <div className="sidebar-header">
      <div className="sidebar-logo">
        <img className="sidebar-logo-mark" src="./assets/antseed-mark.svg" alt="AntSeed mark" />
        <h1 className="sidebar-title">
          <span className="sidebar-title-ant">AntStation</span>
        </h1>
      </div>
      <p id="connectWarning" className="sidebar-warning" hidden></p>
    </div>
  );
});

const ChatSidebar = memo(function ChatSidebar() {
  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button id="chatNewBtn" className="chat-new-btn">
          + New Chat
        </button>
      </div>
      <div id="chatConversations" className="chat-conversation-list">
        <div className="chat-empty">No conversations yet</div>
      </div>
    </aside>
  );
});

const SidebarFooter = memo(function SidebarFooter() {
  return (
    <div className="sidebar-footer">
      <div className="runtime-chip-wrap">
        <span className="runtime-chip">
          Buyer <strong id="connectBadge">Stopped</strong>
        </span>
      </div>
    </div>
  );
});

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  return (
    <aside className="sidebar">
      <SidebarHeader />

      <ul className="sidebar-nav" role="tablist" aria-label="Dashboard Views">
        <li className="sidebar-nav-label">Chat Interface</li>
        <li>
          <button
            className={`sidebar-btn${activeView === chatEntry.view ? ' active' : ''}`}
            data-view={chatEntry.view}
            role="tab"
            aria-selected={activeView === chatEntry.view ? 'true' : 'false'}
            onClick={() => {
              onSelectView(chatEntry.view);
            }}
          >
            {chatEntry.label}
          </button>
        </li>
        <li className="sidebar-nav-divider" aria-hidden="true"></li>
        <li className="sidebar-nav-label">Network Overview</li>
        {networkEntries.map(({ label, view }) => {
          const isActive = activeView === view;
          return (
            <li key={view}>
              <button
                className={`sidebar-btn${isActive ? ' active' : ''}`}
                data-view={view}
                role="tab"
                aria-selected={isActive ? 'true' : 'false'}
                onClick={() => {
                  onSelectView(view);
                }}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ul>

      <ChatSidebar />
      <SidebarFooter />
    </aside>
  );
}
