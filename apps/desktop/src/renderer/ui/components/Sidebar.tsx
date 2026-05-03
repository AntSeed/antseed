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
import { Wallet02Icon } from '@hugeicons/core-free-icons';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { WalletPanel } from './WalletPanel';
import { getPeerGradient, getPeerDisplayName } from '../../core/peer-utils';
import type { ViewName } from '../types';
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
import { AntStationLogo } from './AntStationLogo';
import { AlphaHint } from './AlphaHint';
import { StreamingIndicator } from './StreamingIndicator';
import { getModelLogo } from './chat/model-logos';
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
  { label: 'API', view: 'external-clients', icon: ComputerTerminal01Icon },
  { label: 'Settings', view: 'config', icon: Settings02Icon },
];

const devEntries: NavEntry[] = [
  { label: 'Network', view: 'overview', icon: HierarchySquare03Icon },
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
    const displayName = getPeerDisplayName(peerLabel);
    if (!group) {
      group = {
        peerId,
        peerLabel,
        displayName: displayName || peerId.slice(0, 12) + '...',
        gradient: getPeerGradient(peerId),
        conversations: [],
      };
      groups.set(peerId, group);
    } else if (displayName && group.displayName === peerId.slice(0, 12) + '...') {
      group.peerLabel = peerLabel;
      group.displayName = displayName;
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
  sendingConvIds,
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
  sendingConvIds: Set<string>;
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
            const isRunning = sendingConvIds.has(id);
            const title = String(conv.title || '');
            const serviceRaw = String(conv.service || '');
            const ModelLogo = getModelLogo(serviceRaw);
            const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
            const totalTokens = Number(conv.totalTokens) || 0;
            const costLabel = totalTokens > 0
              ? `$${formatUsdc(totalCost)}`
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
                  <span
                    className={styles.chatConvLogo}
                    title={shortServiceName(serviceRaw) || undefined}
                    aria-hidden
                  >
                    {ModelLogo ? (
                      <ModelLogo width={14} height={14} />
                    ) : (
                      <span className={styles.chatConvLogoFallback} />
                    )}
                  </span>
                  <div className={styles.chatConvPeer}>{title}</div>
                  {isRunning && (
                    <span
                      className={styles.chatConvRunningDot}
                      role="status"
                      aria-label="Request in progress"
                      title="Request in progress"
                    />
                  )}
                  {!isRunning && costLabel && (
                    <span className={styles.chatConvCost}>{costLabel}</span>
                  )}
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
  const {
    chatConversations,
    chatActiveConversation,
    chatSendingConversationIds,
    chatActiveChannels,
    chatServiceOptions,
  } = useUiSnapshot();
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : EMPTY_CONVERSATIONS;
  const sendingConvIds = useMemo(
    () => new Set(Array.isArray(chatSendingConversationIds) ? chatSendingConversationIds : []),
    [chatSendingConversationIds],
  );
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [expandedPeerIds, setExpandedPeerIds] = useState<Set<string>>(() => new Set());
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
      setExpandedPeerIds((prev) => {
        if (prev.has(peerId)) return prev;
        const next = new Set(prev);
        next.add(peerId);
        return next;
      });
    }
  }, [chatActiveConversation, conversations]);

  const handleTogglePeer = useCallback((peerId: string) => {
    setExpandedPeerIds((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) {
        next.delete(peerId);
      } else {
        next.add(peerId);
      }
      return next;
    });
  }, []);

  const handleSelectConv = useCallback((id: string) => {
    void actions.openConversation(id);
    onSelectView('chat');
  }, [actions, onSelectView]);

  const handleNewChat = useCallback((peerId: string) => {
    actions.startNewChat();
    if (peerId) {
      // Pin the new chat to this peer and pre-select a service it offers.
      // Prefer a service matching the most recent conversation with the peer
      // (conv.service matches option.id), otherwise fall back to any option
      // for that peer.
      const group = peerGroups.find((g) => g.peerId === peerId);
      const recentService = group && group.conversations.length > 0
        ? String((group.conversations[0] as ConvRecord).service || '').trim()
        : '';
      const options = Array.isArray(chatServiceOptions) ? chatServiceOptions : [];
      const match =
        (recentService
          ? options.find((o) => o.peerId === peerId && o.id === recentService)
          : undefined) ||
        options.find((o) => o.peerId === peerId);
      if (match) {
        actions.handleServiceChange(match.value, peerId);
      }
    }
    onSelectView('chat');
  }, [actions, onSelectView, peerGroups, chatServiceOptions]);

  const handleCloseChannel = useCallback(() => {
    actions.requestChannelClose();
  }, [actions]);

  return (
    <aside className={styles.chatSidebar}>
      <div className={styles.chatSidebarLabel}>Peers</div>
      <div className={styles.chatConversationList}>
        {conversations.length === 0 ? (
          <div className={styles.chatEmpty}>
            <div className={styles.chatEmptyIcon} aria-hidden>
              <HugeiconsIcon icon={PeerToPeer02Icon} size={26} strokeWidth={1.4} />
            </div>
            <div className={styles.chatEmptyTitle}>No conversations yet</div>
            <div className={styles.chatEmptyText}>Find a peer to start chatting</div>
            <button
              type="button"
              className={styles.chatEmptyCta}
              onClick={() => onSelectView('discover')}
            >
              <HugeiconsIcon icon={DiscoverCircleIcon} size={13} strokeWidth={1.5} />
              Discover peers
            </button>
          </div>
        ) : (
          peerGroups.map((group) => {
            const key = group.peerId || '__other';
            return (
              <PeerGroupSection
                key={key}
                group={group}
                expanded={expandedPeerIds.has(key)}
                onToggle={() => handleTogglePeer(key)}
                activeConvId={chatActiveConversation}
                sendingConvIds={sendingConvIds}
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

const THEME_STORAGE_KEY = 'antseed:theme';

function SidebarFooter() {
  const { creditsAvailableUsdc, creditsEvmAddress } = useUiSnapshot();
  const [open, setOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved !== null) return saved === 'dark';
    return document.body.classList.contains('dark-theme');
  });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const accountLabel = creditsEvmAddress
    ? `${creditsEvmAddress.slice(0, 6)}…${creditsEvmAddress.slice(-4)}`
    : 'Account';
  const creditsValue = Number.parseFloat(creditsAvailableUsdc);
  const creditsLabel = Number.isFinite(creditsValue) && creditsValue > 0
    ? `$${creditsValue.toFixed(2)}`
    : '$0.00';

  return (
    <div className={styles.sidebarFooter} ref={wrapRef}>
      <StreamingIndicator />

      <div className={styles.accountMenuWrap}>
        {open && (
          <div className={styles.accountPopover} role="menu">
            <div className={styles.accountPopoverWallet}>
              <WalletPanel onAction={close} />
            </div>
            <div className={styles.accountPopoverDivider} aria-hidden="true" />
            <button
              type="button"
              className={styles.accountPopoverItem}
              role="menuitem"
              onClick={() => setIsDark((d) => !d)}
            >
              <HugeiconsIcon
                icon={isDark ? Sun02Icon : Moon02Icon}
                size={16}
                strokeWidth={1.5}
              />
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        )}

        <button
          type="button"
          className={`${styles.sidebarFooterBtn}${open ? ` ${styles.sidebarFooterBtnOpen}` : ''}`}
          aria-haspopup="menu"
          aria-expanded={open ? 'true' : 'false'}
          aria-label={`${accountLabel}, ${creditsLabel} available`}
          title={`${creditsLabel} available`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className={styles.sidebarFooterBtnIconwrap} aria-hidden="true">
            <HugeiconsIcon
              icon={Wallet02Icon}
              size={18}
              strokeWidth={1.5}
              className={styles.sidebarFooterBtnIcon}
            />
          </span>
          <span className={styles.sidebarFooterBtnContent}>
            <span className={styles.sidebarFooterBtnLabel}>{accountLabel}</span>
            <span className={styles.sidebarFooterBtnCredits}>{creditsLabel} available</span>
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            strokeWidth={1.75}
            className={styles.sidebarFooterBtnChevron}
          />
        </button>
      </div>
    </div>
  );
}

type UpdateState =
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | null;

function UpdateBadge() {
  const [updateState, setUpdateState] = useState<UpdateState>(null);

  useEffect(() => {
    const bridge = (window as unknown as { antseedDesktop?: { onUpdateStatus?: (h: (d: { status: string; version: string; percent?: number }) => void) => () => void } }).antseedDesktop;
    if (!bridge?.onUpdateStatus) return;
    return bridge.onUpdateStatus((data) => {
      if (data.status === 'ready') {
        setUpdateState({ status: 'ready', version: data.version });
      } else if (data.status === 'downloading') {
        const percent = typeof data.percent === 'number' ? data.percent : 0;
        setUpdateState((prev) => {
          if (prev?.status === 'ready') return prev;
          return { status: 'downloading', version: data.version, percent };
        });
      }
    });
  }, []);

  const handleUpdate = useCallback(() => {
    const bridge = (window as unknown as { antseedDesktop?: { installUpdate?: () => Promise<void> } }).antseedDesktop;
    void bridge?.installUpdate?.();
  }, []);

  if (!updateState) return null;

  if (updateState.status === 'ready') {
    return (
      <button
        className={styles.updateBtn}
        onClick={handleUpdate}
        aria-label={`Install v${updateState.version} and restart`}
        title={`Install v${updateState.version} and restart`}
      >
        Update to v{updateState.version}
      </button>
    );
  }

  return (
    <button
      className={`${styles.updateBtn} ${styles.updateBtnDownloading}`}
      disabled
      aria-label={`Downloading v${updateState.version} ${updateState.percent}%`}
      title={`Downloading v${updateState.version} — ${updateState.percent}%`}
    >
      <span className={styles.updateBtnFill} style={{ width: `${updateState.percent}%` }} aria-hidden="true" />
      <span className={styles.updateBtnLabel}>Downloading {updateState.percent}%</span>
    </button>
  );
}

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  const { devMode } = useUiSnapshot();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTrafficZone}>
        <UpdateBadge />
      </div>
      <div className={styles.sidebarHeader}>
        <AntStationLogo height={28} className={styles.sidebarLogo} />
        <AlphaHint />
      </div>

      <SidebarWarning />

      <ul className={styles.sidebarNav} role="tablist" aria-label="Dashboard Views">
        {baseEntries.map(({ label, view, icon }) => {
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

      {devMode && (
        <>
          <div className={styles.devSectionLabel}>Dev Mode</div>
          <ul className={styles.devSection} role="tablist" aria-label="Dev Mode Views">
            {devEntries.map(({ label, view, icon }) => {
              const isActive = activeView === view;
              return (
                <li key={view}>
                  <button
                    className={`${styles.sidebarBtn} ${styles.sidebarBtnDev}${isActive ? ` ${styles.active}` : ''}`}
                    data-view={view}
                    role="tab"
                    aria-selected={isActive ? 'true' : 'false'}
                    onClick={() => onSelectView(view)}
                  >
                    <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <ChatSidebar onSelectView={onSelectView} />

      <SidebarFooter />

    </aside>
  );
}
