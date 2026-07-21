import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  type RefObject,
} from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreVerticalIcon, Add01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import { getPeerGradient, getPeerDisplayName, formatCompactTokens } from '../../core/peer-utils';
import { displayModelLabel } from '../../modules/model-identity';
import { formatUsdcAmount } from '../../core/format';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { useActions } from '../hooks/useActions';
import styles from './ChatListPanel.module.scss';

type ConvRecord = Record<string, unknown>;

const EMPTY_CONVERSATIONS: unknown[] = [];
const RECENT_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_SESSION_CLOCK_MS = 60 * 1000;

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
  return displayModelLabel(raw.replace(/-20\d{6,}/, ''));
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
      <div className={styles.contextMenu} ref={menuRef}>
        <input
          ref={renameInputRef}
          className={styles.renameInput}
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
    <div className={styles.contextMenu} ref={menuRef}>
      <button className={styles.contextItem} onClick={() => setRenaming(true)}>
        Rename
      </button>
      <button
        className={`${styles.contextItem} ${styles.contextItemDanger}`}
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

function ConversationRow({
  conv,
  activeConvId,
  sendingConvIds,
  approvalConvIds,
  chatActiveChannels,
  peerDisplayNameById,
  peerIconUrlById,
  onSelectConv,
  onCloseChannel,
  menuOpenId,
  setMenuOpenId,
  menuBtnRefs,
}: {
  conv: ConvRecord;
  activeConvId: string | null;
  sendingConvIds: ReadonlySet<string>;
  approvalConvIds: ReadonlySet<string>;
  chatActiveChannels: Map<string, { reservedUsdc: string; peerName: string }>;
  peerDisplayNameById: ReadonlyMap<string, string>;
  peerIconUrlById: ReadonlyMap<string, string>;
  onSelectConv: (id: string) => void;
  onCloseChannel: () => void;
  menuOpenId: string | null;
  setMenuOpenId: (id: string | null) => void;
  menuBtnRefs: RefObject<Map<string, HTMLButtonElement | null>>;
}) {
  const id = getConversationId(conv);
  const title = String(conv.title || 'Untitled chat');
  const isActive = id === activeConvId;
  const needsApproval = approvalConvIds.has(id);
  const isRunning = sendingConvIds.has(id);
  const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
  const totalTokens = Number(conv.totalTokens) || 0;
  const costLabel = totalTokens > 0
    ? `$${formatUsdcAmount(totalCost)}/${formatCompactTokens(totalTokens)}`
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
  const avatarIconUrl = convPeerId ? peerIconUrlById.get(convPeerId) ?? null : null;
  const [avatarIconFailed, setAvatarIconFailed] = useState(false);
  const showAvatarIcon = Boolean(avatarIconUrl) && !avatarIconFailed;

  return (
    <div
      className={`${styles.convItem}${isActive ? ` ${styles.active}` : ''}`}
      onClick={() => onSelectConv(id)}
    >
      <div className={styles.convTop}>
        <div className={styles.convTitle}>{title}</div>
        {(needsApproval || isRunning) && (
          <span
            className={`${styles.runningDot}${needsApproval ? ` ${styles.approvalDot}` : ''}`}
            role="status"
            aria-label={needsApproval ? 'Approval required' : 'Request in progress'}
            title={needsApproval ? 'Approval required' : 'Request in progress'}
          />
        )}
        <div className={styles.convRight}>
          <button
            className={styles.menuBtn}
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
      <div className={styles.meta}>
        <span
          className={`${styles.avatar}${showAvatarIcon ? ` ${styles.avatarIcon}` : ''}`}
          style={showAvatarIcon ? undefined : { background: avatarGradient }}
        >
          {showAvatarIcon ? (
            <img
              className={styles.avatarImage}
              src={avatarIconUrl ?? undefined}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setAvatarIconFailed(true)}
            />
          ) : avatarLetter}
        </span>
        <span className={styles.peerName}>{peerName}</span>
        {costLabel && <span className={styles.cost}>{costLabel}</span>}
        <span className={styles.time}>{timeLabel}</span>
      </div>
      {session && (
        <div className={styles.sessionStrip}>
          <span className={styles.sessionInfo}>
            Reserved ${formatUsdcAmount(Number(session.reservedUsdc) || 0)} · Used ${formatUsdcAmount(usedUsdc)}
          </span>
          <button
            className={styles.sessionCloseBtn}
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
      className={styles.searchOverlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={styles.searchModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
      >
        <header className={styles.searchHeader}>
          <div>
            <h2 id="chat-search-title">Conversations</h2>
            <p>Search across every peer, session title, service, and workspace.</p>
          </div>
          <button className={styles.searchClose} onClick={onClose} aria-label="Close chat search">
            ×
          </button>
        </header>

        <input
          ref={inputRef}
          className={styles.searchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations, peers, services..."
        />

        <div className={styles.searchSummary}>
          {results.length} of {conversations.length} conversation{conversations.length === 1 ? '' : 's'}
        </div>

        <div className={styles.searchResults}>
          {results.length === 0 ? (
            <div className={styles.searchEmpty}>No chats match that search.</div>
          ) : (
            results.map((conv) => {
              const id = getConversationId(conv);
              const title = String(conv.title || 'Untitled chat');
              const peerName = getConversationPeerName(conv, peerDisplayNameById);
              const serviceLabel = shortServiceName(conv.service);
              const totalCost = Number(conv.totalEstimatedCostUsd) || 0;
              const totalTokens = Number(conv.totalTokens) || 0;
              const costLabel = totalTokens > 0
                ? `$${formatUsdcAmount(totalCost)}/${formatCompactTokens(totalTokens)}`
                : '';
              const timeLabel = formatChatTime(getConversationUpdatedAt(conv));
              const isActive = id === activeConvId;
              const isRunning = sendingConvIds.has(id);

              return (
                <button
                  key={id}
                  className={`${styles.searchResult}${isActive ? ` ${styles.searchResultActive}` : ''}`}
                  onClick={() => {
                    onSelectConv(id);
                    onClose();
                  }}
                >
                  <span className={styles.searchResultMain}>
                    <span className={styles.searchResultTitle}>{title}</span>
                    {isRunning && (
                      <span
                        className={styles.runningDot}
                        role="status"
                        aria-label="Request in progress"
                        title="Request in progress"
                      />
                    )}
                  </span>
                  <span className={styles.searchResultMeta}>
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

export function ChatListPanel({ onSelectView }: { onSelectView?: (view: import('../types').ViewName) => void } = {}) {
  const {
    chatConversations,
    chatActiveConversation,
    chatSendingConversationIds,
    chatToolApprovalRequests,
    chatActiveChannels,
    discoverRows,
    chatServiceOptions,
    chatSelectedServiceValue,
    chatSelectedPeerId,
  } = useUiSelector((state) => ({
    chatConversations: state.chatConversations,
    chatActiveConversation: state.chatActiveConversation,
    chatSendingConversationIds: state.chatSendingConversationIds,
    chatToolApprovalRequests: state.chatToolApprovalRequests,
    chatActiveChannels: state.chatActiveChannels,
    chatActiveChannelCount: state.chatActiveChannels.size,
    discoverRows: state.discoverRows,
    chatServiceOptions: state.chatServiceOptions,
    chatSelectedServiceValue: state.chatSelectedServiceValue,
    chatSelectedPeerId: state.chatSelectedPeerId,
  }), shallowEqual);
  const actions = useActions();
  const conversations = Array.isArray(chatConversations) ? chatConversations : EMPTY_CONVERSATIONS;
  const allConversations = conversations as ConvRecord[];
  const sendingConvIds = useMemo(
    () => new Set(Array.isArray(chatSendingConversationIds) ? chatSendingConversationIds : []),
    [chatSendingConversationIds],
  );
  const approvalConvIds = useMemo(() => {
    const ids = new Set<string>();
    const requests = Array.isArray(chatToolApprovalRequests) ? chatToolApprovalRequests : [];
    for (const request of requests) {
      if (request.conversationId) ids.add(request.conversationId);
    }
    return ids;
  }, [chatToolApprovalRequests]);
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

  const peerIconUrlById = useMemo(() => {
    const map = new Map<string, string>();
    const rows = Array.isArray(discoverRows) ? discoverRows : [];
    for (const row of rows) {
      const peerId = String(row.peerId || '').trim();
      if (!peerId || map.has(peerId) || !row.peerIconUrl) continue;
      map.set(peerId, row.peerIconUrl);
    }
    return map;
  }, [discoverRows]);

  // Activity sort with "recent" (touched in the last 24 h) floated to the
  // top so the active workstream stays one glance away; older chats sort
  // by activity beneath them.
  const sortedConversations = useMemo(() => {
    return [...allConversations].sort((left, right) => {
      const leftRecent = isRecentConversation(left, recentNow) ? 1 : 0;
      const rightRecent = isRecentConversation(right, recentNow) ? 1 : 0;
      if (leftRecent !== rightRecent) return rightRecent - leftRecent;
      return compareConversationsByActivity(left, right);
    });
  }, [allConversations, recentNow]);

  const handleSelectConv = useCallback((id: string) => {
    void actions.openConversation(id);
  }, [actions]);

  const activeConversation = useMemo(
    () => allConversations.find((conv) => getConversationId(conv) === chatActiveConversation) ?? null,
    [allConversations, chatActiveConversation],
  );

  const newChatTarget = useMemo(() => {
    if (!activeConversation) return null;

    const peerId = String(activeConversation.peerId || chatSelectedPeerId || '').trim();
    if (!peerId) return null;

    const serviceId = String(activeConversation.service || '').trim();
    const provider = String(activeConversation.provider || '').trim();
    const selectedForPeer = chatServiceOptions.find(
      (option) => option.peerId === peerId && option.value === chatSelectedServiceValue,
    );
    const matchingOption = selectedForPeer ?? chatServiceOptions.find((option) => (
      option.peerId === peerId
      && (!serviceId || option.id === serviceId)
      && (!provider || option.provider === provider)
    )) ?? chatServiceOptions.find((option) => option.peerId === peerId && (!serviceId || option.id === serviceId));

    if (matchingOption?.value) return { peerId, serviceValue: matchingOption.value };

    const matchingRow = discoverRows.find((row) => (
      row.peerId === peerId
      && (!serviceId || row.serviceId === serviceId)
      && (!provider || row.provider === provider)
    )) ?? discoverRows.find((row) => row.peerId === peerId && (!serviceId || row.serviceId === serviceId));

    return matchingRow?.selectionValue ? { peerId, serviceValue: matchingRow.selectionValue } : null;
  }, [activeConversation, chatSelectedPeerId, chatServiceOptions, chatSelectedServiceValue, discoverRows]);

  const handleCloseChannel = useCallback(() => {
    // Channel management moved in-app: the activity view lists channels and
    // opens the secure checkout page for the close signature.
    onSelectView?.('activity');
  }, [onSelectView]);

  const handleStartNewChat = useCallback(() => {
    actions.startNewChat();
    if (newChatTarget) {
      actions.handleServiceChange(newChatTarget.serviceValue, newChatTarget.peerId);
    }
  }, [actions, newChatTarget]);

  return (
    <aside className={styles.panel} aria-labelledby="chat-list-label">
      <div className={styles.header} id="chat-list-label">
        <span className={styles.headerText}>
          <span>Conversations</span>
          {allConversations.length > 0 && (
            <span className={styles.count} aria-label={`${allConversations.length} total conversations`}>
              {allConversations.length}
            </span>
          )}
        </span>
        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handleStartNewChat}
            disabled={!newChatTarget}
            aria-label="Start a new chat with the current peer and service"
            title="Start a new chat with the current peer and service"
          >
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setChatSearchOpen(true)}
            aria-label="Search conversations"
            title="Search conversations"
          >
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
          </button>
        </span>
      </div>
      <div className={styles.list}>
        {sortedConversations.length === 0 ? (
          <div className={styles.empty}>No conversations yet</div>
        ) : (
          sortedConversations.map((conv) => (
            <ConversationRow
              key={getConversationId(conv)}
              conv={conv}
              activeConvId={chatActiveConversation}
              sendingConvIds={sendingConvIds}
              approvalConvIds={approvalConvIds}
              chatActiveChannels={chatActiveChannels}
              peerDisplayNameById={peerDisplayNameById}
              peerIconUrlById={peerIconUrlById}
              onSelectConv={handleSelectConv}
              onCloseChannel={handleCloseChannel}
              menuOpenId={menuOpenId}
              setMenuOpenId={setMenuOpenId}
              menuBtnRefs={menuBtnRefs}
            />
          ))
        )}
      </div>
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
