import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { PlayIcon, Cancel01Icon, CheckmarkCircle01Icon, Loading03Icon } from '@hugeicons/core-free-icons';
import type { RuntimeProcessState, LogEvent, SystemProxyProfileSummary } from '../../../types/bridge';
import type { DiscoverRow, PeerEntry } from '../../../core/state';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import styles from './SystemProxyView.module.scss';

type SystemProxyViewProps = { active: boolean };

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

type PeerOption = { peerId: string; label: string; services: string[]; online: boolean };
type ProfileTraffic = { count: number; lastSeen: number | null; lastLine: string | null; lastStatus: number | null; lastStatusAt: number | null };
type ToolRoute = { peerId: string; model: string };

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request', 401: 'Unauthorized', 402: 'Payment required', 403: 'Forbidden',
  404: 'Not found', 408: 'Timeout', 429: 'Rate limited',
  500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Gateway timeout',
};

function isOkStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 400;
}

function statusLabel(code: number): string {
  if (isOkStatus(code)) return 'Healthy';
  return `${code} ${STATUS_TEXT[code] ?? 'Error'}`;
}

function shortPeerId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function buildPeerOptions(lastPeers: PeerEntry[], discoverRows: DiscoverRow[]): PeerOption[] {
  const byPeer = new Map<string, PeerOption>();
  for (const p of lastPeers) byPeer.set(p.peerId, { peerId: p.peerId, label: p.displayName || shortPeerId(p.peerId), services: p.services, online: p.online });
  for (const r of discoverRows) {
    const ex = byPeer.get(r.peerId);
    const svc = new Set(ex?.services ?? []);
    if (r.serviceId) svc.add(r.serviceId);
    byPeer.set(r.peerId, { peerId: r.peerId, label: r.peerDisplayName || r.peerLabel || ex?.label || shortPeerId(r.peerId), services: [...svc], online: ex?.online ?? true });
  }
  return [...byPeer.values()].sort((a, b) => (a.online !== b.online ? (a.online ? -1 : 1) : a.label.localeCompare(b.label)));
}

function activeProfilesFromState(state: RuntimeProcessState | null): Set<string> | null {
  const raw = state?.activeProfileNames;
  return Array.isArray(raw) ? new Set(raw.filter((x): x is string => typeof x === 'string')) : null;
}

function buildTraffic(logs: LogEvent[], profiles: SystemProxyProfileSummary[]): Map<string, ProfileTraffic> {
  const m = new Map<string, ProfileTraffic>();
  for (const p of profiles) m.set(p.name, { count: 0, lastSeen: null, lastLine: null, lastStatus: null, lastStatusAt: null });
  for (const e of logs) {
    if (e.mode !== 'system-proxy') continue;
    const line = e.line.replace(/\[[0-9;]*m/g, '');
    // Response line: "← 502 example.test | source:standard | ..."
    const resp = line.match(/←\s+(\d{3})\s+(\S+)\s+\|\s+source:(\S+)/);
    if (resp) {
      const status = Number(resp[1]);
      const host = resp[2]!;
      const source = resp[3]!;
      const rp = profiles.find((x) => x.name === source || x.domains.some((d) => host === d || host.includes(d)));
      if (rp) {
        const prev = m.get(rp.name)!;
        m.set(rp.name, { ...prev, lastStatus: status, lastStatusAt: e.timestamp });
      }
      continue;
    }

    if (!/(?:CONNECT|→)\s/.test(line)) continue;
    const p = profiles.find((x) => line.includes(`source:${x.name}`) || x.domains.some((d) => line.includes(d)));
    if (!p) continue;
    const prev = m.get(p.name) ?? { count: 0, lastSeen: null, lastLine: null, lastStatus: null, lastStatusAt: null };
    m.set(p.name, { ...prev, count: prev.count + 1, lastSeen: e.timestamp, lastLine: line });
  }
  return m;
}

function fmtAgo(ts: number | null): string {
  if (!ts) return 'No traffic yet';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export function SystemProxyView({ active }: SystemProxyViewProps) {
  const { lastPeers, discoverRows, logs, chatSelectedPeerId, chatSelectedServiceValue } = useUiSelector((s) => ({
    lastPeers: s.lastPeers, discoverRows: s.discoverRows, logs: s.logs,
    chatSelectedPeerId: s.chatSelectedPeerId, chatSelectedServiceValue: s.chatSelectedServiceValue,
  }), shallowEqual);

  const [state, setState] = useState<RuntimeProcessState | null>(null);
  const [peerId, setPeerId] = useState('');
  const [model, setModel] = useState('');
  const [port] = useState(DEFAULT_PORT);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shellMsg, setShellMsg] = useState<string | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const [guiTest, setGuiTest] = useState<GuiTestResult | null>(null);
  const [guiTestBusy, setGuiTestBusy] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [appRestartBusy, setAppRestartBusy] = useState<string | null>(null);
  const [appRestartMsg, setAppRestartMsg] = useState<Record<string, string>>({});
  const [toolRoutes, setToolRoutes] = useState<Record<string, ToolRoute>>({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = state?.running === true;
  const peerOptions = useMemo(() => buildPeerOptions(lastPeers, discoverRows), [lastPeers, discoverRows]);
  const selectedPeer = useMemo(() => peerOptions.find((p) => p.peerId === peerId) ?? null, [peerOptions, peerId]);
  const models = selectedPeer?.services ?? [];
  const traffic = useMemo(() => buildTraffic(logs, profiles), [logs, profiles]);
  const hasProxy = useMemo(() => profiles.some((p) => p.kind === 'proxy' && enabled.has(p.name)), [enabled, profiles]);

  // Auto-select peer from chat state
  useEffect(() => {
    if (peerId) return;
    const parts = chatSelectedServiceValue.split('');
    const pinned = chatSelectedPeerId.trim() || parts[2]?.trim() || '';
    if (pinned) { setPeerId(pinned); return; }
    if (peerOptions.length === 1) setPeerId(peerOptions[0]!.peerId);
  }, [chatSelectedPeerId, chatSelectedServiceValue, peerId, peerOptions]);

  // Auto-select model
  useEffect(() => {
    if (!peerId) { setModel(''); return; }
    if (model && models.includes(model)) return;
    const parts = chatSelectedServiceValue.split('');
    const pinned = parts[1]?.trim() ?? '';
    setModel((pinned && models.includes(pinned)) ? pinned : (models[0] ?? ''));
  }, [chatSelectedServiceValue, model, models, peerId]);

  const refresh = useCallback(async () => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyGetState) return;
    try {
      if (b.systemProxyListProfiles) {
        setProfiles(await b.systemProxyListProfiles());
      }
      const s = await b.systemProxyGetState();
      setState(s);
      const ap = activeProfilesFromState(s);
      if (ap) setEnabled(ap);
      const sp = typeof s?.peerId === 'string' ? s.peerId : '';
      if (sp) setPeerId(sp);
      const sm = typeof s?.defaultModel === 'string' ? s.defaultModel : '';
      if (sm) setModel(sm);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    pollingRef.current = setInterval(() => void refresh(), 3000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [active, refresh]);

  const start = useCallback(async (profiles?: Set<string>, profileSwitch = false) => {
    const b = window.antseedDesktop;
    if (!b) return;
    const p = profiles ?? enabled;
    if (!peerId.trim()) { setError('Select a peer first.'); return; }
    if (p.size === 0) { setError('Enable at least one tool.'); return; }
    setError(null);
    setBusy(true);
    const r = await b.systemProxyStart?.({ peerId: peerId.trim(), port, profiles: [...p], defaultModel: model.trim() || undefined, servedModels: models, profileSwitch });
    setBusy(false);
    if (!r?.ok) { setError(r?.error ?? 'Failed to start.'); return; }
    setState(r.state ?? null);
    setEnabled(p);
  }, [peerId, port, enabled, model, models]);

  const stop = useCallback(async () => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyStop) return;
    setError(null);
    const r = await b.systemProxyStop();
    if (r.ok) { setState(r.state ?? null); setEnabled(new Set()); }
    else setError(r.error ?? 'Failed to stop.');
  }, []);

  const toggle = useCallback((name: string, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(name); else next.delete(name);
    setUpdating(name);
    setError(null);
    const run = async () => {
      try {
        setEnabled(next);
        if (next.size === 0) { if (isRunning) await stop(); return; }
        await start(next, isRunning);
      } finally { setUpdating(null); }
    };
    void run();
  }, [enabled, isRunning, start, stop]);

  // GUI trust test
  const testGui = useCallback(async () => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyTestGui) return;
    setGuiTestBusy(true);
    try { setGuiTest(await b.systemProxyTestGui({ port })); }
    catch (e) { setGuiTest({ ok: false, proxyConfigured: false, proxyReachable: false, guiTrustOk: false, appRunning: false, needsAppRestart: false, error: e instanceof Error ? e.message : String(e) }); }
    finally { setGuiTestBusy(false); }
  }, [port]);

  useEffect(() => { if (active && isRunning) void testGui(); }, [active, isRunning, testGui]);

  const trustCa = useCallback(async () => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyInstallCa) return;
    setTrustBusy(true);
    try { const r = await b.systemProxyInstallCa(); if (r.ok) await testGui(); else setError(r.error ?? 'CA install failed.'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setTrustBusy(false); }
  }, [testGui]);

  const addToShell = useCallback(async () => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyAddToShell) return;
    setShellBusy(true);
    setShellMsg(null);
    try {
      const r = await b.systemProxyAddToShell();
      setShellMsg(r.ok
        ? (r.added.length > 0 ? `Updated ${r.added.map((f) => f.split('/').pop()).join(', ')}. Restart tools or open a new terminal.` : 'Already configured.')
        : (r.error ?? 'Failed.'));
    } catch (e) { setShellMsg(e instanceof Error ? e.message : String(e)); }
    finally { setShellBusy(false); }
  }, []);

  const resolveRoute = useCallback((name: string): ToolRoute => {
    const override = toolRoutes[name];
    return {
      peerId: override?.peerId || peerId,
      model: override?.model || model,
    };
  }, [toolRoutes, peerId, model]);

  const setToolRoute = useCallback((name: string, patch: Partial<ToolRoute>) => {
    setToolRoutes((prev) => {
      const cur = prev[name] ?? { peerId: '', model: '' };
      const next = { ...cur, ...patch };
      if (!next.peerId && !next.model) {
        const { [name]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [name]: next };
    });
  }, []);

  const openUrl = useCallback(async (url: string) => {
    const r = await window.antseedDesktop?.openExternalUrl?.(url);
    if (r && !r.ok) setError(r.error ?? 'Could not open.');
  }, []);

  const openTool = useCallback(async (toolName: string) => {
    const r = await window.antseedDesktop?.openTool?.(toolName);
    if (r && !r.ok) setError(r.error ?? 'Could not open.');
  }, []);

  const restartApp = useCallback(async (app: string) => {
    const b = window.antseedDesktop;
    if (!b?.systemProxyRestartApp) return;
    setAppRestartBusy(app);
    setAppRestartMsg((m) => ({ ...m, [app]: '' }));
    try {
      const r = await b.systemProxyRestartApp(app);
      setAppRestartMsg((m) => ({ ...m, [app]: r.ok ? 'Restarted — the AntSeed provider is now loaded.' : (r.error ?? 'Restart failed.') }));
    } catch (e) {
      setAppRestartMsg((m) => ({ ...m, [app]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAppRestartBusy(null);
    }
  }, []);

  return (
    <section className={`view view-system-proxy ${styles.view}${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>System Proxy</h2>
        <div className={`${styles.badge} ${isRunning ? styles.badgeOn : styles.badgeOff}`}>
          <span className={styles.badgeDot} />
          {isRunning ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div className={styles.content}>
        <p className={styles.subtitle}>
          Route local AI tools through AntSeed. Proxy-based tools use the local HTTPS proxy; config-based tools are pointed directly at the buyer proxy.
        </p>

        {!isRunning && (
          <div className={styles.configRow}>
            <div className={styles.configField}>
              <span className={styles.label}>Peer</span>
              <select className={styles.select} value={peerId} onChange={(e) => setPeerId(e.target.value)} disabled={peerOptions.length === 0}>
                <option value="">{peerOptions.length === 0 ? 'No peers discovered' : 'Select a peer'}</option>
                {peerOptions.map((p) => <option key={p.peerId} value={p.peerId}>{p.label} – {shortPeerId(p.peerId)}</option>)}
              </select>
            </div>
            <div className={styles.configField}>
              <span className={styles.label}>Default model</span>
              <select className={styles.select} value={model} onChange={(e) => setModel(e.target.value)} disabled={!peerId || models.length === 0}>
                <option value="">{peerId ? 'Select a model' : '–'}</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}

        <div className={styles.tools}>
          {profiles.length === 0 && (
            <div className={styles.tool}>
              <div className={styles.toolHead}>
                <span className={styles.toolDot} />
                <div className={styles.toolInfo}>
                  <span className={styles.toolName}>No tool profiles configured</span>
                  <span className={styles.toolMethod}>Set ANTSEED_SYSTEM_PROXY_PROFILES_JSON or ANTSEED_SYSTEM_PROXY_PROFILES_FILE.</span>
                </div>
              </div>
            </div>
          )}
          {profiles.map((profile) => {
            const on = enabled.has(profile.name);
            const connected = isRunning && on;
            const t = traffic.get(profile.name) ?? { count: 0, lastSeen: null, lastLine: null, lastStatus: null, lastStatusAt: null };
            const isUpdating = updating === profile.name;
            const disabled = isUpdating || (!peerId && !on);
            const route = resolveRoute(profile.name);
            const routePeer = peerOptions.find((p) => p.peerId === route.peerId) ?? selectedPeer;
            const routeModels = routePeer?.services ?? [];

            return (
              <div key={profile.name} className={`${styles.tool}${connected ? ` ${styles.toolOn}` : ''}`}>
                <div className={styles.toolHead}>
                  <span className={`${styles.toolDot}${connected ? ` ${styles.toolDotOn}` : ''}`} />
                  <div className={styles.toolInfo}>
                    <span className={styles.toolName}>{profile.displayName}</span>
                    <span className={styles.toolMethod}>{profile.method}</span>
                  </div>
                  <div className={styles.toolActions}>
                    {connected && profile.appAction === 'open-url' && profile.openUrl && (
                      <button type="button" className={styles.toolSecBtn} onClick={() => void openUrl(profile.openUrl!)}>Open</button>
                    )}
                    {connected && profile.appAction === 'open-tool' && (
                      <button type="button" className={styles.toolSecBtn} onClick={() => void openTool(profile.toolName ?? profile.name)}>Open</button>
                    )}
                    {connected && (profile.kind === 'config-patch' || profile.canRestart || profile.appAction === 'restart-app') && (
                      <button
                        type="button"
                        className={styles.toolSecBtn}
                        onClick={() => void restartApp(profile.name)}
                        disabled={appRestartBusy === profile.name}
                      >
                        {appRestartBusy === profile.name ? 'Restarting…' : `Restart ${profile.displayName}`}
                      </button>
                    )}
                    {connected && guiTest && !guiTest.guiTrustOk && guiTest.proxyReachable && (
                      <button type="button" className={styles.toolSecBtn} onClick={() => void trustCa()} disabled={trustBusy}>
                        {trustBusy ? 'Trusting…' : 'Trust CA'}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.toolBtn}${connected ? ` ${styles.toolBtnOff}` : ''}`}
                      onClick={() => toggle(profile.name, !on)}
                      disabled={disabled}
                    >
                      {isUpdating
                        ? <><HugeiconsIcon icon={Loading03Icon} size={12} strokeWidth={1.5} /><span>…</span></>
                        : connected
                          ? <><HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.5} /><span>Disconnect</span></>
                          : <><HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={1.5} /><span>Connect</span></>}
                    </button>
                  </div>
                </div>
                <div className={styles.toolOverrides}>
                  <select
                    className={styles.toolSelect}
                    value={toolRoutes[profile.name]?.model ?? ''}
                    onChange={(e) => setToolRoute(profile.name, { model: e.target.value })}
                    disabled={isUpdating || routeModels.length === 0}
                  >
                    <option value="">Default model{model ? ` (${model})` : ''}</option>
                    {routeModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select
                    className={styles.toolSelect}
                    value={toolRoutes[profile.name]?.peerId ?? ''}
                    onChange={(e) => setToolRoute(profile.name, { peerId: e.target.value, model: '' })}
                    disabled={isUpdating || peerOptions.length === 0}
                  >
                    <option value="">Default peer{selectedPeer ? ` (${selectedPeer.label})` : ''}</option>
                    {peerOptions.map((p) => <option key={p.peerId} value={p.peerId}>{p.label} – {shortPeerId(p.peerId)}</option>)}
                  </select>
                </div>
                {profile.kind === 'config-patch' ? (
                  connected && (
                    <div className={styles.toolNote}>
                      {appRestartMsg[profile.name]
                        || `Provider written to config. ${profile.displayName} reads config at startup — use “Restart ${profile.displayName}” to load it now.`}
                    </div>
                  )
                ) : (
                  <>
                    <div className={styles.toolStats}>
                      {t.lastStatus !== null && (
                        <span className={isOkStatus(t.lastStatus) ? styles.statusOk : styles.statusErr}>
                          <span className={styles.statusDotSm} />
                          {statusLabel(t.lastStatus)}
                          {t.lastStatusAt ? ` · ${fmtAgo(t.lastStatusAt)}` : ''}
                        </span>
                      )}
                      <span>{t.count} request{t.count === 1 ? '' : 's'}</span>
                      {t.lastStatus === null && <span>{fmtAgo(t.lastSeen)}</span>}
                    </div>
                    {t.lastLine && <div className={styles.toolLastLine}>{t.lastLine}</div>}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}

        <div className={styles.btnRow}>
          {!isRunning ? (
            <button className={styles.primaryBtn} onClick={() => void start()} disabled={busy || !peerId.trim() || enabled.size === 0}>
              {busy
                ? <><HugeiconsIcon icon={Loading03Icon} size={13} strokeWidth={1.5} /><span>Connecting…</span></>
                : <><HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={1.5} /><span>Connect selected tools</span></>}
            </button>
          ) : (
            <button className={styles.dangerBtn} onClick={stop}>
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.5} />
              <span>Disconnect all</span>
            </button>
          )}
        </div>

        {isRunning && (
          <div className={styles.infoCard}>
            <div className={`${styles.infoLine} ${styles.infoLineOk}`}>
              <HugeiconsIcon icon={CheckmarkCircle01Icon} size={14} strokeWidth={1.5} />
              <span>{hasProxy ? `HTTPS proxy active on :${port}` : 'Config-based tools connected'}</span>
            </div>
            {hasProxy && (
              <p className={styles.bodyText}>
                Proxy-based tools may need CA trust and an app restart. Use "Add shell setup" to configure Node.js tools automatically.
              </p>
            )}
            {hasProxy && (
              <div className={styles.btnRow}>
                <button type="button" className={styles.secondaryBtn} onClick={() => void addToShell()} disabled={shellBusy}>
                  {shellBusy ? 'Updating…' : 'Add shell setup'}
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => void testGui()} disabled={guiTestBusy}>
                  {guiTestBusy ? 'Testing…' : 'Test connection'}
                </button>
              </div>
            )}
            {shellMsg && <div className={styles.warnBanner}>{shellMsg}</div>}
            {guiTest?.error && <div className={styles.warnBanner}>{guiTest.error}</div>}
          </div>
        )}
      </div>
    </section>
  );
}
