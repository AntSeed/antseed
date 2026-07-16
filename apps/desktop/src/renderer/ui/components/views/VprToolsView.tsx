import { useCallback, useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowUpRight01Icon, Copy01Icon, SquareLock01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { RuntimeProcessState, SystemProxyProfileSummary } from '../../../types/bridge';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import {
  activeProfilesFromRuntimeState,
  buildVprPeerOptions,
  resolveVprToolRouteForPeerOptions,
} from '../../../modules/vpr-tools';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { BrandIcon } from '../brand/BrandIcon';
import { VprBackTitle, VprBadge, VprCard, VprSearch } from '../vpr/VprKit';
import styles from './VprToolsView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const DEFAULT_PORT = 8378;

type GuiTestResult = {
  ok: boolean;
  proxyConfigured: boolean;
  proxyReachable: boolean;
  guiTrustOk: boolean;
  appRunning: boolean;
  needsAppRestart: boolean;
  appPid?: number;
  statusCode?: number;
  error?: string;
};

export function VprToolsView({ onSelectView }: Props) {
  const snap = useUiSelector((state) => ({
    lastPeers: state.lastPeers,
    discoverRows: state.discoverRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
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

  const refresh = useCallback(async () => {
    const bridge = window.antseedDesktop;
    try {
      const [nextProfiles, nextState, nextCa] = await Promise.all([
        bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
        bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
        bridge?.systemProxyCaInfo?.() ?? Promise.resolve(null),
      ]);
      setProfiles(nextProfiles);
      setProxyState(nextState);
      setCaInfo(nextCa);
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
  const startProfiles = useCallback(async (names: string[]) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyStart || !defaultPeerId) return;
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
      return;
    }
    setProxyState(result.state ?? null);
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
    void startProfiles(names);
  }, [activeProfileNames, startProfiles]);

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
    <section className={`view view-vpr-tools ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <VprBackTitle title="Connected apps" onBack={() => onSelectView?.('home')} />

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
              const canTrust = connected && profile.kind === 'proxy' && !!guiTest && !guiTest.guiTrustOk && guiTest.proxyReachable;
              const hasActions = canRestart || canTrust || profile.custom;
              return (
                <div key={profile.name} className={`${styles.appPill}${connected ? ` ${styles.appPillConnected}` : ''}`}>
                  <div className={styles.appHead}>
                    <span className={styles.appIdentity}>
                      {profile.iconDataUri ? (
                        <img src={profile.iconDataUri} alt="" className={styles.appIcon} />
                      ) : (
                        <BrandIcon name={profile.name} hints={[profile.displayName]} size={18} />
                      )}
                      <span className={styles.appName}>{profile.displayName}</span>
                      {connected && <VprBadge tone="green">Connected</VprBadge>}
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
                    <button
                      type="button"
                      className={`${styles.appAction}${connected ? ` ${styles.appActionQuiet}` : ''}`}
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
                        {canTrust ? (
                          <button type="button" onClick={() => { void trustCa(); }} disabled={trustBusy}>
                            {trustBusy ? 'Trusting...' : 'Trust CA'}
                          </button>
                        ) : null}
                        {profile.custom ? (
                          <button
                            type="button"
                            className={styles.dangerAction}
                            onClick={() => { void removeCustomApp(profile.name, connected); }}
                            disabled={actionBusy === profile.name || busy !== null}
                          >
                            {actionBusy === profile.name ? 'Removing...' : 'Remove app'}
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

        {caInfo && (hasProxyProfile || caInfo.exists) ? (
          <div className={styles.caCard}>
            <div className={styles.caHead}>
              <HugeiconsIcon icon={SquareLock01Icon} size={14} strokeWidth={2} />
              <span className={styles.caTitle}>HTTPS certificate</span>
              <VprBadge tone={caInfo.exists ? 'green' : 'neutral'}>
                {caInfo.exists ? 'Installed' : 'Not created yet'}
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
            {caInfo.exists ? (
              <div className={styles.actions}>
                <button type="button" onClick={() => { void revealCa(); }}>Reveal certificate</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
