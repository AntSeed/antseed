import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchySquare03Icon } from '@hugeicons/core-free-icons';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { PeerToPeer02Icon } from '@hugeicons/core-free-icons';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import { CommandLineIcon } from '@hugeicons/core-free-icons';
import { MoreVerticalIcon } from '@hugeicons/core-free-icons';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { DiscoverCircleIcon } from '@hugeicons/core-free-icons';
import type { ViewName } from '../types';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import styles from './Sidebar.module.scss';

type IconData = Parameters<typeof HugeiconsIcon>[0]['icon'];

type SidebarProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

type NavEntry = {
  label: string;
  view: ViewName;
  icon: IconData;
  action?: 'new-chat';
};

const baseEntries: NavEntry[] = [
  { label: 'New Chat', view: 'chat', icon: Add01Icon, action: 'new-chat' },
  { label: 'Discover', view: 'discover', icon: DiscoverCircleIcon },
  { label: 'Network', view: 'overview', icon: HierarchySquare03Icon },
  { label: 'External Clients', view: 'external-clients', icon: ComputerTerminal01Icon },
];

const configEntries: NavEntry[] = [
  { label: 'Settings', view: 'config', icon: Settings02Icon },
];

const devEntries: NavEntry[] = [
  { label: 'Connection', view: 'connection', icon: PeerToPeer02Icon },
  { label: 'Peers', view: 'peers', icon: UserGroupIcon },
  { label: 'Logs', view: 'desktop', icon: CommandLineIcon },
];

const SidebarWarning = memo(function SidebarWarning() {
  const { connectWarning } = useUiSnapshot();
  if (!connectWarning) return null;
  return <p className={styles.sidebarWarning}>{connectWarning}</p>;
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

function shortServiceName(service: unknown): string {
  const raw = String(service || '').trim();
  if (!raw) return '';
  return raw.replace(/^claude-/, '').replace(/-20\d{6,}/, '');
}

function ConvContextMenu({
  convId,
  convTitle,
  anchorRef,
  onClose,
}: {
  convId: string;
  convTitle: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(convTitle);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const actions = useActions();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose, anchorRef]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      cancelledRef.current = false;
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const handleRenameSubmit = useCallback(() => {
    if (cancelledRef.current) return;
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== convTitle) {
      actions.renameConversation(convId, trimmed);
    }
    onClose();
  }, [renameValue, convTitle, convId, actions, onClose]);

  if (renaming) {
    return (
      <div className={styles.convContextMenu} ref={menuRef}>
        <input
          ref={renameInputRef}
          className={styles.convRenameInput}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRenameSubmit();
            if (e.key === 'Escape') { cancelledRef.current = true; onClose(); }
          }}
          onBlur={handleRenameSubmit}
        />
      </div>
    );
  }

  return (
    <div className={styles.convContextMenu} ref={menuRef}>
      <button className={styles.convContextItem} onClick={() => setRenaming(true)}>
        Rename
      </button>
      <button
        className={`${styles.convContextItem} ${styles.convContextItemDanger}`}
        onClick={() => {
          void actions.deleteConversation(convId);
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

function formatUsdc(value: number): string {
  return value < 0.01 && value > 0 ? '<0.01' : value.toFixed(2);
}

function ChatSidebar({ onSelectView }: { onSelectView: (view: ViewName) => void }) {
  const { chatConversations, chatActiveConversation, chatActiveSessions, chatSessionCloseError } = useUiSnapshot();
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : [];
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuBtnRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  return (
    <aside className={styles.chatSidebar}>
      <div className={styles.chatSidebarLabel}>Recents</div>
      <div className={styles.chatConversationList}>
        {conversations.length === 0 ? (
          <div className={styles.chatEmpty}>No conversations yet</div>
        ) : (
          conversations.map((item: unknown) => {
            const conv = item as Record<string, unknown>;
            const id = String(conv.id ?? '');
            const isActive = id === chatActiveConversation;
            const updatedLabel = Number(conv.updatedAt) > 0 ? formatChatTime(conv.updatedAt) : 'n/a';
            const title = String(conv.title || '');
            const peerLabel = String(conv.peerLabel || '').trim();
            const serviceLabel = shortServiceName(conv.service);
            const metaLabel = [peerLabel, serviceLabel].filter(Boolean).join(' • ');
            const convPeerId = String(conv.peerId || '').trim();
            const session = convPeerId ? chatActiveSessions.get(convPeerId) : undefined;
            const usedUsdc = Number(conv.totalEstimatedCostUsd) || 0;

            return (
              <div
                key={id}
                className={`${styles.chatConvItem}${isActive ? ` ${styles.active}` : ''}`}
                onClick={() => {
                  void actions.openConversation(id);
                  onSelectView('chat');
                }}
              >
                <div className={styles.chatConvTop}>
                  <div className={styles.chatConvPeer}>{title}</div>
                  <div className={styles.chatConvRight}>
                    <span className={styles.chatConvTime}>{updatedLabel}</span>
                    <button
                      className={styles.chatConvMenuBtn}
                      ref={(el) => { menuBtnRefs.current.set(id, el); }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === id ? null : id);
                      }}
                    >
                      <HugeiconsIcon icon={MoreVerticalIcon} size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
                {metaLabel ? <div className={styles.chatConvPreview}>{metaLabel}</div> : null}
                {session && (
                  <>
                    <div className={styles.chatConvSession}>
                      <span className={styles.chatConvSessionInfo}>
                        Reserved ${session.reservedUsdc} · Used ${formatUsdc(usedUsdc)}
                      </span>
                      <button
                        className={styles.chatConvCloseBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.requestSessionClose(convPeerId);
                        }}
                      >
                        Close
                      </button>
                    </div>
                    {chatSessionCloseError && (
                      <div className={styles.chatConvSessionError}>{chatSessionCloseError}</div>
                    )}
                  </>
                )}
                {menuOpenId === id && (
                  <ConvContextMenu
                    convId={id}
                    convTitle={title}
                    anchorRef={{ current: menuBtnRefs.current.get(id) ?? null }}
                    onClose={() => setMenuOpenId(null)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  const actions = useActions();
  const { devMode, chatActiveConversation } = useUiSnapshot();
  const navEntries = devMode ? [...baseEntries, ...devEntries, ...configEntries] : [...baseEntries, ...configEntries];

  return (
    <aside className={styles.sidebar}>
      <SidebarWarning />

      <ul className={styles.sidebarNav} role="tablist" aria-label="Dashboard Views">
        {navEntries.map(({ label, view, icon, action }) => {
          const isActive = action === 'new-chat'
            ? activeView === view && chatActiveConversation === null
            : activeView === view;
          return (
            <li key={view}>
              <button
                className={`${styles.sidebarBtn}${isActive ? ` ${styles.active}` : ''}`}
                data-view={view}
                role="tab"
                aria-selected={isActive ? 'true' : 'false'}
                onClick={() => {
                  if (action === 'new-chat') {
                    actions.startNewChat();
                  }
                  onSelectView(view);
                }}
              >
                <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
                {label}
              </button>
            </li>
          );
        })}
      </ul>

      <ChatSidebar onSelectView={onSelectView} />

    </aside>
  );
}
