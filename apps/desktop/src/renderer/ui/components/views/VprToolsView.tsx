import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowDown01Icon, ArrowLeft01Icon, ArrowReloadHorizontalIcon, ArrowRight01Icon, Copy01Icon, Settings02Icon, SquareLock01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { Modal } from '@antseed/ui';
import type { VprApplicationRouteSelection, VprModelCatalogEntry } from '../../../core/state';
import type { InstalledAppEntry, SystemProxyProfileSummary } from '../../../types/bridge';
import { chooseBestVprRoute, isPeerRoutable } from '../../../modules/routing/select';
import { routesForSelectedModel } from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/catalog/recommended';
import { installedAppsResource, systemProxyResource } from '../../../modules/app/vpr-resources';
import { useCachedResource } from '../../../modules/app/cached-resource';
import {
  activeProfilesFromRuntimeState,
  buildVprPeerOptions,
} from '../../../modules/routing/tools';
import {
  toApplicationRoutePolicies,
  vprApplicationRouteSelectionFor,
} from '../../../modules/routing/application-routes';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { BrandIcon } from '../brand/BrandIcon';
import { VprBadge, VprPage, VprSearch } from '../vpr/VprKit';
import { VprModelRowList } from '../vpr/VprModelRows';
import { TelegramBotCard } from './TelegramBotCard';
import styles from './VprToolsView.module.scss';


const DEFAULT_PORT = 8378;
const APPLICATION_MODEL_MENU_COUNT = 5;

/** Two-pane modal navigation: the main pane slides to the application list
    the same way the app's screens slide ('none' = no animation on open). */
type ModalPane = { pane: 'main' | 'apps'; dir: 'none' | 'forward' | 'back' };

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

function modelApplicationRoute(entry: VprModelCatalogEntry): VprApplicationRouteSelection {
  return {
    mode: 'model',
    model: {
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
      categories: [...entry.categories],
    },
  };
}

function ApplicationRouteChoice({
  title,
  meta,
  description,
  selected,
  disabled,
  onClick,
}: {
  title: string;
  meta: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.routeChoice}${selected ? ` ${styles.routeChoiceSelected}` : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {selected ? <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.routeChoiceCheck} /> : null}
      <span className={styles.routeChoiceText}>
        <span className={styles.routeChoiceTitle}>{title}</span>
        <span className={styles.routeChoiceMeta}>
          <span>{meta}</span>
          {description ? <span>{description}</span> : null}
        </span>
      </span>
    </button>
  );
}

export function VprToolsView() {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    lastPeers: state.lastPeers,
    discoverRows: state.vprRoutableRows,
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    applicationRoutes: state.vprApplicationRoutes,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  const proxyResource = useCachedResource(systemProxyResource);
  const profiles = proxyResource.data?.profiles ?? [];
  const proxyState = proxyResource.data?.state ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  // The app being connected right now. Connecting also restarts an app that
  // was already running, so the row has to stay busy well past the click.
  const [connecting, setConnecting] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [guiTest, setGuiTest] = useState<GuiTestResult | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // Application picked for a new custom app — supplies its display name and
  // icon, replacing the favicon fetch.
  const [addApp, setAddApp] = useState<InstalledAppEntry | null>(null);
  const [addPane, setAddPane] = useState<ModalPane>({ pane: 'main', dir: 'none' });
  const [addSearch, setAddSearch] = useState('');
  // Add-app wizard: 1 = URL + application, 2 = trust the CA, 3 = connect.
  // Step 2 is skipped when the certificate is already trusted.
  const [addStep, setAddStep] = useState<1 | 2 | 3>(1);
  const [addedName, setAddedName] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // The endpoint probe could not confirm the URL is an AI API — the error is
  // shown as a warning and the submit button becomes "Add anyway".
  const [addUnverified, setAddUnverified] = useState(false);
  const [caInfo, setCaInfo] = useState<{ path: string; exists: boolean } | null>(null);
  const [caTrust, setCaTrust] = useState<'trusted' | 'stale' | 'absent' | 'unknown'>('unknown');
  const [caCopied, setCaCopied] = useState(false);
  // Certificate card expansion: the user's explicit toggle wins; until they
  // touch it, the card only opens itself when an action is actually needed.
  const [caOpenOverride, setCaOpenOverride] = useState<boolean | null>(null);
  // "What are connected apps?" explainer modal.
  const [helpOpen, setHelpOpen] = useState(false);
  // Per-app settings modal: which profile it edits, which pane is showing
  // (main settings vs. the application list it slides to), its search text,
  // the client-identity draft, and the lazily fetched installed-apps list.
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [settingsPane, setSettingsPane] = useState<ModalPane>({ pane: 'main', dir: 'none' });
  const [pickerSearch, setPickerSearch] = useState('');
  const [identityDraft, setIdentityDraft] = useState('');
  // Drafted "Open with" pick — undefined until the user touches it, applied
  // together with the identity draft by the modal's Save button.
  const [launchDraft, setLaunchDraft] = useState<InstalledAppEntry | null | undefined>(undefined);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [routeMenuFor, setRouteMenuFor] = useState<string | null>(null);
  const [routeBrowseFor, setRouteBrowseFor] = useState<string | null>(null);
  const [routeBrowseSearch, setRouteBrowseSearch] = useState('');
  const [routeFavorites, setRouteFavorites] = useState(loadFavoriteModels);
  const routeMenuRef = useRef<HTMLDivElement>(null);
  const installedAppsResourceSnapshot = useCachedResource(installedAppsResource, false);
  const installedApps = installedAppsResourceSnapshot.data;
  const installedAppsError = installedAppsResourceSnapshot.error;

  // lastPeers is the raw scan, so it has to be filtered too — otherwise an
  // excluded seller would still be offerable as a per-app route here.
  const peerOptions = useMemo(
    () => buildVprPeerOptions(snap.lastPeers, snap.discoverRows)
      .filter((peer) => isPeerRoutable(peer.peerId, snap.preferences)),
    [snap.lastPeers, snap.discoverRows, snap.preferences],
  );
  const modelRoutes = useMemo(() => routesForSelectedModel(snap.discoverRows, snap.selection.model), [snap.discoverRows, snap.selection.model]);
  const bestRoute = useMemo(() => chooseBestVprRoute(modelRoutes, snap.preferences), [modelRoutes, snap.preferences]);
  const defaultPeerId = snap.selection.peerId || bestRoute?.peerId || peerOptions[0]?.peerId || '';
  const defaultModel = snap.selection.model?.serviceId || peerOptions.find((peer) => peer.peerId === defaultPeerId)?.services[0] || '';
  const activeProfiles = useMemo(() => activeProfilesFromRuntimeState(proxyState), [proxyState]);
  const activeProfileNames = useMemo(() => activeProfiles ? [...activeProfiles] : [], [activeProfiles]);
  const setupProfiles = useMemo(() => {
    const metadata = proxyState as (Record<string, unknown> | null);
    return new Set(Array.isArray(metadata?.setupProfileNames) ? metadata.setupProfileNames.filter((name): name is string => typeof name === 'string') : []);
  }, [proxyState]);
  const hasConnectedProxyProfile = useMemo(() => (
    profiles.some((profile) => profile.kind === 'proxy' && (activeProfiles?.has(profile.name) ?? false))
  ), [activeProfiles, profiles]);

  const hasProxyProfile = useMemo(() => profiles.some((profile) => profile.kind === 'proxy'), [profiles]);

  const routeMenuSelection = routeMenuFor
    ? vprApplicationRouteSelectionFor(snap.applicationRoutes, routeMenuFor)
    : null;
  const routeMenuSelectedEntry = routeMenuSelection?.mode === 'model'
    ? findCatalogEntry(
      snap.catalog,
      routeMenuSelection.model.provider,
      routeMenuSelection.model.serviceId,
    )
    : null;
  const routeMenuEntries = useMemo(() => {
    const favoriteEntries = selectFavoriteVprCatalog(snap.catalog, routeFavorites);
    const recommended = selectRecommendedVprCatalog(snap.catalog)
      .filter((entry) => !routeFavorites.has(catalogEntryKey(entry)));
    const top = [...favoriteEntries, ...recommended].slice(0, APPLICATION_MODEL_MENU_COUNT);
    if (routeMenuSelectedEntry && !top.includes(routeMenuSelectedEntry)) {
      return [routeMenuSelectedEntry, ...top.slice(0, APPLICATION_MODEL_MENU_COUNT - 1)];
    }
    return top;
  }, [routeFavorites, routeMenuSelectedEntry, snap.catalog]);

  const routeBrowseSelection = routeBrowseFor
    ? vprApplicationRouteSelectionFor(snap.applicationRoutes, routeBrowseFor)
    : null;
  const routeBrowseLists = useMemo(() => {
    const query = routeBrowseSearch.trim().toLowerCase();
    const catalog = query
      ? snap.catalog.filter((entry) => (
        entry.label.toLowerCase().includes(query)
        || entry.serviceId.toLowerCase().includes(query)
        || entry.provider.toLowerCase().includes(query)
      ))
      : snap.catalog;
    const favorites = selectFavoriteVprCatalog(catalog, routeFavorites);
    const favoriteKeys = new Set(favorites.map(catalogEntryKey));
    const recommended = selectRecommendedVprCatalog(catalog)
      .filter((entry) => !favoriteKeys.has(catalogEntryKey(entry)));
    const recommendedKeys = new Set(recommended.map(catalogEntryKey));
    const remaining = catalog.filter((entry) => (
      !favoriteKeys.has(catalogEntryKey(entry))
      && !recommendedKeys.has(catalogEntryKey(entry))
    ));
    return { favorites, recommended, remaining };
  }, [routeBrowseSearch, routeFavorites, snap.catalog]);

  const refresh = systemProxyResource.refresh;

  useEffect(() => {
    if (!routeMenuFor) return;
    setRouteFavorites(loadFavoriteModels());
    function closeRouteMenu(event: MouseEvent): void {
      if (routeMenuRef.current && !routeMenuRef.current.contains(event.target as Node)) {
        setRouteMenuFor(null);
      }
    }
    document.addEventListener('mousedown', closeRouteMenu);
    return () => document.removeEventListener('mousedown', closeRouteMenu);
  }, [routeMenuFor]);

  useEffect(() => {
    if (routeBrowseFor) setRouteFavorites(loadFavoriteModels());
  }, [routeBrowseFor]);

  // Trust state shells out to the CLI (which queries the OS keychain), so it is
  // fetched on demand — mount, after adding an app, after trusting — never on
  // the 3s poll above.
  const refreshCaTrust = useCallback(async (): Promise<'trusted' | 'stale' | 'absent' | 'unknown'> => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyCaTrustState) return 'unknown';
    try {
      const result = await bridge.systemProxyCaTrustState();
      const trust = result.ok ? result.trust : 'unknown';
      setCaTrust(trust);
      return trust;
    } catch {
      setCaTrust('unknown');
      return 'unknown';
    }
  }, []);

  useEffect(() => {
    void refreshCaTrust();
    void window.antseedDesktop?.systemProxyCaInfo?.().then(setCaInfo);
  }, [refreshCaTrust]);

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

  const startProfiles = useCallback(async (names: string[]): Promise<boolean> => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyStart || !defaultPeerId) return false;
    setBusy(names.join(','));
    setMessage(null);
    const result = await bridge.systemProxyStart({
      peerId: defaultPeerId,
      port: DEFAULT_PORT,
      profiles: names,
      defaultModel: defaultModel || undefined,
      servedModels: peerOptions.find((peer) => peer.peerId === defaultPeerId)?.services ?? [],
      applicationRoutes: toApplicationRoutePolicies(snap.applicationRoutes),
      profileSwitch: proxyState?.running === true || activeProfileNames.length > 0,
    });
    setBusy(null);
    if (!result.ok) {
      setMessage(result.error ?? 'Unable to connect tool profile');
      return false;
    }
    systemProxyResource.setData({ profiles, state: result.state ?? null });
    return true;
  }, [activeProfileNames.length, defaultModel, defaultPeerId, peerOptions, profiles, proxyState?.running, snap.applicationRoutes]);

  const setApplicationRoute = useCallback(async (
    profileName: string,
    selection: VprApplicationRouteSelection,
  ): Promise<void> => {
    setRouteMenuFor(null);
    setRouteBrowseFor(null);
    setRouteBrowseSearch('');
    setMessage(null);
    const result = await actions.setVprApplicationRoute(profileName, selection);
    if (!result.ok) {
      setMessage(result.error ?? 'Unable to update application model');
      return;
    }
    await systemProxyResource.refresh();
  }, [actions]);

  const disconnect = useCallback(async () => {
    const bridge = window.antseedDesktop;
    setBusy('stop');
    const result = await bridge?.systemProxyStop?.();
    setBusy(null);
    if (result?.ok) {
      systemProxyResource.setData({ profiles, state: result.state ?? null });
    } else {
      setMessage(result?.error ?? 'Unable to disconnect tools');
    }
  }, [profiles]);

  const openUrl = useCallback(async (url: string) => {
    const result = await window.antseedDesktop?.openExternalUrl?.(url);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const openTool = useCallback(async (toolName: string) => {
    const result = await window.antseedDesktop?.openTool?.(toolName);
    if (result && !result.ok) setMessage(result.error ?? 'Could not open tool');
  }, []);

  const connectProfile = useCallback(async (profileName: string) => {
    const names = Array.from(new Set([...activeProfileNames, profileName]));
    setConnecting(profileName);
    try {
      if (!await startProfiles(names)) return;
      // Surface the pill right away — it opens with the chat dropdown
      // expanded, so the "start a new session" guidance is in view while
      // the user switches to the tool.
      void actions.openVprFloat?.(profileName);
      // Bring the app itself forward too — same launch rules as the row's
      // open arrow: a user-picked application wins over the packaged
      // open-url action. Awaited, so the row stays busy until the app is
      // actually up rather than until the launch request is accepted.
      const profile = profiles.find((entry) => entry.name === profileName);
      if (!profile) return;
      if (profile.appAction === 'open-url' && profile.openUrl && !profile.launchAppName) {
        await openUrl(profile.openUrl);
      } else if (profile.launchAppName || profile.appAction === 'open-tool') {
        await openTool(profile.toolName ?? profile.name);
      }
    } finally {
      setConnecting(null);
    }
  }, [actions, activeProfileNames, openTool, openUrl, profiles, startProfiles]);

  const disconnectProfile = useCallback((profileName: string) => {
    const remaining = activeProfileNames.filter((name) => name !== profileName);
    if (remaining.length === 0) {
      void disconnect();
      return;
    }
    void startProfiles(remaining);
  }, [activeProfileNames, disconnect, startProfiles]);

  const restartApp = useCallback(async (profileName: string, label: string) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyRestartApp) return;
    setActionBusy(profileName);
    setMessage(null);
    try {
      const result = await bridge.systemProxyRestartApp(profileName);
      setMessage(result.ok ? `Restarted ${label}` : (result.error ?? `Unable to restart ${label}`));
      if (result.ok) await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(null);
    }
  }, [refresh]);

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
      const trust = await refreshCaTrust();
      await testGui();
      // The CLI's login-keychain fallback reports "system-wide trust was
      // skipped" even when the cert ends up trusted for this user — which is
      // all intercepted GUI apps need. Only surface the warning when the
      // keychain still doesn't verify the cert as trusted.
      if (result.warning && trust !== 'trusted') setMessage(result.warning);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTrustBusy(false);
    }
  }, [refreshCaTrust, testGui]);

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

  // ---------- Per-app settings modal ----------

  const ensureInstalledApps = useCallback(() => {
    if (installedApps === null && !installedAppsResourceSnapshot.loading) {
      void installedAppsResource.refresh();
    }
  }, [installedApps, installedAppsResourceSnapshot.loading]);

  const openSettings = useCallback((profile: SystemProxyProfileSummary) => {
    setSettingsFor(profile.name);
    setSettingsPane({ pane: 'main', dir: 'none' });
    setPickerSearch('');
    setIdentityDraft((profile.toolSlugs?.length ? profile.toolSlugs : [profile.name]).join(', '));
    setLaunchDraft(undefined);
    ensureInstalledApps();
  }, [ensureInstalledApps]);

  // Picking an application only stages a draft — it applies on Save.
  const chooseApp = useCallback((app: InstalledAppEntry | null) => {
    setLaunchDraft(app);
    setSettingsPane({ pane: 'main', dir: 'back' });
  }, []);

  const settingsProfile = settingsFor ? profiles.find((profile) => profile.name === settingsFor) ?? null : null;
  const settingsIdentity = settingsProfile
    ? (settingsProfile.toolSlugs?.length ? settingsProfile.toolSlugs : [settingsProfile.name]).join(', ')
    : '';
  const identityDirty = settingsProfile !== null && identityDraft.trim() !== settingsIdentity;
  const launchDirty = settingsProfile !== null && launchDraft !== undefined
    && (launchDraft?.name ?? null) !== (settingsProfile.launchAppName ?? null);
  const settingsDirty = identityDirty || launchDirty;
  // The drafted pick wins over the persisted one for everything the modal shows.
  const settingsLaunchName = launchDraft === undefined
    ? settingsProfile?.launchAppName ?? null
    : launchDraft?.name ?? null;

  // Apply the drafted settings. A connected app disconnects first — the proxy
  // runtime only reads profiles on connect, so edits never apply mid-session;
  // reconnecting stays on the apps list row.
  const saveSettings = useCallback(async () => {
    const bridge = window.antseedDesktop;
    if (!settingsFor || !bridge) return;
    setSettingsSaving(true);
    setMessage(null);
    try {
      if (activeProfileNames.includes(settingsFor)) {
        const remaining = activeProfileNames.filter((name) => name !== settingsFor);
        if (remaining.length === 0) await disconnect();
        else if (!await startProfiles(remaining)) return;
      }
      if (launchDirty && bridge.systemProxySetAppLaunch) {
        const result = await bridge.systemProxySetAppLaunch({
          name: settingsFor,
          app: launchDraft ? { name: launchDraft.name, path: launchDraft.path } : null,
        });
        if (!result.ok) {
          setMessage(result.error ?? 'Could not save the app setting');
          return;
        }
      }
      if (identityDirty && bridge.systemProxySetAppIdentity) {
        const slugs = identityDraft.split(',').map((entry) => entry.trim()).filter(Boolean);
        const result = await bridge.systemProxySetAppIdentity({ name: settingsFor, toolSlugs: slugs.length > 0 ? slugs : null });
        if (!result.ok) {
          setMessage(result.error ?? 'Could not save the client names');
          return;
        }
      }
      // Sync drafts to the normalized values the main process persisted —
      // including a custom app renamed after its application pick.
      const listed = (await bridge.systemProxyListProfiles?.()) ?? [];
      systemProxyResource.setData({ profiles: listed, state: proxyState });
      setLaunchDraft(undefined);
      const updated = listed.find((profile) => profile.name === settingsFor);
      if (updated) setIdentityDraft((updated.toolSlugs?.length ? updated.toolSlugs : [updated.name]).join(', '));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }, [activeProfileNames, disconnect, identityDirty, identityDraft, launchDirty, launchDraft, proxyState, settingsFor, startProfiles]);

  const advanceAddStep = useCallback((step: 2 | 3) => {
    setAddStep(step);
    setAddPane({ pane: 'main', dir: 'forward' });
  }, []);

  const addCustomApp = useCallback(async (force = false) => {
    const bridge = window.antseedDesktop;
    if (!bridge?.systemProxyAddCustomApp) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const result = await bridge.systemProxyAddCustomApp({
        apiUrl: addUrl,
        app: addApp ? { name: addApp.name, path: addApp.path } : null,
        force,
      });
      if (!result.ok) {
        setAddUnverified(result.unverified === true);
        setAddError(result.error ?? 'Unable to add custom app');
        return;
      }
      setAddUnverified(false);
      setAddedName(result.name ?? null);
      await refresh();
      // Intercepting a custom app's HTTPS needs the local CA trusted, so the
      // trust step comes next — skipped when the CA is already trusted.
      const trust = await refreshCaTrust();
      advanceAddStep(trust === 'trusted' ? 3 : 2);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }, [addApp, addUrl, advanceAddStep, refresh, refreshCaTrust]);

  // Wizard variant of Trust: advance to the connect step once the keychain
  // confirms the CA is trusted (trustCa surfaces its own errors via message).
  const trustCaFromWizard = useCallback(async () => {
    await trustCa();
    const trust = await refreshCaTrust();
    if (trust === 'trusted') advanceAddStep(3);
  }, [advanceAddStep, refreshCaTrust, trustCa]);

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

  const telegramVisible = !search.trim() || 'telegram bot'.includes(search.trim().toLowerCase());

  // Certificate trust presentation. A live probe failure (certTrustError) or a
  // stale/absent keychain state all mean the same thing to the user: press
  // Trust. `stale` is the CERT_SIGNATURE_FAILURE case — an older CA trusted
  // under the same name that re-trusting will replace.
  const certNeedsTrust = guiTest?.certTrustError === true || caTrust === 'stale' || caTrust === 'absent';
  const certBadgeLabel = guiTest?.certTrustError ? 'Not trusted'
    : caTrust === 'trusted' ? 'Trusted'
    : caTrust === 'stale' ? 'Update needed'
    : caTrust === 'absent' ? 'Not trusted'
    : caInfo?.exists ? 'Installed' : 'Not created yet';
  const certBadgeTone: 'green' | 'neutral' = certNeedsTrust
    ? 'neutral'
    : caTrust === 'trusted' || caInfo?.exists ? 'green' : 'neutral';

  return (
    <section className={`view view-vpr-tools view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Connected apps" backFallback="home">
      <div className={styles.stack}>

        <VprSearch value={search} onChange={setSearch} placeholder="Search app" />

        {message ? <p className={styles.note} role="status">{message}</p> : null}

        {visibleProfiles.length === 0 && !telegramVisible ? (
          <div className={styles.empty}>{profiles.length === 0 ? 'No tool profiles configured' : 'No apps match your search'}</div>
        ) : (
          <div className={styles.appList}>
            {telegramVisible ? <TelegramBotCard /> : null}
            {visibleProfiles.map((profile) => {
              const connected = activeProfiles?.has(profile.name) ?? false;
              const setupComplete = setupProfiles.has(profile.name);
              const canRestart = connected && profile.canRestart === true;
              const applicationRoute = vprApplicationRouteSelectionFor(snap.applicationRoutes, profile.name);
               const applicationModel = applicationRoute.mode === 'model'
                 ? findCatalogEntry(snap.catalog, applicationRoute.model.provider, applicationRoute.model.serviceId)
                 : null;
               const defaultApplicationModel = snap.selection.model
                 ? findCatalogEntry(snap.catalog, snap.selection.model.provider, snap.selection.model.serviceId)
                 : null;
               const applicationRouteTitle = applicationRoute.mode === 'client-model'
                 ? 'In-app selection'
                 : applicationRoute.mode === 'follow-global'
                   ? defaultApplicationModel?.label ?? snap.selection.model?.label ?? 'Select model'
                   : applicationModel?.label ?? applicationRoute.model.label;
               const applicationRouteMeta = applicationRoute.mode === 'client-model'
                 ? profile.displayName
                 : applicationRoute.mode === 'model' && !applicationModel ? 'Unavailable' : 'Best';
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
                          {/* The name itself launches the associated app when
                              one is available — no separate app link line. */}
                          {profile.launchAppName || profile.appAction === 'open-url' || profile.appAction === 'open-tool' ? (
                            <button
                              type="button"
                              className={styles.appNameLink}
                              onClick={() => {
                                void (profile.appAction === 'open-url' && profile.openUrl && !profile.launchAppName
                                  ? openUrl(profile.openUrl)
                                  : openTool(profile.toolName ?? profile.name));
                              }}
                              title={`Open ${profile.launchAppName ?? profile.displayName}`}
                            >
                              {profile.displayName}
                            </button>
                          ) : (
                            <span className={styles.appName}>{profile.displayName}</span>
                          )}
                        </span>
                        {connected && (
                          <span className={`${styles.appMeta}${profile.needsRestart ? ` ${styles.appMetaWarning}` : ''}`}>
                            <span className={profile.needsRestart ? styles.restartDot : styles.connectedDot} aria-hidden="true" />
                            {profile.needsRestart ? 'Restart required' : 'Connected'}
                          </span>
                        )}
                      </span>
                    </span>
                    {connecting === profile.name ? (
                      <span
                        className={styles.appBusy}
                        role="status"
                        aria-label={`Connecting ${profile.displayName}`}
                        title={`Connecting ${profile.displayName}`}
                      />
                    ) : canRestart ? (
                      <button
                        type="button"
                        className={`${styles.appOpen}${profile.needsRestart ? ` ${styles.appRestartNeeded}` : ''}`}
                        onClick={() => { void restartApp(profile.name, profile.displayName); }}
                        disabled={actionBusy === profile.name}
                        aria-label={`Restart ${profile.displayName}`}
                        title={profile.needsRestart ? `Restart ${profile.displayName} to apply the connection` : `Restart ${profile.displayName}`}
                      >
                        <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} strokeWidth={2} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`${styles.configAction}${settingsFor === profile.name ? ` ${styles.configActionActive}` : ''}`}
                      onClick={() => openSettings(profile)}
                      aria-haspopup="dialog"
                      aria-label={`${profile.displayName} settings`}
                      title={`${profile.displayName} settings`}
                    >
                      <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
                    </button>
                    {connected || setupComplete ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={connected}
                        className={`${styles.connectedToggle}${connected ? '' : ` ${styles.connectedToggleOff}`}`}
                        disabled={busy !== null || (!connected && !defaultPeerId)}
                        onClick={() => {
                          if (connected) disconnectProfile(profile.name);
                          else void connectProfile(profile.name);
                        }}
                        aria-label={`${connected ? 'Disconnect' : 'Connect'} ${profile.displayName}`}
                        title={`${connected ? 'Disconnect' : 'Connect'} ${profile.displayName}`}
                      >
                        <span />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.connectAction}
                        disabled={busy !== null || !defaultPeerId}
                        onClick={() => { void connectProfile(profile.name); }}
                      >
                        Connect
                      </button>
                    )}
                  </div>

                  {connected ? (
                    <div
                      className={styles.applicationRouteControl}
                      ref={routeMenuFor === profile.name ? routeMenuRef : undefined}
                    >
                      <button
                        type="button"
                        className={styles.applicationRouteButton}
                        onClick={() => setRouteMenuFor((open) => open === profile.name ? null : profile.name)}
                        aria-haspopup="listbox"
                        aria-expanded={routeMenuFor === profile.name}
                        title="Change model for new chats"
                      >
                        <span className={styles.applicationRouteTitle}>
                          {applicationRoute.mode === 'model' ? (
                            <BrandIcon
                              name={applicationRoute.model.provider}
                              hints={[applicationRoute.model.label]}
                              size={16}
                            />
                          ) : null}
                          <span>{applicationRouteTitle}</span>
                        </span>
                        <span className={styles.applicationRouteMeta}>{applicationRouteMeta}</span>
                        <HugeiconsIcon
                          icon={ArrowDown01Icon}
                          size={16}
                          strokeWidth={2}
                          className={`${styles.applicationRouteChevron}${routeMenuFor === profile.name ? ` ${styles.applicationRouteChevronOpen}` : ''}`}
                        />
                      </button>
                      <span className={styles.applicationRouteHint}>Model changes apply to new chats.</span>

                      {routeMenuFor === profile.name && routeMenuSelection ? (
                        <div className={styles.applicationRouteMenu} role="listbox">
                          {profile.name === 'codex' || profile.name === 'opencode' ? (
                            <ApplicationRouteChoice
                              title="In-app selection"
                              meta={profile.displayName}
                              description={`Use model selected in ${profile.displayName}`}
                              selected={routeMenuSelection.mode === 'client-model'}
                              onClick={() => { void setApplicationRoute(profile.name, { mode: 'client-model' }); }}
                            />
                          ) : null}
                          {routeMenuSelection.mode === 'model' && !routeMenuSelectedEntry ? (
                            <ApplicationRouteChoice
                              title={routeMenuSelection.model.label}
                              meta="Unavailable"
                              selected
                              disabled
                              onClick={() => undefined}
                            />
                          ) : null}
                          <VprModelRowList
                            entries={routeMenuEntries}
                            selectedProvider={routeMenuSelection.mode === 'model' ? routeMenuSelection.model.provider : undefined}
                            selectedServiceId={routeMenuSelection.mode === 'model' ? routeMenuSelection.model.serviceId : undefined}
                            favoriteKeys={routeFavorites}
                            routingLabel="Best"
                            selectOnly
                            frameless
                            onSelect={(provider, serviceId) => {
                              const entry = findCatalogEntry(snap.catalog, provider, serviceId);
                              if (entry) void setApplicationRoute(profile.name, modelApplicationRoute(entry));
                            }}
                            emptyLabel="No models discovered yet"
                          />
                          <button
                            type="button"
                            className={styles.applicationRouteMenuFooter}
                            onClick={() => {
                              setRouteMenuFor(null);
                              setRouteBrowseFor(profile.name);
                              setRouteBrowseSearch('');
                            }}
                          >
                            <span>All models</span>
                            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className={styles.addAppButton}
          onClick={() => {
            setAddOpen(true);
            setAddUrl('');
            setAddApp(null);
            setAddPane({ pane: 'main', dir: 'none' });
            setAddSearch('');
            setAddStep(1);
            setAddedName(null);
            setAddError(null);
            setAddUnverified(false);
            setMessage(null);
            ensureInstalledApps();
          }}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
          Add custom app
        </button>

        {/* The certificate only matters for intercepted (mitm proxy) apps —
            keep the card hidden until one is connected, or one exists and
            the cert still needs trusting to let it connect. */}
        {caInfo && (hasConnectedProxyProfile || (hasProxyProfile && certNeedsTrust)) ? (() => {
          const caExpanded = caOpenOverride ?? certNeedsTrust;
          return (
            <div className={styles.caCard}>
              <button
                type="button"
                className={styles.caHead}
                aria-expanded={caExpanded}
                onClick={() => setCaOpenOverride(!caExpanded)}
              >
                <HugeiconsIcon icon={SquareLock01Icon} size={14} strokeWidth={2} />
                <span className={styles.caTitle}>HTTPS certificate</span>
                <VprBadge tone={certBadgeTone}>{certBadgeLabel}</VprBadge>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={14}
                  strokeWidth={2}
                  className={`${styles.caChevron}${caExpanded ? ` ${styles.caChevronOpen}` : ''}`}
                />
              </button>
              {caExpanded ? (
                <>
                  <p className={styles.caHint}>
                    {caTrust === 'stale'
                      ? 'An older AntSeed certificate is still trusted on this device — trust the current one to replace it, otherwise intercepted apps fail with an SSL certificate error.'
                      : 'Apps whose HTTPS traffic is intercepted trust a certificate generated locally on this device. It never leaves your machine — inspect it any time.'}
                  </p>
                  <button type="button" className={styles.caPath} onClick={() => { void copyCaPath(); }} title={caInfo.path}>
                    <code>{caInfo.path}</code>
                    <HugeiconsIcon icon={caCopied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={2} />
                    <span>{caCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                  {caInfo.exists || certNeedsTrust ? (
                    <div className={styles.actions}>
                      {caInfo.exists ? (
                        <button type="button" onClick={() => { void revealCa(); }}>Reveal certificate</button>
                      ) : null}
                      {certNeedsTrust ? (
                        <button type="button" onClick={() => { void trustCa(); }} disabled={trustBusy}>
                          {trustBusy ? 'Trusting...' : 'Trust certificate'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })() : null}

        <button type="button" className={styles.learnMore} onClick={() => setHelpOpen(true)}>
          What are connected apps?
        </button>
      </div>
      </VprPage>

      <Modal
        isOpen={routeBrowseFor !== null}
        onClose={() => {
          setRouteBrowseFor(null);
          setRouteBrowseSearch('');
        }}
        size="sm"
        className={styles.vprModal}
        title={routeBrowseFor
          ? `${profiles.find((profile) => profile.name === routeBrowseFor)?.displayName ?? 'Application'} model`
          : 'Application model'}
        subtitle="Choose any model currently available in VPR. Seller routing stays on Best."
      >
        {routeBrowseFor && routeBrowseSelection ? (
          <div className={styles.routeBrowseBody}>
            <VprSearch
              value={routeBrowseSearch}
              onChange={setRouteBrowseSearch}
              placeholder="Search models"
            />
            {routeBrowseLists.favorites.length > 0 ? (
              <section className={styles.routeBrowseSection}>
                <div className={styles.routeBrowseTitle}>Favorites</div>
                <VprModelRowList
                  entries={routeBrowseLists.favorites}
                  selectedProvider={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.provider : undefined}
                  selectedServiceId={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.serviceId : undefined}
                  favoriteKeys={routeFavorites}
                  routingLabel="Best"
                  selectOnly
                  onSelect={(provider, serviceId) => {
                    const entry = findCatalogEntry(snap.catalog, provider, serviceId);
                    if (entry) void setApplicationRoute(routeBrowseFor, modelApplicationRoute(entry));
                  }}
                  emptyLabel="No favorite models"
                />
              </section>
            ) : null}
            {routeBrowseLists.recommended.length > 0 ? (
              <section className={styles.routeBrowseSection}>
                <div className={styles.routeBrowseTitle}>Recommended</div>
                <VprModelRowList
                  entries={routeBrowseLists.recommended}
                  selectedProvider={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.provider : undefined}
                  selectedServiceId={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.serviceId : undefined}
                  favoriteKeys={routeFavorites}
                  routingLabel="Best"
                  selectOnly
                  onSelect={(provider, serviceId) => {
                    const entry = findCatalogEntry(snap.catalog, provider, serviceId);
                    if (entry) void setApplicationRoute(routeBrowseFor, modelApplicationRoute(entry));
                  }}
                  emptyLabel="No recommended models"
                />
              </section>
            ) : null}
            {routeBrowseLists.remaining.length > 0 ? (
              <section className={styles.routeBrowseSection}>
                <div className={styles.routeBrowseTitle}>All models</div>
                <VprModelRowList
                  entries={routeBrowseLists.remaining}
                  selectedProvider={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.provider : undefined}
                  selectedServiceId={routeBrowseSelection.mode === 'model' ? routeBrowseSelection.model.serviceId : undefined}
                  favoriteKeys={routeFavorites}
                  routingLabel="Best"
                  selectOnly
                  onSelect={(provider, serviceId) => {
                    const entry = findCatalogEntry(snap.catalog, provider, serviceId);
                    if (entry) void setApplicationRoute(routeBrowseFor, modelApplicationRoute(entry));
                  }}
                  emptyLabel="No models"
                />
              </section>
            ) : null}
            {routeBrowseLists.favorites.length === 0
              && routeBrowseLists.recommended.length === 0
              && routeBrowseLists.remaining.length === 0 ? (
                <div className={styles.empty}>No models match your search.</div>
              ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Connected-apps explainer. */}
      <Modal
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        size="sm"
        title="Connected apps"
        subtitle="How VPR works with your tools"
        className={styles.vprModal}
        bodyClassName={styles.settingsBody}
      >
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>What connecting does</span>
          </div>
          <p className={styles.settingHint}>
            Connecting an app routes its AI requests through VPR. The app works exactly
            as usual — its model calls are served by the AntSeed network and paid from
            your balance instead of a subscription or API key. Click an app&apos;s name
            any time to open it.
          </p>
        </section>
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>How apps connect</span>
          </div>
          <p className={styles.settingHint}>
            Most tools are pointed at VPR through a small change to their own config
            file — written locally on Connect and removed again on Disconnect (a backup
            of the original is kept next to it). Apps marked HTTPS proxy are instead
            intercepted on this device, which needs the locally generated certificate
            below to be trusted. After connecting, start a new session in the tool so
            it picks up the routing.
          </p>
        </section>
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>Models and chats</span>
          </div>
          <p className={styles.settingHint}>
            Each connected app uses its own selected model. Codex and OpenCode can use
            In-app selection to keep the model selected inside the app. Changes apply to new
            chats; existing chats keep the route assigned to their first request.
          </p>
        </section>
        <section className={styles.settingSection}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>Custom apps and settings</span>
          </div>
          <p className={styles.settingHint}>
            Add any other app by the API URL it calls — its requests are redirected to
            VPR on this device (localhost). Each app&apos;s gear opens its settings:
            the application to open, the client names that attribute its chats, and
            Disconnect or Remove.
          </p>
        </section>
      </Modal>

      {/* Per-app settings: application to open and request-identity client
          names, edited as drafts and applied by the footer Save (which
          disconnects a connected app first), plus Disconnect / Remove. */}
      <Modal
        isOpen={settingsProfile !== null}
        onClose={() => setSettingsFor(null)}
        size="sm"
        title={settingsPane.pane === 'apps' ? (
          <span className={styles.modalBackTitle}>
            <button
              type="button"
              className={styles.paneBackButton}
              onClick={() => setSettingsPane({ pane: 'main', dir: 'back' })}
              aria-label="Back"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={2} />
            </button>
            Choose application
          </span>
        ) : (settingsProfile?.displayName ?? 'App settings')}
        subtitle={settingsPane.pane === 'apps'
          ? undefined
          : (settingsProfile?.custom ? settingsProfile.domains[0] : 'App settings')}
        className={styles.vprModal}
        bodyClassName={styles.settingsBody}
      >
        {settingsProfile ? (() => {
          const connected = activeProfiles?.has(settingsProfile.name) ?? false;
          return (
            <div key={settingsPane.pane} className={`${styles.pane}${settingsPane.dir === 'forward' ? ` ${styles.paneForward}` : settingsPane.dir === 'back' ? ` ${styles.paneBack}` : ''}`}>
              {settingsPane.pane === 'apps' ? (
                <AppPickerPane
                  apps={installedApps}
                  error={installedAppsError}
                  search={pickerSearch}
                  onSearch={setPickerSearch}
                  activeName={settingsLaunchName}
                  onChoose={chooseApp}
                  noneLabel={settingsProfile.custom ? 'No application' : 'Default action'}
                  noneMeta={settingsProfile.custom
                    ? 'No application associated with this app'
                    : 'Use the app’s built-in open behavior'}
                />
              ) : (
                <>
                  <section className={styles.settingSection}>
                    <div className={styles.settingHead}>
                      <span className={styles.settingTitle}>Connection</span>
                      {connected ? (
                        <span className={styles.settingConnected}>
                          <span className={styles.connectedDot} aria-hidden="true" />
                          Connected
                        </span>
                      ) : null}
                    </div>
                    <p className={styles.settingHint}>
                      {connected
                        ? `${settingsProfile.displayName}'s AI requests currently route through VPR. Disconnecting restores its direct connection.${settingsDirty ? ' Saving these changes disconnects it first — reconnect from the apps list.' : ''}`
                        : `Connect from the apps list to route ${settingsProfile.displayName}'s AI requests through VPR — served by the AntSeed network and paid from your balance.`}
                    </p>
                  </section>

                  <section className={styles.settingSection}>
                    <div className={styles.settingHead}>
                      <span className={styles.settingTitle}>Application</span>
                    </div>
                    <p className={styles.settingHint}>
                      The installed application VPR launches for {settingsProfile.displayName} —
                       used by the restart button and when jumping back into a chat session.
                    </p>
                    <button
                      type="button"
                      className={styles.settingValueRow}
                      onClick={() => setSettingsPane({ pane: 'apps', dir: 'forward' })}
                    >
                      {settingsProfile.iconDataUri
                        ? <img src={settingsProfile.iconDataUri} alt="" className={styles.pickerIcon} />
                        : <BrandIcon name={settingsProfile.name} hints={[settingsProfile.displayName]} size={20} />}
                      <span className={styles.settingValueName}>
                        {settingsLaunchName
                          ?? (settingsProfile.custom ? 'No application' : 'Default action')}
                      </span>
                      <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.settingValueChevron} />
                    </button>
                  </section>

                  <section className={styles.settingSection}>
                    <div className={styles.settingHead}>
                      <span className={styles.settingTitle}>Request identity</span>
                    </div>
                    <p className={styles.settingHint}>
                      VPR matches requests to {settingsProfile.displayName} by the client name they
                      carry on the wire — the User-Agent product or session header, like{' '}
                      <code>opencode</code> or <code>codex</code>. Separate multiple names with commas.
                    </p>
                    <form
                      className={styles.settingInputRow}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveSettings();
                      }}
                    >
                      <input
                        type="text"
                        className={styles.settingInput}
                        value={identityDraft}
                        placeholder={settingsProfile.name}
                        spellCheck={false}
                        onChange={(event) => setIdentityDraft(event.currentTarget.value)}
                        disabled={settingsSaving}
                      />
                    </form>
                  </section>

                  {settingsProfile.custom ? (
                    <section className={styles.settingSection}>
                      <div className={styles.settingHead}>
                        <span className={styles.settingTitle}>Remove</span>
                      </div>
                      <p className={styles.settingHint}>
                        Removes {settingsProfile.displayName} from VPR — its requests go directly
                        to {settingsProfile.domains[0] ?? 'the API'} again.
                      </p>
                      <div className={styles.settingActions}>
                        <button
                          type="button"
                          className={styles.settingDanger}
                          disabled={actionBusy === settingsProfile.name || busy !== null}
                          onClick={() => {
                            if (window.confirm(`Remove ${settingsProfile.displayName}? Its requests will no longer route through VPR.`)) {
                              setSettingsFor(null);
                              void removeCustomApp(settingsProfile.name, connected);
                            }
                          }}
                        >
                          Remove app
                        </button>
                      </div>
                    </section>
                  ) : null}

                  {/* Connect lives on the apps list row — the footer only
                      saves drafted changes or disconnects a connected app. */}
                  <div className={styles.settingFooter}>
                    {settingsDirty ? (
                      <button
                        type="button"
                        className={styles.settingPrimary}
                        disabled={settingsSaving || busy !== null}
                        onClick={() => void saveSettings()}
                      >
                        {settingsSaving ? 'Saving...' : 'Save'}
                      </button>
                    ) : connected ? (
                      <button
                        type="button"
                        className={styles.settingDanger}
                        disabled={busy !== null}
                        onClick={() => disconnectProfile(settingsProfile.name)}
                      >
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          );
        })() : null}
      </Modal>

      {/* Add custom app: a 3-step wizard — the API URL to intercept plus an
          optional installed application, then trusting the local CA (skipped
          when already trusted), then connecting the new app. */}
      <Modal
        isOpen={addOpen}
        onClose={() => { if (!addBusy) setAddOpen(false); }}
        size="sm"
        title={addPane.pane === 'apps' ? (
          <span className={styles.modalBackTitle}>
            <button
              type="button"
              className={styles.paneBackButton}
              onClick={() => setAddPane({ pane: 'main', dir: 'back' })}
              aria-label="Back"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={2} />
            </button>
            Choose application
          </span>
        ) : 'Add custom app'}
        subtitle={addPane.pane === 'apps' ? undefined
          : addStep === 1 ? 'Route another app through VPR'
          : addStep === 2 ? 'Trust the HTTPS certificate'
          : 'Connect the app'}
        className={styles.vprModal}
        bodyClassName={styles.settingsBody}
      >
        {addPane.pane !== 'apps' ? (
          <div className={styles.wizardSteps} aria-hidden="true">
            {(['Add', 'Trust', 'Connect'] as const).map((label, index) => {
              const step = index + 1;
              const state = addStep === step ? styles.wizardStepActive : addStep > step ? styles.wizardStepDone : '';
              return (
                <span key={label} className={`${styles.wizardStep}${state ? ` ${state}` : ''}`}>
                  <span className={styles.wizardStepNum}>
                    {addStep > step ? <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.4} /> : step}
                  </span>
                  {label}
                </span>
              );
            })}
          </div>
        ) : null}
        <div key={`${addPane.pane}-${addStep}`} className={`${styles.pane}${addPane.dir === 'forward' ? ` ${styles.paneForward}` : addPane.dir === 'back' ? ` ${styles.paneBack}` : ''}`}>
          {addPane.pane === 'apps' ? (
            <AppPickerPane
              apps={installedApps}
              error={installedAppsError}
              search={addSearch}
              onSearch={setAddSearch}
              activeName={addApp?.name ?? null}
              onChoose={(app) => {
                setAddApp(app);
                setAddPane({ pane: 'main', dir: 'back' });
              }}
              noneLabel="No application"
              noneMeta="Use the API host's name and icon"
            />
          ) : addStep === 1 ? (
            <form
              className={styles.settingsBody}
              onSubmit={(event) => {
                event.preventDefault();
                void addCustomApp(addUnverified);
              }}
            >
              <section className={styles.settingSection}>
                <div className={styles.settingHead}>
                  <span className={styles.settingTitle}>API URL</span>
                  <span className={styles.settingTag}>Required</span>
                </div>
                <p className={styles.settingHint}>
                  AI requests the app sends to this URL are redirected to VPR on this
                  device (localhost) and served by the AntSeed network instead.
                </p>
                <input
                  type="text"
                  className={styles.settingInput}
                  value={addUrl}
                  placeholder="https://api.example.com/v1"
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => {
                    setAddUrl(event.currentTarget.value);
                    // A changed URL invalidates the previous probe result.
                    setAddUnverified(false);
                  }}
                  disabled={addBusy}
                />
              </section>

              <section className={styles.settingSection}>
                <div className={styles.settingHead}>
                  <span className={styles.settingTitle}>Application</span>
                  <span className={styles.settingTag}>Optional</span>
                </div>
                <p className={styles.settingHint}>
                  Pick the installed application that talks to this API — its name and icon
                  identify the new entry, and the open arrow launches it.
                </p>
                <button
                  type="button"
                  className={styles.settingValueRow}
                  onClick={() => setAddPane({ pane: 'apps', dir: 'forward' })}
                >
                  {addApp?.iconDataUri
                    ? <img src={addApp.iconDataUri} alt="" className={styles.pickerIcon} />
                    : null}
                  <span className={styles.settingValueName}>{addApp?.name ?? 'No application'}</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} className={styles.settingValueChevron} />
                </button>
              </section>

              {addError ? <p className={styles.note} role="alert">{addError}</p> : null}

              <div className={styles.wizardFooter}>
                <button
                  type="button"
                  className={styles.settingQuiet}
                  onClick={() => setAddOpen(false)}
                  disabled={addBusy}
                >
                  Cancel
                </button>
                <button type="submit" className={styles.settingPrimary} disabled={addBusy || addUrl.trim().length === 0}>
                  {addBusy ? (addUnverified ? 'Adding...' : 'Checking...') : addUnverified ? 'Add anyway' : 'Continue'}
                </button>
              </div>
            </form>
          ) : addStep === 2 ? (
            <>
              <section className={styles.settingSection}>
                <div className={styles.settingHead}>
                  <span className={styles.settingTitle}>HTTPS certificate</span>
                  <VprBadge tone={certBadgeTone}>{certBadgeLabel}</VprBadge>
                </div>
                <p className={styles.settingHint}>
                  {caTrust === 'stale'
                    ? 'An older AntSeed certificate is still trusted on this device — trust the current one to replace it, otherwise the app fails with an SSL certificate error.'
                    : 'Custom apps connect over HTTPS intercepted on this device, which needs the certificate generated locally by AntSeed to be trusted. It never leaves your machine.'}
                </p>
                {caInfo?.path ? (
                  <button type="button" className={styles.caPath} onClick={() => { void copyCaPath(); }} title={caInfo.path}>
                    <code>{caInfo.path}</code>
                    <HugeiconsIcon icon={caCopied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={2} />
                    <span>{caCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                ) : null}
              </section>

              {message ? <p className={styles.note} role="status">{message}</p> : null}

              <div className={styles.wizardFooter}>
                <button
                  type="button"
                  className={styles.settingQuiet}
                  onClick={() => advanceAddStep(3)}
                  disabled={trustBusy}
                >
                  Skip for now
                </button>
                <button type="button" className={styles.settingPrimary} onClick={() => { void trustCaFromWizard(); }} disabled={trustBusy}>
                  {trustBusy ? 'Trusting...' : 'Trust certificate'}
                </button>
              </div>
            </>
          ) : (() => {
            const addedProfile = addedName ? profiles.find((entry) => entry.name === addedName) ?? null : null;
            const addedLabel = addedProfile?.displayName ?? addApp?.name ?? 'the app';
            return (
              <>
                <section className={styles.settingSection}>
                  <div className={styles.settingHead}>
                    <span className={styles.settingTitle}>Ready to connect</span>
                  </div>
                  <p className={styles.settingHint}>
                    Connecting routes {addedLabel}&apos;s AI requests through VPR — served by
                    the AntSeed network and paid from your balance. The app opens after
                    connecting; start a new session there so it picks up the routing.
                  </p>
                  {addedProfile ? (
                    <div className={styles.wizardApp}>
                      {addedProfile.iconDataUri
                        ? <img src={addedProfile.iconDataUri} alt="" className={styles.pickerIcon} />
                        : <BrandIcon name={addedProfile.name} hints={[addedProfile.displayName]} size={20} />}
                      <span className={styles.settingValueName}>{addedProfile.displayName}</span>
                    </div>
                  ) : null}
                </section>

                {addError ? <p className={styles.note} role="alert">{addError}</p> : null}

                <div className={styles.wizardFooter}>
                  <button type="button" className={styles.settingQuiet} onClick={() => setAddOpen(false)}>
                    Later
                  </button>
                  <button
                    type="button"
                    className={styles.settingPrimary}
                    disabled={busy !== null || !defaultPeerId || !addedName}
                    onClick={() => {
                      if (!addedName) return;
                      setAddOpen(false);
                      void connectProfile(addedName);
                    }}
                  >
                    Connect
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      </Modal>
    </section>
  );
}

/** Application-list pane the settings and add-app modals slide to: a
    searchable list with a "none" row first. The back affordance lives in
    the modal header (title swaps to back + "Choose application"). */
function AppPickerPane({ apps, error, search, onSearch, activeName, onChoose, noneLabel, noneMeta }: {
  apps: InstalledAppEntry[] | null;
  error: string | null;
  search: string;
  onSearch: (value: string) => void;
  /** Currently associated application name, or null when none is set. */
  activeName: string | null;
  onChoose: (app: InstalledAppEntry | null) => void;
  noneLabel: string;
  noneMeta: string;
}) {
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = apps ?? [];
    return query ? list.filter((app) => app.name.toLowerCase().includes(query)) : list;
  }, [apps, search]);

  return (
    <div className={styles.pickerStack}>
      <VprSearch value={search} onChange={onSearch} placeholder="Search applications" />
      <div className={styles.pickerList}>
        <button
          type="button"
          className={`${styles.pickerRow}${activeName === null ? ` ${styles.pickerRowActive}` : ''}`}
          onClick={() => onChoose(null)}
        >
          <span className={styles.pickerRowText}>
            <span className={styles.pickerRowName}>{noneLabel}</span>
            <span className={styles.pickerRowMeta}>{noneMeta}</span>
          </span>
          {activeName === null ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} /> : null}
        </button>
        {apps === null ? (
          <div className={styles.pickerEmpty}>Loading applications...</div>
        ) : error ? (
          <div className={styles.pickerEmpty}>{error}</div>
        ) : filtered.length === 0 ? (
          <div className={styles.pickerEmpty}>No applications match your search</div>
        ) : (
          filtered.map((app) => (
            <button
              type="button"
              key={app.path}
              className={`${styles.pickerRow}${activeName === app.name ? ` ${styles.pickerRowActive}` : ''}`}
              onClick={() => onChoose(app)}
              title={app.path}
            >
              {app.iconDataUri
                ? <img src={app.iconDataUri} alt="" className={styles.pickerIcon} />
                : <BrandIcon name={app.name} hints={[app.name]} size={20} />}
              <span className={styles.pickerRowText}>
                <span className={styles.pickerRowName}>{app.name}</span>
              </span>
              {activeName === app.name ? <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} /> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
