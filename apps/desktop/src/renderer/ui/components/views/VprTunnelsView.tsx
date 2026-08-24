import { useCallback, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Settings02Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons';
import { Modal } from '@antseed/ui';
import type { PublicTunnelStatus, TunnelProvider } from '../../../types/bridge';
import { BrandIcon } from '../brand/BrandIcon';
import { VprPage } from '../vpr/VprKit';
import styles from './VprToolsView.module.scss';
import tunnelStyles from './VprTunnelsView.module.scss';

const TUNNEL_DOCS_URL = 'https://antseed.com/docs/guides/public-tunnels';
const HERMES_ICON = new URL('../../../assets/hermes-agent.svg', import.meta.url).href;
const OPENCLAW_ICON = new URL('../../../assets/openclaw.svg', import.meta.url).href;
const MASKED_API_KEY = '••••••••••••••••••••••••••••••••';
type CopyKind = 'url' | 'key';

const AGENTS = [
  {
    name: 'Hermes Agent',
    icon: HERMES_ICON,
    description: 'Connect Hermes to the VPR with the OpenAI-compatible endpoint.',
    integrationUrl: 'https://antseed.com/integrations/hermes/',
    skillUrl: 'https://github.com/AntSeed/antseed/tree/main/skills/hermes-antseed',
  },
  {
    name: 'OpenClaw',
    icon: OPENCLAW_ICON,
    description: 'Register AntSeed as an Anthropic Messages provider for OpenClaw.',
    integrationUrl: 'https://antseed.com/integrations/openclaw/',
    skillUrl: 'https://github.com/AntSeed/antseed/tree/main/skills/openclaw-antseed',
  },
] as const;

const PROVIDERS: ReadonlyArray<{
  id: TunnelProvider;
  name: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  urlPlaceholder: string;
  description: string;
  setupHint: string;
  dashboardLabel: string;
  dashboardUrl: string;
}> = [
  {
    id: 'ngrok',
    name: 'ngrok',
    tokenLabel: 'ngrok authtoken',
    tokenPlaceholder: 'ngrok authtoken',
    urlPlaceholder: 'https://example.ngrok-free.dev',
    description: 'Generate a public HTTPS endpoint, with an optional static ngrok domain.',
    setupHint: 'Paste the authtoken. Leave the hostname blank for a generated URL, or enter a static ngrok domain.',
    dashboardLabel: 'Open ngrok Dashboard',
    dashboardUrl: 'https://dashboard.ngrok.com/',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Tunnel',
    tokenLabel: 'Cloudflare tunnel token',
    tokenPlaceholder: 'Named tunnel run token',
    urlPlaceholder: 'https://cursor-api.example.com',
    description: 'Use a named Cloudflare Tunnel and your own hostname.',
    setupHint: 'Route the public hostname to http://localhost:8379, then paste its run token.',
    dashboardLabel: 'Open Cloudflare Zero Trust',
    dashboardUrl: 'https://one.dash.cloudflare.com/',
  },
];

export function VprTunnelsView() {
  const [status, setStatus] = useState<PublicTunnelStatus | null>(null);
  const [editingProvider, setEditingProvider] = useState<TunnelProvider | null>(null);
  const [token, setToken] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [busyProvider, setBusyProvider] = useState<TunnelProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'key' | null>(null);
  const [endpointExpanded, setEndpointExpanded] = useState(false);

  const refresh = useCallback(async () => {
    const next = await window.antseedDesktop?.publicTunnelGetStatus?.();
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const configureAndStart = useCallback(async () => {
    const provider = editingProvider;
    const bridge = window.antseedDesktop;
    if (!provider || !bridge?.publicTunnelConfigure || !bridge.publicTunnelStart) return;
    setBusyProvider(provider);
    setError(null);
    try {
      const configured = await bridge.publicTunnelConfigure({ provider, tunnelToken: token.trim(), publicUrl: publicUrl.trim() });
      if (!configured.ok) {
        setError(configured.error ?? 'Could not save tunnel settings');
        return;
      }
      const result = await bridge.publicTunnelStart({ provider });
      if (!result.ok) {
        setError(result.error ?? 'Could not start tunnel');
        return;
      }
      if (result.status) setStatus(result.status);
      setEditingProvider(null);
      setToken('');
      setPublicUrl('');
    } finally {
      setBusyProvider(null);
    }
  }, [editingProvider, publicUrl, token]);

  const toggleTunnel = useCallback(async (provider: TunnelProvider) => {
    const bridge = window.antseedDesktop;
    const isRunning = status?.running === true && status.activeProvider === provider;
    setBusyProvider(provider);
    setError(null);
    try {
      const result = isRunning
        ? await bridge?.publicTunnelStop?.()
        : await bridge?.publicTunnelStart?.({ provider });
      if (!result?.ok) {
        setError(result?.error ?? 'Tunnel action failed');
        return;
      }
      if (result.status) setStatus(result.status);
    } finally {
      setBusyProvider(null);
    }
  }, [status?.activeProvider, status?.running]);

  const copy = useCallback((value: string, kind: CopyKind) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  const loadApiKey = useCallback(async (): Promise<string | null> => {
    if (apiKey) return apiKey;
    const result = await window.antseedDesktop?.publicTunnelGetApiKey?.();
    const loadedApiKey = result?.apiKey ?? null;
    setApiKey(loadedApiKey);
    return loadedApiKey;
  }, [apiKey]);

  const revealKey = useCallback(async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    await loadApiKey();
    setApiKeyVisible(true);
  }, [apiKeyVisible, loadApiKey]);

  const copyApiKey = useCallback(async () => {
    const key = await loadApiKey();
    if (key) copy(key, 'key');
  }, [copy, loadApiKey]);

  const openConfigure = useCallback((provider: TunnelProvider) => {
    setEditingProvider(provider);
    setToken('');
    setPublicUrl('');
    setError(null);
  }, []);

  const selectedProvider = PROVIDERS.find((provider) => provider.id === editingProvider) ?? null;
  const baseUrl = status?.baseUrl ?? null;
  const hasConnectionDetails = Boolean(baseUrl || status?.configured);
  const publicUrlIsValid = publicUrl.trim().startsWith('https://');
  const publicUrlIsRequired = selectedProvider?.id === 'cloudflare';
  const configureDisabled = busyProvider !== null
    || token.trim().length < 20
    || (publicUrlIsRequired && !publicUrlIsValid)
    || (publicUrl.trim().length > 0 && !publicUrlIsValid);

  return (
    <section className={`view view-vpr-tunnels view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Agents" backFallback="home">
        <div className={styles.stack}>
          <section className={tunnelStyles.intro}>
            <h2 className={tunnelStyles.introTitle}>Connect an agent to your VPR</h2>
            <p className={tunnelStyles.introText}>Agents on this computer can use <code>http://127.0.0.1:8377/v1</code>. For an agent running elsewhere, define a protected internet-accessible endpoint below.</p>
          </section>

          <div className={tunnelStyles.agentList}>
            {AGENTS.map((agent) => (
              <section key={agent.name} className={tunnelStyles.agentCard}>
                <img className={tunnelStyles.agentIcon} src={agent.icon} alt="" />
                <div className={tunnelStyles.agentContent}>
                  <h2 className={tunnelStyles.agentName}>{agent.name}</h2>
                  <p className={tunnelStyles.agentDescription}>{agent.description}</p>
                  <span className={tunnelStyles.agentLinks}>
                    <button type="button" className={tunnelStyles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(agent.integrationUrl)}>
                      Setup guide <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                    </button>
                    <button type="button" className={tunnelStyles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(agent.skillUrl)}>
                      Agent skill <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                    </button>
                  </span>
                </div>
              </section>
            ))}
          </div>

          <section className={tunnelStyles.endpointSection}>
            <button
              type="button"
              className={tunnelStyles.endpointTrigger}
              aria-expanded={endpointExpanded}
              aria-controls="agents-public-endpoint"
              onClick={() => setEndpointExpanded((expanded) => !expanded)}
            >
              <span className={tunnelStyles.endpointHeader}>
                <span className={tunnelStyles.endpointTitle}>Define your internet-accessible AntSeed endpoint</span>
                <span className={tunnelStyles.endpointSummary}>For agents and hosted clients running outside this computer</span>
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={18}
                strokeWidth={1.8}
                className={`${tunnelStyles.endpointChevron}${endpointExpanded ? ` ${tunnelStyles.endpointChevronExpanded}` : ''}`}
              />
            </button>

            {endpointExpanded ? (
              <div id="agents-public-endpoint" className={tunnelStyles.endpointBody}>
                <p className={tunnelStyles.introText}>Publish only the authenticated model API. Remote requests require the generated AntSeed API key.</p>
                <button type="button" className={tunnelStyles.docsLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(TUNNEL_DOCS_URL)}>
                  Public tunnel setup guide <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                </button>

                {error ? <p className={styles.note} role="alert">{error}</p> : null}

                <div className={styles.appList}>
                  {PROVIDERS.map((provider) => {
                    const configured = status?.configuredProviders.includes(provider.id) ?? false;
                    const running = status?.running === true && status.activeProvider === provider.id;
                    return (
                      <div key={provider.id} className={`${styles.appPill}${running ? ` ${styles.appPillConnected}` : ''}`}>
                        <div className={styles.appHead}>
                          <span className={styles.appIdentity}>
                            <BrandIcon name={provider.id} hints={[provider.name]} size={24} />
                            <span className={styles.appText}>
                              <span className={styles.appNameRow}><span className={styles.appName}>{provider.name}</span></span>
                              {running ? <span className={styles.appMeta}><span className={styles.connectedDot} aria-hidden="true" />Connected</span> : null}
                            </span>
                          </span>
                          {configured ? (
                            <button type="button" className={styles.configAction} onClick={() => openConfigure(provider.id)} aria-label={`Configure ${provider.name}`}>
                              <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={2} />
                            </button>
                          ) : null}
                          {configured ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={running}
                              className={`${styles.connectedToggle}${running ? '' : ` ${styles.connectedToggleOff}`}`}
                              disabled={busyProvider !== null}
                              onClick={() => void toggleTunnel(provider.id)}
                              aria-label={`${running ? 'Stop' : 'Start'} ${provider.name}`}
                              title={`${running ? 'Stop' : 'Start'} ${provider.name}`}
                            >
                              <span />
                            </button>
                          ) : (
                            <button type="button" className={styles.connectAction} disabled={busyProvider !== null} onClick={() => openConfigure(provider.id)}>
                              {busyProvider === provider.id ? 'Working…' : 'Configure'}
                            </button>
                          )}
                        </div>
                        <p className={styles.settingHint}>{provider.description}</p>
                      </div>
                    );
                  })}
                </div>

                {hasConnectionDetails ? (
                  <section className={tunnelStyles.connectionDetails}>
                    <div>
                      <h2 className={tunnelStyles.connectionTitle}>Connection details</h2>
                      <p className={styles.settingHint}>Use these values in the remote agent or client’s provider settings.</p>
                    </div>
                    {baseUrl ? (
                      <section className={styles.settingSection}>
                        <div className={styles.settingHead}><span className={styles.settingTitle}>OpenAI base URL</span></div>
                        <div className={tunnelStyles.credentialRow}>
                          <input readOnly className={styles.settingInput} value={baseUrl} />
                          <button type="button" className={tunnelStyles.copyButton} onClick={() => copy(baseUrl, 'url')}>
                            <HugeiconsIcon icon={copied === 'url' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
                            {copied === 'url' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      </section>
                    ) : null}
                    {status?.configured ? (
                      <section className={styles.settingSection}>
                        <div className={styles.settingHead}><span className={styles.settingTitle}>API key</span></div>
                        <div className={tunnelStyles.credentialRow}>
                          <div className={tunnelStyles.secretField}>
                            <span className={tunnelStyles.secretValue}>{apiKeyVisible && apiKey ? apiKey : MASKED_API_KEY}</span>
                            <button type="button" className={tunnelStyles.revealButton} onClick={() => void revealKey()} aria-label={apiKeyVisible ? 'Hide API key' : 'Reveal API key'}>
                              <HugeiconsIcon icon={apiKeyVisible ? ViewOffSlashIcon : ViewIcon} size={16} strokeWidth={1.8} />
                            </button>
                          </div>
                          <button type="button" className={tunnelStyles.copyButton} onClick={() => void copyApiKey()}>
                            <HugeiconsIcon icon={copied === 'key' ? Tick02Icon : Copy01Icon} size={15} strokeWidth={2} />
                            {copied === 'key' ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <p className={styles.settingHint}>Sent as <code>Authorization: Bearer &lt;API_KEY&gt;</code>. The same key works with either provider.</p>
                      </section>
                    ) : null}
                  </section>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </VprPage>

      <Modal isOpen={selectedProvider !== null} onClose={() => setEditingProvider(null)} size="sm" title={selectedProvider?.name ?? 'Tunnel'} subtitle="Expose only AntSeed’s authenticated /v1 API." className={styles.vprModal} bodyClassName={styles.settingsBody}>
        {selectedProvider ? (
          <>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}><span className={styles.settingTitle}>{selectedProvider.tokenLabel}</span><span className={styles.settingTag}>Required</span></div>
              <p className={styles.settingHint}>{selectedProvider.setupHint}</p>
              <input type="password" className={styles.settingInput} value={token} placeholder={selectedProvider.tokenPlaceholder} autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} />
              <button type="button" className={styles.settingWebsiteLink} onClick={() => void window.antseedDesktop?.openExternalUrl?.(selectedProvider.dashboardUrl)}>
                {selectedProvider.dashboardLabel} <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
              </button>
            </section>
            <section className={styles.settingSection}>
              <div className={styles.settingHead}>
                <span className={styles.settingTitle}>Public hostname</span>
                <span className={styles.settingTag}>{publicUrlIsRequired ? 'Required' : 'Optional'}</span>
              </div>
              <input type="url" className={styles.settingInput} value={publicUrl} placeholder={selectedProvider.urlPlaceholder} spellCheck={false} onChange={(event) => setPublicUrl(event.target.value)} />
            </section>
            {error ? <p className={styles.note} role="alert">{error}</p> : null}
            <div className={styles.settingFooter}>
              <button type="button" className={styles.connectAction} disabled={configureDisabled} onClick={() => void configureAndStart()}>
                {busyProvider ? 'Starting…' : 'Save and start'}
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
