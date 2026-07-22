import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowUpRight01Icon, Copy01Icon, Delete02Icon, HelpCircleIcon, SquareLock01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { BuyerConversationSummary, RuntimeProcessState, SystemProxyProfileSummary } from '../../../types/bridge';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import {
  activeProfilesFromRuntimeState,
  buildVprPeerOptions,
  resolveVprToolRouteForPeerOptions,
} from '../../../modules/vpr-tools';
import { displayToolName } from '../../../modules/tool-names';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { BrandIcon } from '../brand/BrandIcon';
import { InfoTooltip } from '../InfoTooltip';
import { VprBadge, VprCard, VprPage, VprSearch } from '../vpr/VprKit';
import styles from './VprToolsView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const DEFAULT_PORT = 8378;

/** Compact relative timestamp for chat rows ("now", "5m", "2h", "3d"). */
function relativeChatTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** Per-app "how to use" line for the help tooltip next to each app name. */
function appHelpHowTo(profile: SystemProxyProfileSummary): string {
  if (profile.canRestart || profile.appAction === 'restart-app') {
    return `Press Connect, then restart ${profile.displayName} so it picks up the new routing.`;
  }
  if (profile.appAction === 'open-url' || profile.appAction === 'open-tool') {
    return `Press Connect, then open ${profile.displayName} with the arrow button and use it normally.`;
  }
  return `Press Connect and use ${profile.displayName} as usual. Disconnect anytime to route directly again.`;
}

type GuiTestResult = {
  ok: boolean;
  proxyConfigured: boolean;
  proxyReachable: boolean;
  guiTrustOk: boolean;
  certTrustError: boolean;
  appRunning: boolean;
  needsAppRestart: boolean;
  appPid?: number;
  statusCode?: number;
  error?: string;
};

export function VprToolsView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    lastPeers: state.lastPeers,
    discoverRows: state.discoverRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
    catalog: state.vprModelCatalog,
  }), shallowEqual);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [proxyState, setProxyState] = useState<RuntimeProcessState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [guiTest, setGuiTest] = useState<GuiTestResult | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [caInfo, setCaInfo] = useState<{ path: string; exists: boolean } | null>(null);
  const [caCopied, setCaCopied] = useState(false);
  const [conversations, setConversations] = useState<BuyerConversationSummary[]>([]);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatLabel, setEditingChatLabel] = useState('');

  const peerOptions = useMemo(() => buildVprPeerOptions(snap.lastPeers, snap.discoverRows), [snap.lastPeers, snap.discoverRows]);
  const modelRoutes = useMemo(() => routesForSelectedModel(snap.discoverRows, snap.selection.model), [snap.discoverRows, snap.selection.model]);
  const bestRoute = useMemo(() => chooseBestVprRoute(modelRoutes, snap.preferences), [modelRoutes, snap.preferences]);
  const defaultPeerId = snap.selection.peerId || bestRoute?.peerId || peerOptions[0]?.peerId || '';
  const defaultModel = snap.selection.model?.serviceId || peerOptions.find((peer) => peer.peerId === defaultPeerId)?.services[0] || '';
  const activeProfiles = useMemo(() => activeProfilesFromRuntimeState(proxyState), [proxyState]);
  const activeProfileNames = useMemo(() => activeProfiles ? [...activeProfiles] : [], [activeProfiles]);
  const hasConnectedProxyProfile = useMemo(() => (
    profiles.some((profile) => profile.kind === 'proxy' && (activeProfiles?.has(profile.name) ?? false))
  ), [activeProfiles, profiles]);

  const hasProxyProfile = useMemo(() => profiles.some((profile) => profile.kind === 'proxy'), [profiles]);

  // Name the default route's model in chat pin selects, so "Auto" still says
  // which model the chat actually runs on.
  const defaultModelLabel = useMemo(() => {
    const model = snap.selection.model;
    if (!model) return null;
    return snap.catalog.find((entry) => entry.serviceId === model.serviceId)?.label ?? model.serviceId;
  }, [snap.catalog, snap.selection.model]);

  const refresh = useCallback(async () => {
    const bridge = window.antseedDesktop;
    try {
      const [nextProfiles, nextState, nextCa, nextConversations] = await Promise.all([
        bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
        bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
        bridge?.systemProxyCaInfo?.() ?? Promise.resolve(null),
        bridge?.buyerConversationsList?.() ?? Promise.resolve([]),
      ]);
      setProfiles(nextProfiles);
      setProxyState(nextState);
      setCaInfo(nextCa);
      setConversations(nextConversations);
    } catch {
      setProfiles([]);
      setProxyState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const testGui = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyTestGui) return;
    try {
      setGuiTest(await bridge.systemProxyTestGui({ port: DEFAULT_PORT }));
    } catch (err) {
      setGuiTest({
        ok: false,
        proxyConfigured: false,
        proxyReachable: false,
        guiTrustOk: false,
        certTrustError: false,
        appRunning: false,
        needsAppRestart: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!hasConnectedProxyProfile) {
      setGuiTest(null);
      return;
    }
    void testGui();
  }, [hasConnectedProxyProfile, testGui]);

  // Every connected app follows the default VPR route; the model itself is
  // resolved live by the buyer (the `antseed` alias), so there are no per-app
  // model overrides here anymore.
  const startProfiles = useCallback(async (names: string[]): Promise<boolean> => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyStart || !defaultPeerId) return false;
    setBusy(names.join(','));
    setMessage(null);
    const defaultRoute = { peerId: defaultPeerId, model: defaultModel };
    const routeOverrides = Object.fromEntries(
      names.map((name) => [name, resolveVprToolRouteForPeerOptions({}, name, defaultRoute, peerOptions)]),
    );
    const result = await bridge.systemProxyStart({
      peerId: defaultPeerId,
      port: DEFAULT_PORT,
      profiles: names,
      defaultModel: defaultModel || undefined,
      servedModels: peerOptions.find((peer) => peer.peerId === defaultPeerId)?.services ?? [],
      toolRoutes: routeOverrides,
      profileSwitch: proxyState?.running === true || activeProfileNames.length > 0,
    });
    setBusy(null);
    if (!result.ok) {
      setMessage(result.error ?? 'Unable to connect tool profile');
      return false;
    }
    setProxyState(result.state ?? null);
    return true;
  }, [activeProfileNames.length, defaultModel, defaultPeerId, peerOptions, proxyState?.running]);

  const disconnect = useCallback(async () => {
    const bridge = window.antseedDesktop;
    setBusy('stop');
    const result = await bridge?.systemProxyStop?.();
    setBusy(null);
    if (result?.ok) {
      setProxyState(result.state ?? null);
    } else {
      setMessage(result?.error ?? 'Unable to disconnect tools');
    }
  }, []);

  const connectProfile = useCallback((profileName: string) => {
    const names = Array.from(new Set([...activeProfileNames, profileName]));
    void startProfiles(names).then((ok) => {
      // Surface the pill right away, dropdown open, so the "start a new
      // session" guidance is in view while the user switches to the tool.
      if (ok) void actions.openVprFloat?.(profileName, { openMenu: true });
    });
  }, [actions, activeProfileNames, startProfiles]);

  const disconnectProfile = useCallback((profileName: string) => {
    const remaining = activeProfileNames.filter((name) => name !== profileName);
    if (remaining.length === 0) {
      void disconnect();
      return;
    }
    void startProfiles(remaining);
  }, [activeProfileNames, disconnect, startProfiles]);

  const openUrl = useCallback(async (url: string) => {
    const result = await window.antseedDesktop?.openExternalUrl?.(url);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const openTool = useCallback(async (toolName: string) => {
    const result = await window.antseedDesktop?.openTool?.(toolName);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const restartApp = useCallback(async (profileName: string, label: string) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyRestartApp) return;
    setActionBusy(profileName);
    setMessage(null);
    try {
      const result = await bridge.systemProxyRestartApp(profileName);
      setMessage(result.ok ? `Restarted ${label}` : (result.error ?? `Unable to restart ${label}`));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, []);

  const trustCa = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyInstallCa) return;
    setTrustBusy(true);
    setMessage(null);
    try {
      const result = await bridge.systemProxyInstallCa();
      if (!result.ok) {
        setMessage(result.error ?? 'CA install failed');
        return;
      }
      if (result.warning) setMessage(result.warning);
      await testGui();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTrustBusy(false);
    }
  }, [testGui]);

  const revealCa = useCallback(async () => {
    const result = await window.antseedDesktop?.systemProxyRevealCa?.();
    if (result && !result.ok) setMessage(result.error ?? 'Could not reveal the certificate');
  }, []);

  const copyCaPath = useCallback(async () => {
    if (!caInfo?.path) return;
    try {
      await navigator.clipboard.writeText(caInfo.path);
      setCaCopied(true);
      window.setTimeout(() => setCaCopied(false), 1500);
    } catch {
      setCaCopied(false);
    }
  }, [caInfo?.path]);

  // ---------- Recent chats (per-chat routing, buyer-backed) ----------

  const refreshConversations = useCallback(async () => {
    try {
      setConversations((await window.antseedDesktop?.buyerConversationsList?.()) ?? []);
    } catch { /* buyer offline — keep the last list */ }
  }, []);

  const renameChat = useCallback(async (id: string, label: string) => {
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id, label: label.trim() || null });
    setEditingChatId(null);
    await refreshConversations();
  }, [refreshConversations]);

  const deleteChat = useCallback(async (id: string, title: string) => {
    if (!window.confirm(`Delete "${title}" from recent chats? An active chat reappears on its next request.`)) return;
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id, delete: true });
    await refreshConversations();
  }, [refreshConversations]);

  const pinChat = useCallback(async (id: string, value: string) => {
    if (!value) {
      await window.antseedDesktop?.buyerConversationsUpdate?.({ id, pinnedModel: '' });
      await refreshConversations();
      return;
    }
    const [provider, ...rest] = value.split(':');
    const serviceId = rest.join(':');
    if (!provider || !serviceId) return;
    // Resolve the best peer for the model the same way the global route does.
    const routes = routesForSelectedModel(snap.discoverRows, { provider, serviceId });
    const peerId = chooseBestVprRoute(routes, snap.preferences)?.peerId;
    if (!peerId) {
      setMessage(`No available route for ${serviceId} right now`);
      return;
    }
    await window.antseedDesktop?.buyerConversationsUpdate?.({ id, pinnedModel: `${peerId}@${serviceId}` });
    await refreshConversations();
  }, [refreshConversations, snap.discoverRows, snap.preferences]);

  const addCustomApp = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyAddCustomApp) return;
    setAddBusy(true);
    setMessage(null);
    try {
      const result = await bridge.systemProxyAddCustomApp({ apiUrl: addUrl });
      if (!result.ok) {
        setMessage(result.error ?? 'Unable to add custom app');
        return;
      }
      setAddOpen(false);
      setAddUrl('');
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }, [addUrl, refresh]);

  const removeCustomApp = useCallback(async (profileName: string, connected: boolean) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyRemoveCustomApp) return;
    setActionBusy(profileName);
    setMessage(null);
    try {
      if (connected) {
        const remaining = activeProfileNames.filter((name) => name !== profileName);
        if (remaining.length === 0) {
          await disconnect();
        } else {
          await startProfiles(remaining);
        }
      }
      const result = await bridge.systemProxyRemoveCustomApp(profileName);
      if (!result.ok) {
        setMessage(result.error ?? 'Unable to remove app');
        return;
      }
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [activeProfileNames, disconnect, refresh, startProfiles]);

  const visibleProfiles = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? profiles.filter((profile) => profile.displayName.toLowerCase().includes(query) || profile.name.toLowerCase().includes(query))
      : profiles;
    // Connected apps float to the top; the sort is stable, so each group keeps
    // its original order.
    const isConnected = (name: string): boolean => activeProfiles?.has(name) ?? false;
    return [...filtered].sort((a, b) => Number(isConnected(b.name)) - Number(isConnected(a.name)));
  }, [profiles, search, activeProfiles]);

  return (
    <section className={`view view-vpr-tools view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Connected apps" backFallback="home">
      <div className={styles.stack}>

        <VprSearch value={search} onChange={setSearch} placeholder="Search app" />

        {message ? <p className={styles.note} role="status">{message}</p> : null}

        {visibleProfiles.length === 0 ? (
          <div className={styles.empty}>{profiles.length === 0 ? 'No tool profiles configured' : 'No apps match your search'}</div>
        ) : (
          <div className={styles.appList}>
            {visibleProfiles.map((profile) => {
              const connected = activeProfiles?.has(profile.name) ?? false;
              const canOpenUrl = connected && profile.appAction === 'open-url' && !!profile.openUrl;
              const canOpenTool = connected && profile.appAction === 'open-tool';
              const canOpen = canOpenUrl || canOpenTool;
              const canRestart = connected && (profile.canRestart || profile.appAction === 'restart-app');
              const hasActions = canRestart;
              return (
                <div key={profile.name} className={`${styles.appPill}${connected ? ` ${styles.appPillConnected}` : ''}`}>
                  <div className={styles.appHead}>
                    <span className={styles.appIdentity}>
                      {profile.iconDataUri ? (
                        <img src={profile.iconDataUri} alt="" className={styles.appIcon} />
                      ) : (
                        <BrandIcon name={profile.name} hints={[profile.displayName]} size={24} />
                      )}
                      <span className={styles.appText}>
                        <span className={styles.appNameRow}>
                          <span className={styles.appName}>{profile.displayName}</span>
                          <InfoTooltip
                            align="left"
                            content={
                              <>
                                <strong>{profile.displayName} through AntSeed</strong>
                                <span>
                                  Connecting routes {profile.displayName}&apos;s AI requests through AntSeed —
                                  the app works as usual while its model calls are served by peers and paid
                                  from your balance.
                                </span>
                                <span>{appHelpHowTo(profile)}</span>
                              </>
                            }
                          >
                            <span className={styles.helpIcon} tabIndex={0} role="img" aria-label={`How ${profile.displayName} works with AntSeed`}>
                              <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                            </span>
                          </InfoTooltip>
                        </span>
                        {connected && (
                          <span className={styles.appMeta}>
                            <span className={styles.connectedDot} aria-hidden="true" />
                            Connected
                          </span>
                        )}
                      </span>
                    </span>
                    {canOpen ? (
                      <button
                        type="button"
                        className={styles.appOpen}
                        onClick={() => { void (canOpenUrl ? openUrl(profile.openUrl!) : openTool(profile.toolName ?? profile.name)); }}
                        aria-label={`Open ${profile.displayName}`}
                        title={`Open ${profile.displayName}`}
                      >
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} />
                      </button>
                    ) : null}
                    {profile.custom && !connected ? (
                      <button
                        type="button"
                        className={styles.removeAction}
                        disabled={actionBusy === profile.name || busy !== null}
                        onClick={() => {
                          if (window.confirm(`Remove ${profile.displayName}? Its requests will no longer route through AntSeed.`)) {
                            void removeCustomApp(profile.name, connected);
                          }
                        }}
                        title={`Remove ${profile.displayName}`}
                      >
                        Remove
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={connected ? styles.disconnectAction : styles.connectAction}
                      disabled={busy !== null || (!connected && !defaultPeerId)}
                      onClick={() => { connected ? disconnectProfile(profile.name) : connectProfile(profile.name); }}
                    >
                      {connected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>

                  {hasActions && (
                    <div className={styles.appBody}>
                      <div className={styles.actions}>
                        {canRestart ? (
                          <button
                            type="button"
                            onClick={() => { void restartApp(profile.name, profile.displayName); }}
                            disabled={actionBusy === profile.name}
                          >
                            {actionBusy === profile.name ? 'Restarting...' : `Restart ${profile.displayName}`}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {addOpen ? (
          <VprCard>
            <form
              className={styles.addAppForm}
              onSubmit={(event) => {
                event.preventDefault();
                void addCustomApp();
              }}
            >
              <label>
                <span>API URL</span>
                <input
                  type="text"
                  value={addUrl}
                  placeholder="https://api.example.com/v1"
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => setAddUrl(event.currentTarget.value)}
                  disabled={addBusy}
                />
              </label>
              <p className={styles.addAppHint}>
                Requests the app sends to this URL are routed through AntSeed.
              </p>
              <div className={styles.actions}>
                <button type="submit" disabled={addBusy || addUrl.trim().length === 0}>
                  {addBusy ? 'Adding...' : 'Add app'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAddOpen(false); setAddUrl(''); }}
                  disabled={addBusy}
                >
                  Cancel
                </button>
              </div>
            </form>
          </VprCard>
        ) : (
          <button type="button" className={styles.addAppButton} onClick={() => { setAddOpen(true); setMessage(null); }}>
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
            Add custom app
          </button>
        )}

        {conversations.length > 0 ? (
          <div className={styles.chatsCard}>
            <div className={styles.chatsHead}>
              <span className={styles.chatsTitle}>Recent chats</span>
              <span className={styles.chatsHint}>Pin a model to one chat — everything else follows the default route</span>
            </div>
            {conversations.map((chat) => {
              const title = chat.label || chat.snippet || chat.sessionKey.slice(0, 12);
              const pinnedServiceId = chat.pinnedModel?.split('@').slice(1).join('@') || '';
              const pinnedCatalogEntry = pinnedServiceId
                ? snap.catalog.find((entry) => entry.serviceId === pinnedServiceId)
                : undefined;
              const pinValue = pinnedCatalogEntry
                ? `${pinnedCatalogEntry.provider}:${pinnedCatalogEntry.serviceId}`
                : (pinnedServiceId ? `?:${pinnedServiceId}` : '');
              return (
                <div key={chat.id} className={styles.chatRow}>
                  <BrandIcon name={chat.tool} hints={[chat.tool]} size={20} />
                  <span className={styles.chatText}>
                    {editingChatId === chat.id ? (
                      <input
                        className={styles.chatEditInput}
                        value={editingChatLabel}
                        autoFocus
                        onChange={(event) => setEditingChatLabel(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void renameChat(chat.id, editingChatLabel);
                          if (event.key === 'Escape') setEditingChatId(null);
                        }}
                        onBlur={() => void renameChat(chat.id, editingChatLabel)}
                        aria-label="Chat name"
                      />
                    ) : (
                      <button
                        type="button"
                        className={styles.chatTitleButton}
                        onClick={() => { setEditingChatId(chat.id); setEditingChatLabel(chat.label ?? ''); }}
                        title="Rename chat"
                      >
                        {title}
                      </button>
                    )}
                    <span className={styles.chatMeta}>
                      {displayToolName(chat.tool)} · {relativeChatTime(chat.lastActiveAt)}
                      {chat.lastModel ? ` · ${chat.lastModel.split('@').slice(1).join('@')}` : ''}
                    </span>
                  </span>
                  <select
                    className={styles.chatPinSelect}
                    value={pinValue}
                    onChange={(event) => void pinChat(chat.id, event.currentTarget.value)}
                    aria-label={`Model for ${title}`}
                  >
                    <option value="">
                      {defaultModelLabel ? `Default · ${defaultModelLabel}` : 'Auto (default route)'}
                    </option>
                    {pinnedServiceId && !pinnedCatalogEntry ? (
                      <option value={`?:${pinnedServiceId}`}>{pinnedServiceId}</option>
                    ) : null}
                    {snap.catalog.map((entry) => (
                      <option key={`${entry.provider}:${entry.serviceId}`} value={`${entry.provider}:${entry.serviceId}`}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.chatDelete}
                    onClick={() => void deleteChat(chat.id, title)}
                    aria-label={`Delete ${title}`}
                    title="Delete chat"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {caInfo && (hasProxyProfile || caInfo.exists) ? (
          <div className={styles.caCard}>
            <div className={styles.caHead}>
              <HugeiconsIcon icon={SquareLock01Icon} size={14} strokeWidth={2} />
              <span className={styles.caTitle}>HTTPS certificate</span>
              <VprBadge tone={guiTest?.certTrustError ? 'neutral' : caInfo.exists ? 'green' : 'neutral'}>
                {guiTest?.certTrustError ? 'Not trusted' : caInfo.exists ? 'Installed' : 'Not created yet'}
              </VprBadge>
            </div>
            <p className={styles.caHint}>
              Apps whose HTTPS traffic is intercepted trust a certificate generated locally on this
              device. It never leaves your machine — inspect it any time.
            </p>
            <button type="button" className={styles.caPath} onClick={() => { void copyCaPath(); }} title={caInfo.path}>
              <code>{caInfo.path}</code>
              <HugeiconsIcon icon={caCopied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={2} />
              <span>{caCopied ? 'Copied' : 'Copy'}</span>
            </button>
            {caInfo.exists || guiTest?.certTrustError ? (
              <div className={styles.actions}>
                {caInfo.exists ? (
                  <button type="button" onClick={() => { void revealCa(); }}>Reveal certificate</button>
                ) : null}
                {guiTest?.certTrustError ? (
                  <button type="button" onClick={() => { void trustCa(); }} disabled={trustBusy}>
                    {trustBusy ? 'Trusting...' : 'Trust certificate'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      </VprPage>
    </section>
  );
}
