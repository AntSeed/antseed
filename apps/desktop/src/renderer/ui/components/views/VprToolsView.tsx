import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LogEvent, RuntimeProcessState, SystemProxyProfileSummary } from '../../../types/bridge';
import { getUiStateRef } from '../../../core/store';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import {
  activeProfilesFromRuntimeState,
  buildVprPeerOptions,
  buildVprProfileTraffic,
  resolveVprToolRouteForPeerOptions,
  statusLabel,
  type VprToolRoute,
} from '../../../modules/vpr-tools';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
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

export function VprToolsView(_props: Props) {
  const snap = useUiSelector((state) => ({
    lastPeers: state.lastPeers,
    discoverRows: state.discoverRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  // Traffic counters are computed from a periodic sample of the logs instead
  // of the live store reference: state.logs gets a new identity per appended
  // line, which would re-run the (regex-heavy) traffic scan on every log
  // event. A few seconds of staleness is fine here.
  const [sampledLogs, setSampledLogs] = useState<LogEvent[]>([]);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [proxyState, setProxyState] = useState<RuntimeProcessState | null>(null);
  const [toolRoutes, setToolRoutes] = useState<Record<string, VprToolRoute>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [guiTest, setGuiTest] = useState<GuiTestResult | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
  const traffic = useMemo(() => buildVprProfileTraffic(sampledLogs, profiles), [sampledLogs, profiles]);

  const refresh = useCallback(async () => {
    const bridge = window.antseedDesktop;
    try {
      const [nextProfiles, nextState] = await Promise.all([
        bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
        bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
      ]);
      setProfiles(nextProfiles);
      setProxyState(nextState);
    } catch {
      setProfiles([]);
      setProxyState(null);
    }
  }, []);

  useEffect(() => {
    // state.logs is reassigned wholesale on append, so sampling the reference
    // is enough: identity only changes when the logs actually changed.
    const sampleLogs = () => setSampledLogs(getUiStateRef().logs);
    sampleLogs();
    void refresh();
    const timer = setInterval(() => {
      sampleLogs();
      void refresh();
    }, 3000);
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

  const startProfiles = useCallback(async (names: string[], routes = toolRoutes) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyStart || !defaultPeerId) return;
    setBusy(names.join(','));
    setMessage(null);
    const defaultRoute = { peerId: defaultPeerId, model: defaultModel };
    const routeOverrides = Object.fromEntries(
      names.map((name) => [name, resolveVprToolRouteForPeerOptions(routes, name, defaultRoute, peerOptions)]),
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
  }, [activeProfileNames.length, defaultModel, defaultPeerId, peerOptions, proxyState?.running, toolRoutes]);

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

  const updateToolRoute = useCallback((profileName: string, route: VprToolRoute, connected: boolean) => {
    const nextRoutes = { ...toolRoutes, [profileName]: route };
    setToolRoutes(nextRoutes);
    if (!connected) return;
    const names = activeProfileNames.includes(profileName)
      ? activeProfileNames
      : [...activeProfileNames, profileName];
    void startProfiles(names.length > 0 ? names : [profileName], nextRoutes);
  }, [activeProfileNames, startProfiles, toolRoutes]);

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

  const addShellSetup = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyAddToShell) return;
    setActionBusy('shell-setup');
    setMessage(null);
    try {
      const result = await bridge.systemProxyAddToShell({ port: DEFAULT_PORT });
      setMessage(result.ok
        ? (result.added.length > 0 ? `Updated ${result.added.map((file) => file.split('/').pop()).join(', ')}` : 'Shell setup already configured')
        : (result.error ?? 'Unable to update shell setup'));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, []);

  const removeShellSetup = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyRemoveFromShell) return;
    setActionBusy('shell-remove');
    setMessage(null);
    try {
      const result = await bridge.systemProxyRemoveFromShell();
      setMessage(result.ok
        ? (result.removed.length > 0 ? `Removed from ${result.removed.map((file) => file.split('/').pop()).join(', ')}` : 'No shell setup found')
        : (result.error ?? 'Unable to remove shell setup'));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, []);

  return (
    <section className={`view view-vpr-tools ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.header}>
          <span>Tools</span>
          <h2 className={styles.title}>Connections</h2>
        </div>

        {message ? <p className={styles.meta}>{message}</p> : null}
        {profiles.length === 0 ? <div className={styles.empty}>No tool profiles configured</div> : profiles.map((profile) => {
          const connected = activeProfiles?.has(profile.name) ?? false;
          const route = resolveVprToolRouteForPeerOptions(
            toolRoutes,
            profile.name,
            { peerId: defaultPeerId, model: defaultModel },
            peerOptions,
          );
          const profileTraffic = traffic.get(profile.name);
          return (
            <div key={profile.name} className={styles.tool}>
              <div className={styles.toolHeader}>
                <div>
                  <div className={styles.name}>{profile.displayName}</div>
                  <div className={styles.meta}>
                    {profile.method} · {connected ? 'Connected' : 'Disconnected'} · {profileTraffic?.count ?? 0} requests
                    {profileTraffic?.lastStatus ? ` · ${statusLabel(profileTraffic.lastStatus)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy !== null || (!connected && !defaultPeerId)}
                  onClick={() => { connected ? disconnectProfile(profile.name) : connectProfile(profile.name); }}
                >
                  {connected ? 'Disconnect' : 'Connect'}
                </button>
              </div>

              <div className={styles.controls}>
                <label>
                  Peer
                  <select
                    value={route.peerId}
                    onChange={(event) => {
                      const peerId = event.currentTarget.value;
                      const services = peerOptions.find((peer) => peer.peerId === peerId)?.services ?? [];
                      const model = services.includes(route.model) ? route.model : (services[0] ?? '');
                      updateToolRoute(profile.name, { peerId, model }, connected);
                    }}
                    disabled={busy !== null}
                  >
                    {peerOptions.map((peer) => <option key={peer.peerId} value={peer.peerId}>{peer.label}</option>)}
                  </select>
                </label>
                <label>
                  Model
                  <select
                    value={route.model}
                    onChange={(event) => {
                      const model = event.currentTarget.value;
                      updateToolRoute(profile.name, { ...route, model }, connected);
                    }}
                    disabled={busy !== null}
                  >
                    {(peerOptions.find((peer) => peer.peerId === route.peerId)?.services ?? [route.model]).filter(Boolean).map((service) => (
                      <option key={service} value={service}>{service}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={styles.actions}>
                {connected && profile.appAction === 'open-url' && profile.openUrl ? (
                  <button type="button" onClick={() => { void openUrl(profile.openUrl!); }}>Open</button>
                ) : null}
                {connected && profile.appAction === 'open-tool' ? (
                  <button type="button" onClick={() => { void openTool(profile.toolName ?? profile.name); }}>Open</button>
                ) : null}
                {connected && (profile.kind === 'config-patch' || profile.canRestart || profile.appAction === 'restart-app') ? (
                  <button
                    type="button"
                    onClick={() => { void restartApp(profile.name, profile.displayName); }}
                    disabled={actionBusy === profile.name}
                  >
                    {actionBusy === profile.name ? 'Restarting...' : `Restart ${profile.displayName}`}
                  </button>
                ) : null}
                {connected && profile.kind === 'proxy' && guiTest && !guiTest.guiTrustOk && guiTest.proxyReachable ? (
                  <button type="button" onClick={() => { void trustCa(); }} disabled={trustBusy}>
                    {trustBusy ? 'Trusting...' : 'Trust CA'}
                  </button>
                ) : null}
                {profile.kind === 'proxy' ? (
                  <>
                    <button type="button" onClick={() => { void addShellSetup(); }} disabled={actionBusy === 'shell-setup'}>
                      {actionBusy === 'shell-setup' ? 'Updating...' : 'Shell setup'}
                    </button>
                    <button type="button" onClick={() => { void removeShellSetup(); }} disabled={actionBusy === 'shell-remove'}>
                      {actionBusy === 'shell-remove' ? 'Removing...' : 'Remove shell setup'}
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
