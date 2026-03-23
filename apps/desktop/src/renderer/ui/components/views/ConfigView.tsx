import { useState, useEffect, useCallback } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';

type ConfigViewProps = {
  active: boolean;
};

export function ConfigView({ active }: ConfigViewProps) {
  const { configFormData, configSaving, devMode, configMessage } = useUiSnapshot();
  const actions = useActions();

  // Local form state — initialized from config, edited locally, saved on button click
  const [proxyPort, setProxyPort] = useState('8377');
  const [maxInput, setMaxInput] = useState('0');
  const [maxOutput, setMaxOutput] = useState('0');
  const [minRep, setMinRep] = useState('0');
  const [requireManualApproval, setRequireManualApproval] = useState(false);
  const [chainId, setChainId] = useState('');
  const [rpcUrl, setRpcUrl] = useState('');
  const [escrowAddress, setEscrowAddress] = useState('');
  const [usdcAddress, setUsdcAddress] = useState('');
  const [dirty, setDirty] = useState(false);

  // Sync from config on first load only
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (configFormData && !initialized) {
      setProxyPort(String(configFormData.proxyPort));
      setMaxInput(String(configFormData.maxInputUsdPerMillion));
      setMaxOutput(String(configFormData.maxOutputUsdPerMillion));
      setMinRep(String(configFormData.minRep));
      setRequireManualApproval(configFormData.requireManualApproval);
      setChainId(configFormData.cryptoChainId);
      setRpcUrl(configFormData.cryptoRpcUrl);
      setEscrowAddress(configFormData.cryptoEscrowAddress);
      setUsdcAddress(configFormData.cryptoUsdcAddress);
      setInitialized(true);
    }
  }, [configFormData, initialized]);

  const markDirty = useCallback(() => setDirty(true), []);

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
      maxInputUsdPerMillion: parseFloat(maxInput) || 0,
      maxOutputUsdPerMillion: parseFloat(maxOutput) || 0,
      minRep: parseInt(minRep, 10) || 0,
      requireManualApproval,
      cryptoChainId: chainId,
      cryptoRpcUrl: rpcUrl,
      cryptoEscrowAddress: escrowAddress,
      cryptoUsdcAddress: usdcAddress,
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
                <h4>Max Input Price</h4>
                <p>Highest input token price you will accept (USD per 1M tokens).</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                step="0.01"
                value={maxInput}
                onChange={(e) => { setMaxInput(e.target.value); markDirty(); }}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Max Output Price</h4>
                <p>Highest output token price you will accept (USD per 1M tokens).</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                step="0.01"
                value={maxOutput}
                onChange={(e) => { setMaxOutput(e.target.value); markDirty(); }}
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
          </div>

          <div className="settings-footer" />
        
          <div className="panel-head">
            <h3>Payment Settings</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Chain</h4>
                <p>Chain ID for payment settlement (e.g. base-sepolia, base-mainnet, base-local).</p>
              </div>
              <input
                type="text"
                className="form-input settings-control"
                value={chainId}
                placeholder="base-sepolia"
                onChange={(e) => { setChainId(e.target.value); markDirty(); }}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <h4>RPC URL</h4>
                <p>JSON-RPC endpoint for the settlement chain.</p>
              </div>
              <input
                type="text"
                className="form-input settings-control"
                value={rpcUrl}
                placeholder="https://sepolia.base.org"
                onChange={(e) => { setRpcUrl(e.target.value); markDirty(); }}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <h4>Escrow Contract</h4>
                <p>AntseedEscrow contract address.</p>
              </div>
              <input
                type="text"
                className="form-input settings-control"
                value={escrowAddress}
                placeholder="0x..."
                onChange={(e) => { setEscrowAddress(e.target.value); markDirty(); }}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <h4>USDC Contract</h4>
                <p>USDC token contract address on the settlement chain.</p>
              </div>
              <input
                type="text"
                className="form-input settings-control"
                value={usdcAddress}
                placeholder="0x..."
                onChange={(e) => { setUsdcAddress(e.target.value); markDirty(); }}
              />
            </label>
          </div>

          <div className="settings-footer">
          {dirty && (
            <button
              className="settings-save-btn"
              onClick={() => void handleSaveAndRestart()}
              disabled={configSaving}
            >
              {configSaving ? 'Saving...' : 'Save & Restart'}
            </button>
          )}
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Desktop Preferences</h3>
          </div>
          <div className="settings-stack">
            <div className="settings-item">
              <div className="settings-copy">
                <h4>Manual Approval</h4>
                <p>When enabled, you'll see a confirmation card before authorizing payment to a new peer.</p>
              </div>
              <button
                type="button"
                className={`settings-switch${requireManualApproval ? ' is-on' : ''}`}
                aria-pressed={requireManualApproval}
                onClick={() => { setRequireManualApproval((v) => !v); markDirty(); }}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{requireManualApproval ? 'On' : 'Off'}</span>
              </button>
            </div>
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

        {configMessage ? (
            <p className={`settings-message ${configMessage.type}`}>
              {configMessage.text}
            </p>
          ) : null}

      </div>
    </section>
  );
}
