import {
  memo,
  useState,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type RefObject,
} from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { HierarchySquare03Icon } from '@hugeicons/core-free-icons';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { PeerToPeer02Icon } from '@hugeicons/core-free-icons';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import { CommandLineIcon } from '@hugeicons/core-free-icons';
import { MoreVerticalIcon } from '@hugeicons/core-free-icons';
import { Search01Icon } from '@hugeicons/core-free-icons';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { DiscoverCircleIcon } from '@hugeicons/core-free-icons';
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

type ConvRecord = Record<string, unknown>;

const baseEntries: NavEntry[] = [
  { label: 'Discover', view: 'discover', icon: DiscoverCircleIcon },
  { label: 'API', view: 'external-clients', icon: ComputerTerminal01Icon },
];

const configEntries: NavEntry[] = [
  { label: 'Settings', view: 'config', icon: Settings02Icon },
];

const devEntries: NavEntry[] = [
  { label: 'Network', view: 'overview', icon: HierarchySquare03Icon },
  { label: 'Connection', view: 'connection', icon: PeerToPeer02Icon },
  { label: 'Peers', view: 'peers', icon: UserGroupIcon },
  { label: 'Logs', view: 'desktop', icon: CommandLineIcon },
];

const EMPTY_CONVERSATIONS: unknown[] = [];
const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_SESSION_CLOCK_MS = 60 * 1000;

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

function formatUsdc(value: number): string {
  return value < 0.01 && value > 0 ? '<0.01' : value.toFixed(2);
}

function getConversationId(conv: ConvRecord): string {
  return String(conv.id ?? '');
}

function getConversationCreatedAt(conv: ConvRecord): number {
  const createdAt = Number(conv.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0;
}

function getConversationUpdatedAt(conv: ConvRecord): number {
  const updatedAt = Number(conv.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  return getConversationCreatedAt(conv);
}

function compareConversationsByActivity(left: ConvRecord, right: ConvRecord): number {
  const updatedDelta = getConversationUpdatedAt(right) - getConversationUpdatedAt(left);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = getConversationCreatedAt(right) - getConversationCreatedAt(left);
  if (createdDelta !== 0) return createdDelta;

  return getConversationId(left).localeCompare(getConversationId(right));
}

function isRecentConversation(conv: ConvRecord, now: number): boolean {
  const updatedAt = getConversationUpdatedAt(conv);
  return updatedAt > 0 && now - updatedAt <= RECENT_SESSION_WINDOW_MS;
}

function getConversationPeerName(
  conv: ConvRecord,
  peerDisplayNameById: ReadonlyMap<string, string>,
): string {
  const peerId = String(conv.peerId || '').trim();
  if (!peerId) return 'Other';
  return peerDisplayNameById.get(peerId)
    || getPeerDisplayName(String(conv.peerLabel || ''))
    || `${peerId.slice(0, 12)}...`;
}

function conversationMatchesSearch(
  conv: ConvRecord,
  peerName: string,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [
    conv.title,
    conv.service,
    conv.provider,
    conv.peerLabel,
    conv.peerId,
    conv.workspacePath,
    peerName,
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  return terms.every((term) => haystack.includes(term));
}

function ConvContextMenu({
  convId,
  convTitle,
  anchorRef,
  onClose,
}: {
  convId: string;
  convTitle: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
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

function ConversationListRow({
  conv,
  activeConvId,
  sendingConvIds,
  chatActiveChannels,
  peerDisplayNameById,
  onSelectConv,
  onCloseChannel,
  menuOpenId,
  setMenuOpenId,
  menuBtnRefs,
}: {
  conv: ConvRecord;
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  chatActiveChannels: Map<string, { reservedUsdc: string; peerName: string }>;
  peerDisplayNameById: ReadonlyMap<string, string>;
  onSelectConv: (id: string) => void;
  onCloseChannel: () => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  menuBtnRefs: RefObject<Map<string, HTMLButtonElement | null>>;
}) {
  const id = getConversationId(conv);
  const title = String(conv.title || 'Untitled chat');
  const isActive = id === activeConvId;
  const isRunning = sendingConvIds.has(id);
  const serviceLabel = shortServiceName(conv.service);
  const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
  const totalTokens = Number(conv.totalTokens) || 0;
  const costLabel = totalTokens > 0
    ? `$${formatUsdc(totalCost)}/${formatCompactTokens(totalTokens)}`
    : '';
  const convPeerId = String(conv.peerId || '').trim();
  const peerName = getConversationPeerName(conv, peerDisplayNameById);
  const session = convPeerId ? chatActiveChannels.get(convPeerId) : undefined;
  const usedUsdc = Number(conv.totalEstimatedCostUsd) || 0;
  const timeLabel = formatChatTime(getConversationUpdatedAt(conv));
  const avatarLetter = (peerName || '?').charAt(0).toUpperCase();
  const avatarGradient = convPeerId
    ? getPeerGradient(convPeerId)
    : 'linear-gradient(180deg, #9a9a96, #6b6b68)';

  return (
    <div
      className={`${styles.chatConvItem} ${styles.recentSessionItem}${isActive ? ` ${styles.active}` : ''}`}
      onClick={() => onSelectConv(id)}
    >
      <div className={styles.chatConvTop}>
        <div className={styles.chatConvPeer}>{title}</div>
        {isRunning && (
          <span
            className={styles.chatConvRunningDot}
            role="status"
            aria-label="Request in progress"
            title="Request in progress"
          />
        )}
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
      <div className={styles.recentSessionMeta}>
        <span className={styles.recentSessionAvatar} style={{ background: avatarGradient }}>
          {avatarLetter}
        </span>
        <span className={styles.recentSessionPeer}>{peerName}</span>
        {costLabel && <span className={`${styles.chatConvCost} ${styles.recentSessionCost}`}>{costLabel}</span>}
        <span className={styles.recentSessionTime}>{timeLabel}</span>
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
}

function ChatListSection({
  conversations,
  totalConversationCount,
  activeConvId,
  sendingConvIds,
  chatActiveChannels,
  peerDisplayNameById,
  onSelectConv,
  onCloseChannel,
  onOpenChatSearch,
  menuOpenId,
  setMenuOpenId,
  menuBtnRefs,
}: {
  conversations: ConvRecord[];
  totalConversationCount: number;
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  chatActiveChannels: Map<string, { reservedUsdc: string; peerName: string }>;
  peerDisplayNameById: ReadonlyMap<string, string>;
  onSelectConv: (id: string) => void;
  onCloseChannel: () => void;
  onOpenChatSearch: () => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  menuBtnRefs: RefObject<Map<string, HTMLButtonElement | null>>;
}) {
  return (
    <section className={styles.recentSessions} aria-labelledby="chat-list-label">
      <div className={styles.recentSessionsLabel} id="chat-list-label">
        <span className={styles.recentSessionsLabelText}>
          <span>Conversations</span>
          {totalConversationCount > 0 && (
            <span className={styles.recentSessionsCount} aria-label={`${totalConversationCount} total conversations`}>
              {totalConversationCount}
            </span>
          )}
        </span>
        <button
          type="button"
          className={styles.recentSessionsSearchBtn}
          onClick={onOpenChatSearch}
          aria-label="Search conversations"
          title="Search conversations"
        >
          <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className={styles.recentSessionsList}>
        {conversations.length === 0 ? (
          <div className={styles.chatEmpty}>No conversations yet</div>
        ) : (
          conversations.map((conv) => (
            <ConversationListRow
              key={getConversationId(conv)}
              conv={conv}
              activeConvId={activeConvId}
              sendingConvIds={sendingConvIds}
              chatActiveChannels={chatActiveChannels}
              peerDisplayNameById={peerDisplayNameById}
              onSelectConv={onSelectConv}
              onCloseChannel={onCloseChannel}
              menuOpenId={menuOpenId}
              setMenuOpenId={setMenuOpenId}
              menuBtnRefs={menuBtnRefs}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ChatSearchModal({
  conversations,
  activeConvId,
  sendingConvIds,
  peerDisplayNameById,
  onSelectConv,
  onClose,
}: {
  conversations: ConvRecord[];
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  peerDisplayNameById: ReadonlyMap<string, string>;
  onSelectConv: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const results = useMemo(() => {
    return conversations
      .filter((conv) => conversationMatchesSearch(
        conv,
        getConversationPeerName(conv, peerDisplayNameById),
        query,
      ))
      .sort(compareConversationsByActivity);
  }, [conversations, peerDisplayNameById, query]);

  return (
    <div
      className={styles.chatSearchOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={styles.chatSearchModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
      >
        <header className={styles.chatSearchHeader}>
          <div>
            <h2 id="chat-search-title">Conversations</h2>
            <p>Search across every peer, session title, service, and workspace.</p>
          </div>
          <button className={styles.chatSearchClose} onClick={onClose} aria-label="Close chat search">
            ×
          </button>
        </header>

        <input
          ref={inputRef}
          className={styles.chatSearchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations, peers, services..."
        />

        <div className={styles.chatSearchSummary}>
          {results.length} of {conversations.length} conversation{conversations.length === 1 ? '' : 's'}
        </div>

        <div className={styles.chatSearchResults}>
          {results.length === 0 ? (
            <div className={styles.chatSearchEmpty}>No chats match that search.</div>
          ) : (
            results.map((conv) => {
              const id = getConversationId(conv);
              const title = String(conv.title || 'Untitled chat');
              const peerName = getConversationPeerName(conv, peerDisplayNameById);
              const serviceLabel = shortServiceName(conv.service);
              const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
              const totalTokens = Number(conv.totalTokens) || 0;
              const costLabel = totalTokens > 0
                ? `$${formatUsdc(totalCost)}/${formatCompactTokens(totalTokens)}`
                : '';
              const timeLabel = formatChatTime(getConversationUpdatedAt(conv));
              const isActive = id === activeConvId;
              const isRunning = sendingConvIds.has(id);

              return (
                <button
                  key={id}
                  className={`${styles.chatSearchResult}${isActive ? ` ${styles.chatSearchResultActive}` : ''}`}
                  onClick={() => {
                    onSelectConv(id);
                    onClose();
                  }}
                >
                  <span className={styles.chatSearchResultMain}>
                    <span className={styles.chatSearchResultTitle}>{title}</span>
                    {isRunning && (
                      <span
                        className={styles.chatConvRunningDot}
                        role="status"
                        aria-label="Request in progress"
                        title="Request in progress"
                      />
                    )}
                  </span>
                  <span className={styles.chatSearchResultMeta}>
                    <span>{peerName}</span>
                    {serviceLabel && <span>{serviceLabel}</span>}
                    {costLabel && <span>{costLabel}</span>}
                    <span>{timeLabel}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function ChatSidebar({ onSelectView }: { onSelectView: (view: ViewName) => void }) {
  const {
    chatConversations,
    chatActiveConversation,
    chatSendingConversationIds,
    chatActiveChannels,
    discoverRows,
  } = useUiSnapshot();
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : EMPTY_CONVERSATIONS;
  const allConversations = conversations as ConvRecord[];
  const sendingConvIds = useMemo(
    () => new Set(Array.isArray(chatSendingConversationIds) ? chatSendingConversationIds : []),
    [chatSendingConversationIds],
  );
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [recentNow, setRecentNow] = useState(() => Date.now());
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const menuBtnRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  useEffect(() => {
    const timer = window.setInterval(() => setRecentNow(Date.now()), RECENT_SESSION_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const peerDisplayNameById = useMemo(() => {
    const map = new Map<string, string>();
    const rows = Array.isArray(discoverRows) ? discoverRows : [];

    for (const row of rows) {
      const peerId = String(row.peerId || '').trim();
      if (!peerId || map.has(peerId)) continue;
      const name = getPeerDisplayName(row.peerLabel) || String(row.peerDisplayName || '').trim();
      if (name) map.set(peerId, name);
    }

    for (const conv of allConversations) {
      const peerId = String(conv.peerId || '').trim();
      if (!peerId || map.has(peerId)) continue;
      const name = getPeerDisplayName(String(conv.peerLabel || ''));
      if (name) map.set(peerId, name);
    }

    return map;
  }, [allConversations, discoverRows]);

  // Sort the full list — the row itself is scrollable, so we render every
  // conversation rather than slicing. "Recent" (touched in the last 24 h)
  // still floats to the top so the active workstream stays one glance away;
  // older chats sort by activity beneath them.
  const sidebarConversations = useMemo(() => {
    return [...allConversations].sort((left, right) => {
      const leftRecent = isRecentConversation(left, recentNow) ? 1 : 0;
      const rightRecent = isRecentConversation(right, recentNow) ? 1 : 0;
      if (leftRecent !== rightRecent) return rightRecent - leftRecent;
      return compareConversationsByActivity(left, right);
    });
  }, [allConversations, recentNow]);

  const handleSelectConv = useCallback((id: string) => {
    void actions.openConversation(id);
    onSelectView('chat');
  }, [actions, onSelectView]);

  const handleCloseChannel = useCallback(() => {
    actions.requestChannelClose();
  }, [actions]);

  return (
    <aside className={styles.chatSidebar}>
      <ChatListSection
        conversations={sidebarConversations}
        totalConversationCount={allConversations.length}
        activeConvId={chatActiveConversation}
        sendingConvIds={sendingConvIds}
        chatActiveChannels={chatActiveChannels}
        peerDisplayNameById={peerDisplayNameById}
        onSelectConv={handleSelectConv}
        onCloseChannel={handleCloseChannel}
        onOpenChatSearch={() => setChatSearchOpen(true)}
        menuOpenId={menuOpenId}
        setMenuOpenId={setMenuOpenId}
        menuBtnRefs={menuBtnRefs}
      />
      {chatSearchOpen && (
        <ChatSearchModal
          conversations={allConversations}
          activeConvId={chatActiveConversation}
          sendingConvIds={sendingConvIds}
          peerDisplayNameById={peerDisplayNameById}
          onSelectConv={handleSelectConv}
          onClose={() => setChatSearchOpen(false)}
        />
      )}
    </aside>
  );
}

// Scroll distance (in px) over which the top nav interpolates from
// fully expanded (vertical list with labels) to fully collapsed (3
// icons in a row). Picked to feel responsive: ~one notch of a
// trackpad / mousewheel completes the collapse.
const NAV_COLLAPSE_SCROLL_RANGE_PX = 56;

type NavLayoutCache = {
  expandedHeight: number;
  collapsedHeight: number;
  iconDeltas: Map<string, { dx: number; dy: number }>;
};

export function Sidebar({ activeView, onSelectView }: SidebarProps) {
  const { devMode } = useUiSnapshot();
  const navEntries = [...baseEntries, ...configEntries];
  const sidebarRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLUListElement | null>(null);

  // Per-button refs. We hand both the icon-wrapper span and the label
  // span their own refs so the scroll-driven interpolation can write
  // individualized inline transforms and opacities each frame.
  // Reusing the same nodes (rather than swapping markup) keeps focus
  // and ARIA stable across the transition.
  const navIconRefs = useRef(new Map<string, HTMLElement>());
  const navLabelRefs = useRef(new Map<string, HTMLElement>());

  // Measured layout endpoints. Captured by measureLayout() after
  // mount and any resize — we briefly toggle the collapsed class
  // (without painting) to read the compact-row positions for every
  // icon, then return the DOM to its previous state. The deltas are
  // what scroll progress interpolates across each frame.
  const layoutCacheRef = useRef<NavLayoutCache | null>(null);

  // Throttling + bail-out state.
  const lastProgressRef = useRef<number>(-1);
  const rafRef = useRef<number | null>(null);

  /** Capture both layout endpoints without ever painting an intermediate state.
   *  Bails (and leaves the cache untouched) if the icons haven't rendered
   *  yet — e.g. HugeiconsIcon SVGs not committed on the first paint — since
   *  measuring then would yield a zero-height strip that we'd pin via
   *  inline styles. The ResizeObserver will trigger a fresh attempt once
   *  the icons actually take up space. */
  const measureLayout = useCallback(() => {
    const sidebar = sidebarRef.current;
    const nav = navRef.current;
    if (!sidebar || !nav) return;

    // Strip any inline interpolation we left from a previous frame so
    // we read true layout positions, not transformed ones.
    nav.style.height = '';
    nav.style.overflow = '';
    for (const node of navIconRefs.current.values()) {
      node.style.transform = '';
    }
    for (const node of navLabelRefs.current.values()) {
      node.style.opacity = '';
      node.style.width = '';
    }

    // 1) Expanded layout endpoint (the default class state).
    const expandedIconRects = new Map<string, DOMRect>();
    for (const [id, node] of navIconRefs.current) {
      expandedIconRects.set(id, node.getBoundingClientRect());
    }
    const expandedHeight = nav.getBoundingClientRect().height;

    // 2) Collapsed layout endpoint. Toggling the class within the same
    // synchronous block means the browser never paints the
    // intermediate state to the screen.
    sidebar.classList.add(styles.sidebarNavCollapsed);
    const collapsedIconRects = new Map<string, DOMRect>();
    for (const [id, node] of navIconRefs.current) {
      collapsedIconRects.set(id, node.getBoundingClientRect());
    }
    const collapsedHeight = nav.getBoundingClientRect().height;
    sidebar.classList.remove(styles.sidebarNavCollapsed);

    // Sanity check: if the strip has no expanded height yet, or the
    // expanded height isn't strictly greater than the collapsed one,
    // measurement happened before layout settled (icons still 0×0).
    // Leave the cache as-is and wait for the next ResizeObserver tick.
    if (expandedHeight <= 0 || expandedHeight <= collapsedHeight) {
      return;
    }

    const iconDeltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, expanded] of expandedIconRects) {
      const collapsed = collapsedIconRects.get(id);
      if (!collapsed) continue;
      iconDeltas.set(id, {
        dx: collapsed.left - expanded.left,
        dy: collapsed.top - expanded.top,
      });
    }

    layoutCacheRef.current = { expandedHeight, collapsedHeight, iconDeltas };
    // Force the next applyProgress() to write again even if scrollTop
    // hasn't moved — our deltas are different now.
    lastProgressRef.current = -1;
  }, []);

  /** Drive the inline styles from the current scroll position. */
  const applyProgress = useCallback(() => {
    rafRef.current = null;
    const sidebar = sidebarRef.current;
    const nav = navRef.current;
    if (!sidebar || !nav) return;

    const progress = Math.max(0, Math.min(1, sidebar.scrollTop / NAV_COLLAPSE_SCROLL_RANGE_PX));
    if (Math.abs(progress - lastProgressRef.current) < 0.002) return;
    lastProgressRef.current = progress;

    const fullyCollapsed = progress >= 0.999;
    const fullyExpanded = progress <= 0.001;
    const cache = layoutCacheRef.current;
    const setStickyOffset = (height: number) => {
      sidebar.style.setProperty('--sidebar-nav-sticky-offset', `${Math.max(0, height)}px`);
    };

    if (fullyCollapsed) {
      // Snap to the real compact endpoint so hit-testing, hover
      // backgrounds, and the sticky chat-list header below line up to
      // the actual rendered positions. Clear all inline writes — CSS
      // owns the static endpoint state.
      sidebar.classList.add(styles.sidebarNavCollapsed);
      nav.style.height = '';
      nav.style.overflow = '';
      setStickyOffset(cache?.collapsedHeight ?? nav.getBoundingClientRect().height);
      for (const node of navIconRefs.current.values()) node.style.transform = '';
      for (const node of navLabelRefs.current.values()) {
        node.style.opacity = '';
        node.style.width = '';
      }
      return;
    }

    // The DOM stays in the expanded layout for any progress < 1, so
    // the collapsed class must be off whenever we're not at the
    // endpoint — otherwise the static compact rules would fight with
    // the inline transforms.
    sidebar.classList.remove(styles.sidebarNavCollapsed);

    if (fullyExpanded || !cache) {
      // At rest (or before the first valid measurement): let CSS own
      // every layout property. Critically we DO NOT pin nav.style.height
      // here — doing so on first paint, before icons have laid out,
      // would lock the strip at a stale tiny height and clip its
      // contents. Same reason we clear inline overflow.
      nav.style.height = '';
      nav.style.overflow = '';
      setStickyOffset(nav.getBoundingClientRect().height);
      for (const node of navIconRefs.current.values()) node.style.transform = '';
      for (const node of navLabelRefs.current.values()) {
        node.style.opacity = '';
        node.style.width = '';
      }
      return;
    }

    // Mid-slide: interpolate strip height, icon positions, and label
    // opacity inline. Apply overflow:hidden inline (only here) so the
    // shrinking strip cleanly clips its descending icons during the
    // slide — at rest the SCSS leaves overflow visible so the natural
    // expanded layout is never at risk of self-clipping.
    const height = cache.expandedHeight + (cache.collapsedHeight - cache.expandedHeight) * progress;
    nav.style.height = `${height}px`;
    nav.style.overflow = 'hidden';
    setStickyOffset(height);

    for (const [id, node] of navIconRefs.current) {
      const delta = cache.iconDeltas.get(id);
      if (!delta) continue;
      node.style.transform = `translate(${delta.dx * progress}px, ${delta.dy * progress}px)`;
    }

    // Labels fade out in the first ~60% of the scroll so the text is
    // fully gone before the icons settle into the row.
    const labelOpacity = Math.max(0, 1 - progress * 1.66);
    for (const node of navLabelRefs.current.values()) {
      node.style.opacity = String(labelOpacity);
    }
  }, []);

  const scheduleApply = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(applyProgress);
  }, [applyProgress]);

  // Measure once after the initial layout, and re-measure when devMode
  // toggles (it inserts/removes its own list which could shift sticky
  // positions). useLayoutEffect so the first paint is already in sync
  // with the current scrollTop.
  useLayoutEffect(() => {
    measureLayout();
    applyProgress();
  }, [measureLayout, applyProgress, devMode]);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;
    sidebar.addEventListener('scroll', scheduleApply, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measureLayout();
        applyProgress();
      });
      ro.observe(sidebar);
    }
    return () => {
      sidebar.removeEventListener('scroll', scheduleApply);
      ro?.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scheduleApply, measureLayout, applyProgress]);

  return (
    <aside ref={sidebarRef} className={styles.sidebar}>
      {/*
        Top nav (Discover / API / Settings). The same buttons render in
        both states — we never swap the markup. Crossing the scroll
        threshold toggles `sidebar-nav-collapsed` on the scroll
        container, which compacts the list via CSS; a FLIP pass
        (capture-rects → commit → animate transform back to 0) makes
        each icon visibly slide from its old position into the new one.
        Keeping the nodes stable preserves focus, ARIA roles, and
        keyboard navigation across the transition.
      */}
      <ul ref={navRef} className={styles.sidebarNav} role="tablist" aria-label="Dashboard Views">
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
                title={label}
              >
                <span
                  className={styles.sidebarBtnIcon}
                  ref={(node) => {
                    if (node) navIconRefs.current.set(view, node);
                    else navIconRefs.current.delete(view);
                  }}
                >
                  <HugeiconsIcon icon={icon} size={18} strokeWidth={1.5} />
                </span>
                <span
                  className={styles.sidebarBtnLabel}
                  ref={(node) => {
                    if (node) navLabelRefs.current.set(view, node);
                    else navLabelRefs.current.delete(view);
                  }}
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <SidebarWarning />

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

    </aside>
  );
}
