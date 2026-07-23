import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BuyerConversationSummary } from '../../../types/bridge';
import {
  conversationPinnedServiceId,
  conversationTitle,
  shortSessionId,
} from '../../../modules/conversations';
import { displayModelLabel } from '../../../modules/model-identity';
import { displayToolName } from '../../../modules/tool-names';
import { loadFavoriteModels } from '../../../modules/vpr-favorites';
import { findCatalogEntry } from '../../../modules/vpr-model-catalog';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/vpr-recommended-models';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { VprPage } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { chatModelLabel, VprChatRow } from '../vpr/VprRecentChats';
import styles from './VprChatsView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const POLL_MS = 3_000;

/**
 * Dedicated chats page (no nav-rail item — reached from the Recent chats
 * cards on Home and Apps). The list mirrors the floating pill's dropdown;
 * drilling into a chat picks its model the same way the pill does, plus
 * rename and delete management.
 */
export function VprChatsView({ onSelectView: _onSelectView }: Props) {
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  const [conversations, setConversations] = useState<BuyerConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Which way the next level change animates (same pattern as the floating
  // pill): drilling into a chat slides from the right, back from the left.
  const [navDir, setNavDir] = useState<'forward' | 'back'>('forward');

  const drillIn = useCallback((id: string) => {
    setNavDir('forward');
    setSelectedId(id);
  }, []);
  const drillBack = useCallback(() => {
    setNavDir('back');
    setSelectedId(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setConversations((await window.antseedDesktop?.buyerConversationsList?.()) ?? []);
    } catch { /* buyer offline — keep the last list */ }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selected = selectedId
    ? conversations.find((chat) => chat.id === selectedId) ?? null
    : null;
  // A selected chat that disappears (deleted elsewhere, aged out) falls back
  // to the list; the rename draft resets per visited chat.
  useEffect(() => {
    if (selectedId && conversations.length > 0 && !selected) drillBack();
  }, [selectedId, selected, conversations.length, drillBack]);
  useEffect(() => {
    setDraftLabel(null);
    setMessage(null);
  }, [selectedId]);

  const selectedEntry = snap.selection.model
    ? findCatalogEntry(snap.catalog, snap.selection.model.provider, snap.selection.model.serviceId)
    : null;
  const defaultModelLabel = selectedEntry?.label
    ?? (snap.selection.model ? displayModelLabel(snap.selection.model.serviceId, snap.selection.model.label) : null);

  // Same curated lineup as the pill's model list (favorites first, then the
  // recommended models), with the chat's pinned model always present so it
  // never disappears from its own picker.
  const favorites = useMemo(loadFavoriteModels, [selectedId]);
  const models = useMemo(() => {
    const favoriteEntries = selectFavoriteVprCatalog(snap.catalog, favorites);
    const recommended = selectRecommendedVprCatalog(snap.catalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    const list = [...favoriteEntries, ...recommended];
    const pinnedServiceId = selected ? conversationPinnedServiceId(selected) : null;
    if (pinnedServiceId && !list.some((entry) => entry.serviceId === pinnedServiceId)) {
      const pinnedEntry = snap.catalog.find((entry) => entry.serviceId === pinnedServiceId);
      if (pinnedEntry) list.unshift(pinnedEntry);
    }
    return list;
  }, [favorites, selected, snap.catalog]);

  const pinChat = useCallback(async (id: string, provider: string, serviceId: string) => {
    // Resolve the best peer for the model the same way the global route does.
    const routes = routesForSelectedModel(snap.discoverRows, { provider, serviceId });
    const peerId = chooseBestVprRoute(routes, snap.preferences)?.peerId;
    if (!peerId) {
      setMessage(`No available route for ${serviceId} right now`);
      return;
    }
    setMessage(null);
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id, pinnedModel: `${peerId}@${serviceId}` });
    await refresh();
  }, [refresh, snap.discoverRows, snap.preferences]);

  const saveLabel = useCallback(async () => {
    if (!selected || draftLabel === null) return;
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id: selected.id, label: draftLabel.trim() || null });
    setDraftLabel(null);
    await refresh();
  }, [draftLabel, refresh, selected]);

  const deleteChat = useCallback(async () => {
    if (!selected) return;
    const title = conversationTitle(selected);
    if (!window.confirm(`Delete "${title}"? An active chat reappears on its next request.`)) return;
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id: selected.id, delete: true });
    drillBack();
    await refresh();
  }, [drillBack, refresh, selected]);

  return (
    <section
      className={`view view-vpr-chats view-pinned-header ${styles.view}${selected ? ` ${styles.viewDetail}` : ''}`}
      role="tabpanel"
    >
      <VprPage
        title={selected ? conversationTitle(selected) : 'Chats'}
        onBack={selected ? drillBack : undefined}
        backFallback="home"
      >
        <div className={styles.stack}>
          {message ? <p className={styles.note} role="status">{message}</p> : null}

          <div
            key={selected ? selected.id : 'list'}
            className={navDir === 'back' ? styles.slideBack : styles.slide}
          >
          {selected ? (
            <>
              <div className={styles.nameCard}>
                <label className={styles.nameField}>
                  <span className={styles.nameLabel}>Chat name</span>
                  <input
                    type="text"
                    value={draftLabel ?? selected.label ?? ''}
                    placeholder={selected.snippet || 'Name this chat'}
                    spellCheck={false}
                    onChange={(event) => setDraftLabel(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                    onBlur={() => void saveLabel()}
                  />
                </label>
                <span className={styles.nameMeta}>
                  {displayToolName(selected.tool)} · {shortSessionId(selected.sessionKey)}
                </span>
              </div>

              <div className={styles.modelGroup}>
                <p className={styles.sectionLabel}>Model</p>
                <div className={styles.modelScroll}>
                  <VprModelRowList
                    entries={models}
                    selectedServiceId={conversationPinnedServiceId(selected) ?? undefined}
                    favoriteKeys={favorites}
                    onSelect={(provider, serviceId) => { void pinChat(selected.id, provider, serviceId); }}
                    emptyLabel="No models available"
                    frameless
                  />
                </div>
              </div>

              <button type="button" className={styles.deleteButton} onClick={() => void deleteChat()}>
                Delete chat
              </button>
            </>
          ) : conversations.length === 0 ? (
            <div className={styles.empty}>No tool chats yet — connect an app and send a prompt</div>
          ) : (
            <div className={styles.listCard}>
              {conversations.map((chat) => (
                <VprChatRow
                  key={chat.id}
                  chat={chat}
                  modelLabel={chatModelLabel(chat, snap.catalog, defaultModelLabel)}
                  onClick={() => drillIn(chat.id)}
                />
              ))}
            </div>
          )}
          </div>
        </div>
      </VprPage>
    </section>
  );
}
