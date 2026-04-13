import { memo, useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { getPeerGradient, getPeerDisplayName, formatCompactTokens } from '../../core/peer-utils';
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

const baseEntries: NavEntry[] = [
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
          onBlur={() => {
            setTimeout(() => {
              if (!cancelledRef.current) handleRenameSubmit();
            }, 100);
          }}
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

/* ── Peer group type ───────────────────────────────────────────────── */

type ConvRecord = Record<string, unknown>;

type PeerGroup = {
  peerId: string;
  peerLabel: string;
  displayName: string;
  gradient: string;
  conversations: ConvRecord[];
};

function groupByPeer(conversations: unknown[]): PeerGroup[] {
  const groups = new Map<string, PeerGroup>();
  const ungrouped: ConvRecord[] = [];

  for (const item of conversations) {
    const conv = item as ConvRecord;
    const peerId = String(conv.peerId || '').trim();
    const peerLabel = String(conv.peerLabel || '').trim();

    if (!peerId) {
      ungrouped.push(conv);
      continue;
    }

    let group = groups.get(peerId);
    if (!group) {
      const displayName = getPeerDisplayName(peerLabel) || peerId.slice(0, 12) + '...';
      group = {
        peerId,
        peerLabel,
        displayName,
        gradient: getPeerGradient(peerId),
        conversations: [],
      };
      groups.set(peerId, group);
    }
    group.conversations.push(conv);
  }

  const result = Array.from(groups.values());
  if (ungrouped.length > 0) {
    result.push({
      peerId: '',
      peerLabel: '',
      displayName: 'Other',
      gradient: 'linear-gradient(180deg, #9a9a96, #6b6b68)',
      conversations: ungrouped,
    });
  }
  return result;
}

/* ── Peer group component ──────────────────────────────────────────── */

function PeerGroupSection({
  group,
  expanded,
  onToggle,
  activeConvId,
  chatActiveChannels,
  onSelectConv,
  onNewChat,
  onCloseChannel,
  menuOpenId,
  setMenuOpenId,
  menuBtnRefs,
}: {
  group: PeerGroup;
  expanded: boolean;
  onToggle: () => void;
  activeConvId: string | null;
  chatActiveChannels: Map<string, { reservedUsdc: string; peerName: string }>;
  onSelectConv: (id: string) => void;
  onNewChat: (peerId: string) => void;
  onCloseChannel: () => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  menuBtnRefs: React.RefObject<Map<string, HTMLButtonElement | null>>;
}) {
  const headerRef = useRef<HTMLDivElement>(null);
  const convsRef = useRef<HTMLDivElement>(null);
  const letter = (group.displayName || '?').charAt(0).toUpperCase();

  // Scroll the header into view and animate convs open when expanded
  useEffect(() => {
    if (expanded && headerRef.current) {
      headerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [expanded]);

  return (
    <div className={`${styles.peerGroup}${expanded ? ` ${styles.peerGroupExpanded}` : ''}`}>
      <div
        ref={headerRef}
        className={styles.peerGroupHeader}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={1.5}
          className={`${styles.peerGroupChevron}${expanded ? ` ${styles.peerGroupChevronOpen}` : ''}`}
        />
        <span className={styles.peerGroupAvatar} style={{ background: group.gradient }}>
          {letter}
        </span>
        <span className={styles.peerGroupName}>{group.displayName}</span>
        {group.peerId && (
          <button
            className={styles.peerGroupAdd}
            onClick={(e) => {
              e.stopPropagation();
              onNewChat(group.peerId);
            }}
            aria-label={`New chat with ${group.displayName}`}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div
        ref={convsRef}
        className={`${styles.peerGroupConvs}${expanded ? ` ${styles.peerGroupConvsOpen}` : ''}`}
      >
        {group.conversations.map((conv) => {
            const id = String(conv.id ?? '');
            const isActive = id === activeConvId;
            const title = String(conv.title || '');
            const serviceLabel = shortServiceName(conv.service);
            const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
            const totalTokens = Number(conv.totalTokens) || 0;
            const costLabel = totalTokens > 0
              ? `$${formatUsdc(totalCost)}/${formatCompactTokens(totalTokens)}`
              : '';
            const convPeerId = String(conv.peerId || '').trim();
            const session = convPeerId ? chatActiveChannels.get(convPeerId) : undefined;
            const usedUsdc = Number(conv.totalEstimatedCostUsd) || 0;

            return (
              <div
                key={id}
                className={`${styles.chatConvItem}${isActive ? ` ${styles.active}` : ''}`}
                onClick={() => onSelectConv(id)}
              >
                <div className={styles.chatConvTop}>
                  <div className={styles.chatConvPeer}>{title}</div>
                  <div className={styles.chatConvRight}>
                    <button
                      className={styles.chatConvMenuBtn}
                      ref={(el) => { if (el) menuBtnRefs.current?.set(id, el); else menuBtnRefs.current?.delete(id); }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(menuOpenId === id ? null : id);
                      }}
                    >
                      <HugeiconsIcon icon={MoreVerticalIcon} size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
                {(serviceLabel || costLabel) && (
                  <div className={styles.chatConvPreview}>
                    {serviceLabel}
                    {serviceLabel && costLabel && <span className={styles.chatConvPreviewSep} />}
                    {costLabel && <span className={styles.chatConvCost}>{costLabel}</span>}
                  </div>
                )}
                {session && (
                  <div className={styles.chatConvSession}>
                    <span className={styles.chatConvSessionInfo}>
                      Reserved ${formatUsdc(Number(session.reservedUsdc) || 0)} · Used ${formatUsdc(usedUsdc)}
                    </span>
                    <button
                      className={styles.chatConvCloseBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseChannel();
                      }}
                    >
                      Close
                    </button>
                  </div>
                )}
                {menuOpenId === id && (
                  <ConvContextMenu
                    convId={id}
                    convTitle={title}
                    anchorRef={{ current: menuBtnRefs.current?.get(id) ?? null }}
                    onClose={() => setMenuOpenId(null)}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const EMPTY_CONVERSATIONS: unknown[] = [];

function ChatSidebar({ onSelectView }: { onSelectView: (view: ViewName) => void }) {
  const { chatConversations, chatActiveConversation, chatActiveChannels } = useUiSnapshot();
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : EMPTY_CONVERSATIONS;
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [expandedPeerId, setExpandedPeerId] = useState<string | null>(null);
  const menuBtnRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const peerGroups = useMemo(() => groupByPeer(conversations), [conversations]);

  // Auto-expand the peer that owns the active conversation — only when the
  // active conversation changes, not on every conversation list refresh.
  const prevActiveConvRef = useRef<string | null>(null);
  useEffect(() => {
    if (chatActiveConversation === prevActiveConvRef.current) return;
    prevActiveConvRef.current = chatActiveConversation;
    if (!chatActiveConversation) return;
    const activeConv = conversations.find(
      (c) => String((c as ConvRecord).id ?? '') === chatActiveConversation,
    ) as ConvRecord | undefined;
    const peerId = activeConv ? String(activeConv.peerId || '').trim() : '';
    if (peerId) {
      setExpandedPeerId(peerId);
    }
  }, [chatActiveConversation, conversations]);

  const handleTogglePeer = useCallback((peerId: string) => {
    setExpandedPeerId((prev) => (prev === peerId ? null : peerId));
  }, []);

  const handleSelectConv = useCallback((id: string) => {
    void actions.openConversation(id);
    onSelectView('chat');
  }, [actions, onSelectView]);

  const handleNewChat = useCallback((_peerId: string) => {
    actions.startNewChat();
    onSelectView('chat');
  }, [actions, onSelectView]);

  const handleCloseChannel = useCallback(() => {
    actions.requestChannelClose();
  }, [actions]);

  return (
    <aside className={styles.chatSidebar}>
      <div className={styles.chatSidebarLabel}>Peers</div>
      <div className={styles.chatConversationList}>
        {conversations.length === 0 ? (
          <div className={styles.chatEmpty}>No conversations yet</div>
        ) : (
          peerGroups.map((group) => {
            const key = group.peerId || '__other';
            return (
              <PeerGroupSection
                key={key}
                group={group}
                expanded={expandedPeerId === key}
                onToggle={() => handleTogglePeer(key)}
                activeConvId={chatActiveConversation}
                chatActiveChannels={chatActiveChannels}
                onSelectConv={handleSelectConv}
                onNewChat={handleNewChat}
                onCloseChannel={handleCloseChannel}
                menuOpenId={menuOpenId}
                setMenuOpenId={setMenuOpenId}
                menuBtnRefs={menuBtnRefs}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  const { devMode } = useUiSnapshot();
  const navEntries = devMode ? [...baseEntries, ...devEntries, ...configEntries] : [...baseEntries, ...configEntries];

  return (
    <aside className={styles.sidebar}>
      <SidebarWarning />

      <ul className={styles.sidebarNav} role="tablist" aria-label="Dashboard Views">
        {navEntries.map(({ label, view, icon }) => {
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
