import { memo } from 'react';
import type { ViewName } from '../types';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';

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
  const { connectWarning } = useUiSnapshot();

  return (
    <div className="sidebar-header">
      <div className="sidebar-logo">
        <img className="sidebar-logo-mark" src="./assets/antseed-mark.svg" alt="AntSeed mark" />
        <h1 className="sidebar-title">
          <span className="sidebar-title-ant">AntStation</span>
        </h1>
      </div>
      {connectWarning && (
        <p className="sidebar-warning">{connectWarning}</p>
      )}
    </div>
  );
});

function formatChatTime(timestamp: unknown): string {
  const ts = Number(timestamp);
  if (!ts || ts <= 0) return 'n/a';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function shortModelName(model: unknown): string {
  const raw = String(model || '').trim();
  if (!raw) return 'unknown-model';
  return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
}

function ChatSidebar() {
  const { chatConversations, chatActiveConversation } = useUiSnapshot();
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : [];

  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button className="chat-new-btn" onClick={() => void actions.createNewConversation()}>
          + New Chat
        </button>
      </div>
      <div className="chat-conversation-list">
        {conversations.length === 0 ? (
          <div className="chat-empty">No conversations yet</div>
        ) : (
          conversations.map((item: unknown) => {
            const conv = item as Record<string, unknown>;
            const id = String(conv.id ?? '');
            const isActive = id === chatActiveConversation;
            const updatedLabel = Number(conv.updatedAt) > 0 ? formatChatTime(conv.updatedAt) : 'n/a';
            const messageCount = Number(conv.messageCount) || 0;
            const totalTokens = Number(conv.totalTokens) || 0;

            return (
              <div
                key={id}
                className={`chat-conv-item${isActive ? ' active' : ''}`}
                onClick={() => void actions.openConversation(id)}
              >
                <div className="chat-conv-top">
                  <div className="chat-conv-peer">{String(conv.title || '')}</div>
                  <span className="chat-conv-time">{updatedLabel}</span>
                </div>
                <div className="chat-conv-preview">{shortModelName(conv.model)}</div>
                <div className="chat-conv-meta">
                  <span>{`${messageCount} msg${messageCount === 1 ? '' : 's'}`}</span>
                  <span>{`${totalTokens.toLocaleString()} tok`}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function SidebarFooter() {
  const { connectBadge } = useUiSnapshot();

  return (
    <div className="sidebar-footer">
      <div className="runtime-chip-wrap">
        <span className="runtime-chip">
          Buyer <strong>{connectBadge.label}</strong>
        </span>
      </div>
    </div>
  );
}

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
            onClick={() => onSelectView(chatEntry.view)}
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
                onClick={() => onSelectView(view)}
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
