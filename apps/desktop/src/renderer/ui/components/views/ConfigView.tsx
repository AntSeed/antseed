import { useState, useEffect, useCallback } from 'react';
import QRCode from 'react-qr-code';
import { Button } from '@antseed/ui';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatCopyButton } from '../chat/ChatCopyButton';

type ConfigViewProps = {
  active: boolean;
};

type VoiceModelStatus = {
  available: boolean;
  activeModel: string;
  error: string | null;
  models: Array<{ id: string; label: string; size: string; installed: boolean; selected: boolean; bundled: boolean }>;
};

function isVoiceModelStatus(value: unknown): value is VoiceModelStatus {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return Boolean(record && Array.isArray(record.models));
}

type ServiceStatus = {
  enabled: boolean;
  attention: boolean;
  summary: string;
  receiveAddress?: string | null;
  receiveLimitUsdc?: number | null;
};

type ServicePluginView = {
  name: string;
  kind?: string;
  displayName: string;
  description: string;
  installed?: boolean;
  active?: boolean;
  enabled?: boolean;
  status: ServiceStatus;
};

function isServiceList(value: unknown): value is ServicePluginView[] {
  return Array.isArray(value) && value.every((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const status = record && typeof record.status === 'object' ? record.status as Record<string, unknown> : null;
    return Boolean(record && typeof record.name === 'string' && status && typeof status.enabled === 'boolean');
  });
}

function formatUsdc(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

function chainLabel(chainId: string): string {
  if (chainId === 'base-mainnet') return 'Base';
  if (chainId === 'base-sepolia') return 'Base Sepolia';
  return chainId;
}

export function ConfigView({ active }: ConfigViewProps) {
  const { configFormData, configSaving, devMode, configMessage } = useUiSnapshot();
  const actions = useActions();

  // Local form state — initialized from config, edited locally, saved on button click
  const [proxyPort, setProxyPort] = useState('8377');
  const [minRep, setMinRep] = useState('0');
  const [chainId, setChainId] = useState('base-mainnet');
  const [disableMetadataV2Services, setDisableMetadataV2Services] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceModelStatus | null>(null);
  const [voiceInstalling, setVoiceInstalling] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [services, setServices] = useState<ServicePluginView[]>([]);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);

  // Sync from config on first load only
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (configFormData && !initialized) {
      setProxyPort(String(configFormData.proxyPort));
      setMinRep(String(configFormData.minRep));
      setChainId(configFormData.cryptoChainId || 'base-mainnet');
      setDisableMetadataV2Services(configFormData.disableMetadataV2Services);
      setInitialized(true);
    }
  }, [configFormData, initialized]);

  const markDirty = useCallback(() => setDirty(true), []);

  const refreshVoiceStatus = useCallback(async () => {
    const result = await window.antseedDesktop?.voiceGetStatus?.();
    if (isVoiceModelStatus(result)) setVoiceStatus(result);
  }, []);

  useEffect(() => {
    if (active) void refreshVoiceStatus();
  }, [active, refreshVoiceStatus]);

  const refreshServices = useCallback(async () => {
    const result = await window.antseedDesktop?.apiTryProxyRequest?.({
      port: parseInt(proxyPort, 10) || 8377,
      path: '/_antseed/services',
      method: 'GET', headers: {}, body: '',
    });
    if (!result?.ok) return;
    try {
      const data = JSON.parse(result.body) as { services?: unknown };
      if (isServiceList(data.services)) setServices(data.services);
    } catch { /* ignore transient poll/parse errors */ }
  }, [proxyPort]);

  useEffect(() => {
    if (!active) return;
    void refreshServices();
    const timer = setInterval(() => void refreshServices(), 5000);
    return () => clearInterval(timer);
  }, [active, refreshServices]);

  async function handleVoiceModelChange(modelId: string) {
    setVoiceMessage(null);
    const result = await window.antseedDesktop?.voiceSetModel?.(modelId) as { ok?: boolean; error?: string; status?: unknown } | undefined;
    if (!result?.ok) {
      setVoiceMessage(result?.error || 'Could not switch voice model.');
      return;
    }
    if (isVoiceModelStatus(result.status)) setVoiceStatus(result.status);
  }

  async function handleInstallBaseModel() {
    setVoiceInstalling(true);
    setVoiceMessage('Downloading Base multilingual (~142 MB)…');
    try {
      const result = await window.antseedDesktop?.voiceInstallModel?.('base') as { ok?: boolean; error?: string; status?: unknown } | undefined;
      if (!result?.ok) throw new Error(result?.error || 'Install failed.');
      if (isVoiceModelStatus(result.status)) setVoiceStatus(result.status);
      setVoiceMessage('Base multilingual installed and selected.');
    } catch (error) {
      setVoiceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setVoiceInstalling(false);
    }
  }

  async function toggleService(name: string, enabled: boolean) {
    setServiceBusy(name);
    setServiceMessage(null);
    try {
      const result = await window.antseedDesktop?.apiTryProxyRequest?.({
        port: parseInt(proxyPort, 10) || 8377,
        path: '/_antseed/services',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, enabled }),
      });
      if (!result?.ok) throw new Error(result?.error || `Request failed (${result?.status ?? 0})`);
      const data = JSON.parse(result.body) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || 'Request rejected');
      await refreshServices();
    } catch (error) {
      setServiceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setServiceBusy(null);
    }
  }

  // Toggles that auto-save (no restart needed)
  function toggleDevMode() {
    if (!configFormData) return;
    void actions.saveConfig({ ...configFormData, devMode: !devMode });
  }

  // Save all config and restart the buyer runtime
  async function handleSaveAndRestart() {
    if (!configFormData) return;
    await actions.saveConfig({
      ...configFormData,
      proxyPort: parseInt(proxyPort, 10) || 8377,
      peerRefreshIntervalMs: configFormData.peerRefreshIntervalMs,
      minRep: parseInt(minRep, 10) || 0,
      disableMetadataV2Services,
      cryptoChainId: chainId,
    });
    setDirty(false);
    // Restart buyer runtime to pick up new config
    try {
      await actions.stopConnect();
    } catch { /* may not be running */ }
    try {
      await actions.startConnect();
    } catch { /* will auto-start on next request */ }
  }

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Settings</h2>
      </div>

      <div className="settings-sections">
        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Buyer Settings</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Proxy Port</h4>
                <p>Local port for service routing and chat requests.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                value={proxyPort}
                onChange={(e) => { setProxyPort(e.target.value); markDirty(); }}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Minimum Peer Reputation</h4>
                <p>Peers below this score are excluded from routing.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                min="0"
                max="100"
                value={minRep}
                onChange={(e) => { setMinRep(e.target.value); markDirty(); }}
              />
            </label>
            <div className="settings-item">
              <div className="settings-copy">
                <h4>Disable Service Metadata Attribution</h4>
                <p>Omit per-service usage details from paid and free usage metadata.</p>
              </div>
              <button
                type="button"
                className={`settings-switch${disableMetadataV2Services ? ' is-on' : ''}`}
                aria-pressed={disableMetadataV2Services}
                onClick={() => {
                  setDisableMetadataV2Services((value) => !value);
                  markDirty();
                }}
                disabled={configSaving}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{disableMetadataV2Services ? 'Enabled' : 'Disabled'}</span>
              </button>
            </div>
          </div>

        <div className="settings-footer" />

          <div className="panel-head">
            <h3>Payment Settings</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Chain Environment</h4>
                <p>Settlement chain for payments. Contract addresses are resolved automatically.</p>
              </div>
              <select
                className="form-input settings-control"
                value={chainId}
                onChange={(e) => { setChainId(e.target.value); markDirty(); }}
              >
                <option value="base-mainnet">Base Mainnet</option>
                <option value="base-sepolia">Base Sepolia (testnet)</option>
                <option value="base-local">Base Local (development)</option>
              </select>
            </label>
          </div>

          <div className="settings-footer">
          {dirty && (
            <Button
              className="settings-save-btn"
              onClick={() => void handleSaveAndRestart()}
              disabled={configSaving}
            >
              {configSaving ? 'Saving...' : 'Save & Restart'}
            </Button>
          )}
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Services</h3>
          </div>
          <div className="settings-stack">
            {services.length === 0 ? (
              <p className="settings-note">No services available.</p>
            ) : services.map((plugin) => {
              const enabled = plugin.enabled ?? plugin.status.enabled;
              const active = plugin.active ?? false;
              const installed = plugin.installed ?? true;
              const stateLabel = active ? 'Active' : installed ? 'Inactive' : 'Not installed';
              const stateClass = active ? 'is-active' : installed ? 'is-inactive' : 'is-missing';
              return (
              <div key={plugin.name} className="settings-service">
                <div className="settings-item">
                  <div className="settings-copy">
                    <h4>
                      {plugin.displayName}
                      <span className={`settings-service-badge ${stateClass}`}>{stateLabel}</span>
                    </h4>
                    <p>{plugin.description}</p>
                  </div>
                  <button
                    type="button"
                    className={`settings-switch${enabled ? ' is-on' : ''}`}
                    aria-pressed={enabled}
                    onClick={() => void toggleService(plugin.name, !enabled)}
                    disabled={serviceBusy === plugin.name}
                  >
                    <span className="settings-switch-track">
                      <span className="settings-switch-thumb" />
                    </span>
                    <span className="settings-switch-label">{enabled ? 'On' : 'Off'}</span>
                  </button>
                </div>
                {enabled && !active ? (
                  <p className="settings-note settings-service-status">Enabled. It will start the next time the buyer runs.</p>
                ) : plugin.status.summary ? (
                  plugin.status.attention
                    ? <p className="settings-message error settings-service-status">{plugin.status.summary}</p>
                    : <p className="settings-note settings-service-status">{plugin.status.summary}</p>
                ) : null}
                {enabled && active && plugin.status.receiveAddress ? (
                  <div className="settings-receive">
                    <p className="settings-message warning">
                      {typeof plugin.status.receiveLimitUsdc === 'number' ? (
                        <>
                          <strong>Do not send more than {formatUsdc(plugin.status.receiveLimitUsdc)} USDC.</strong> That is your current deposit limit; anything above it stays in your wallet.
                        </>
                      ) : (
                        <>
                          <strong>Deposits are capped.</strong> Sending more than your current deposit limit leaves the excess in your wallet.
                        </>
                      )}
                    </p>
                    <p className="settings-note">
                      Send USDC on {chainLabel(chainId)} to this address to fund your wallet. Only send USDC on {chainLabel(chainId)}; other tokens or chains may be lost.
                    </p>
                    <div className="settings-receive-address">
                      <span>{plugin.status.receiveAddress}</span>
                      <ChatCopyButton
                        className="settings-copy-button"
                        text={plugin.status.receiveAddress}
                        ariaLabel="Copy wallet address"
                        tooltipLabel="Copy address"
                        copiedTooltipLabel="Copied!"
                      />
                    </div>
                    <div className="settings-receive-qr">
                      <QRCode value={plugin.status.receiveAddress} size={160} bgColor="#ffffff" fgColor="#000000" />
                    </div>
                  </div>
                ) : null}
              </div>
              );
            })}
            {serviceMessage ? <p className="settings-note">{serviceMessage}</p> : null}
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Desktop Preferences</h3>
          </div>
          <div className="settings-stack">
            <div className="settings-item">
              <div className="settings-copy">
                <h4>Developer Mode</h4>
                <p>Shows Connection, Peers, and Logs in the sidebar.</p>
              </div>
              <button
                type="button"
                className={`settings-switch${devMode ? ' is-on' : ''}`}
                aria-pressed={devMode}
                onClick={toggleDevMode}
                disabled={configSaving}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{devMode ? 'On' : 'Off'}</span>
              </button>
            </div>
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Voice Transcription</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Local Whisper model</h4>
                <p>Voice messages are transcribed locally. Tiny is bundled; Base is more accurate and downloads to this device.</p>
              </div>
              <select
                className="form-input settings-control"
                value={voiceStatus?.activeModel || 'tiny'}
                onChange={(e) => void handleVoiceModelChange(e.target.value)}
                disabled={!voiceStatus}
              >
                {(voiceStatus?.models || []).map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.installed}>
                    {model.label} {model.size}{model.installed ? '' : ' — not installed'}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-item">
              <div className="settings-copy">
                <h4>Better accuracy</h4>
                <p>Install Base multilingual for improved transcription quality. It is about 142 MB.</p>
              </div>
              <Button
                className="settings-save-btn"
                onClick={() => void handleInstallBaseModel()}
                disabled={voiceInstalling || voiceStatus?.models.some((model) => model.id === 'base' && model.installed)}
              >
                {voiceInstalling ? 'Installing…' : voiceStatus?.models.some((model) => model.id === 'base' && model.installed) ? 'Installed' : 'Install Base'}
              </Button>
            </div>
            {voiceMessage ? <p className="settings-note">{voiceMessage}</p> : null}
            {voiceStatus?.error ? <p className="settings-message error">{voiceStatus.error}</p> : null}
          </div>
        </article>

        {configMessage ? (
            <p className={`settings-message ${configMessage.type}`}>
              {configMessage.text}
            </p>
          ) : null}

      </div>
    </section>
  );
}
