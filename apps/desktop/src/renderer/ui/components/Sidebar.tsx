import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { DashboardSquare01Icon } from '@hugeicons/core-free-icons';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { PeerToPeer02Icon } from '@hugeicons/core-free-icons';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import { CommandLineIcon } from '@hugeicons/core-free-icons';
import { MoreVerticalIcon } from '@hugeicons/core-free-icons';
import { Add01Icon } from '@hugeicons/core-free-icons';
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
};

const networkEntries: NavEntry[] = [
  { label: 'Overview', view: 'overview', icon: DashboardSquare01Icon },
  { label: 'Peers', view: 'peers', icon: UserGroupIcon },
  { label: 'Connection', view: 'connection', icon: PeerToPeer02Icon },
  { label: 'Settings', view: 'config', icon: Settings02Icon },
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
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const handleRenameSubmit = useCallback(() => {
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
            if (e.key === 'Escape') onClose();
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

function ChatSidebar({ onSelectView }: { onSelectView: (view: ViewName) => void }) {
  const { chatConversations, chatActiveConversation } = useUiSnapshot();
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
  const isChatActive = activeView === 'chat';

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <button
          className={`${styles.chatNewBtn}${isChatActive ? ` ${styles.active}` : ''}`}
          onClick={() => {
            actions.startNewChat();
            onSelectView('chat');
          }}
        >
          <HugeiconsIcon icon={Add01Icon} size={16} strokeWidth={2} />
          New Chat
        </button>
      </div>

      <SidebarWarning />

      <ul className={styles.sidebarNav} role="tablist" aria-label="Dashboard Views">
        {networkEntries.map(({ label, view, icon }) => {
          const isActive = activeView === view;
          return (
            <li key={view}>
              <button
                className={`${styles.sidebarBtn}${isActive ? ` ${styles.active}` : ''}`}
                data-view={view}
                role="tab"
                aria-selected={isActive ? 'true' : 'false'}
                onClick={() => onSelectView(view)}
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
