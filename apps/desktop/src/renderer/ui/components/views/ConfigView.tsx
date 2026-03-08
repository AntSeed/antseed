import { useState, useEffect } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';

type ConfigViewProps = {
  active: boolean;
};

export function ConfigView({ active }: ConfigViewProps) {
  const { configMeta, configMessage, configFormData, configSaving, devMode: currentDevMode } = useUiSnapshot();

  const [proxyPort, setProxyPort] = useState('8377');
  const [preferredProviders, setPreferredProviders] = useState('');
  const [maxInput, setMaxInput] = useState('0');
  const [maxOutput, setMaxOutput] = useState('0');
  const [minRep, setMinRep] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState('crypto');
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    if (configFormData) {
      setProxyPort(String(configFormData.proxyPort));
      setPreferredProviders(configFormData.preferredProviders);
      setMaxInput(String(configFormData.maxInputUsdPerMillion));
      setMaxOutput(String(configFormData.maxOutputUsdPerMillion));
      setMinRep(String(configFormData.minRep));
      setPaymentMethod(configFormData.paymentMethod);
      setDevMode(configFormData.devMode);
      return;
    }

    setDevMode(currentDevMode);
  }, [configFormData, currentDevMode]);

  const actions = useActions();

  function handleSave() {
    void actions.saveConfig({
      proxyPort: parseInt(proxyPort, 10) || 8377,
      preferredProviders,
      maxInputUsdPerMillion: parseFloat(maxInput) || 0,
      maxOutputUsdPerMillion: parseFloat(maxOutput) || 0,
      minRep: parseInt(minRep, 10) || 0,
      paymentMethod: paymentMethod || 'crypto',
      devMode,
    });
  }

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Settings</h2>
        {/* <div className="page-header-right">
          <div className={`connection-badge badge-${configMeta.tone}`}>{configMeta.label}</div>
        </div> */}
      </div>

      <div className="settings-sections">
        <article className="panel settings-panel settings-panel-hidden" aria-hidden="true">
          <div className="panel-head">
            <h3>Buyer Settings</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Runtime</span>
                <h4>Proxy Port</h4>
                <p>Local port used by the buyer proxy for model routing and chat requests.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
                tabIndex={-1}
              />
            </label>
            <label className="settings-item settings-item-wide">
              <div className="settings-copy">
                <span className="settings-kicker">Routing</span>
                <h4>Preferred Providers</h4>
                <p>Ordered provider preference list, separated by commas.</p>
              </div>
              <input
                type="text"
                className="form-input settings-control"
                value={preferredProviders}
                onChange={(e) => setPreferredProviders(e.target.value)}
                tabIndex={-1}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Pricing</span>
                <h4>Max Input Price</h4>
                <p>Highest input token price you will accept, in USD per 1M tokens.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                step="0.01"
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
                tabIndex={-1}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Pricing</span>
                <h4>Max Output Price</h4>
                <p>Highest output token price you will accept, in USD per 1M tokens.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                step="0.01"
                value={maxOutput}
                onChange={(e) => setMaxOutput(e.target.value)}
                tabIndex={-1}
              />
            </label>
            <label className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Trust</span>
                <h4>Minimum Peer Reputation</h4>
                <p>Peers below this score are excluded from routing.</p>
              </div>
              <input
                type="number"
                className="form-input settings-control"
                min="0"
                max="100"
                value={minRep}
                onChange={(e) => setMinRep(e.target.value)}
                tabIndex={-1}
              />
            </label>
          </div>
        </article>

        <article className="panel settings-panel settings-panel-hidden" aria-hidden="true">
          <div className="panel-head">
            <h3>Payment Settings</h3>
          </div>
          <div className="settings-stack">
            <label className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Settlement</span>
                <h4>Preferred Payment Method</h4>
                <p>Current desktop flow supports crypto settlement.</p>
              </div>
              <select
                className="form-input settings-control"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                tabIndex={-1}
              >
                <option value="crypto">Crypto (USDC)</option>
              </select>
            </label>
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Desktop Preferences</h3>
          </div>
          <div className="settings-stack">
            <div className="settings-item">
              <div className="settings-copy">
                <span className="settings-kicker">Navigation</span>
                <h4>Developer Mode</h4>
                <p>Shows Connection, Peers, and Logs in the sidebar for diagnostics and local debugging.</p>
              </div>
              <button
                type="button"
                className={`settings-switch${devMode ? ' is-on' : ''}`}
                aria-pressed={devMode}
                onClick={() => setDevMode((value) => !value)}
              >
                <span className="settings-switch-track">
                  <span className="settings-switch-thumb" />
                </span>
                <span className="settings-switch-label">{devMode ? 'On' : 'Off'}</span>
              </button>
            </div>
          </div>

          <div className="settings-footer">
            {/* <p className="settings-note">
              Additional buyer and payment settings are temporarily hidden while this screen is being simplified.
            </p> */}
            {/* configMessage ? (
              <p className={`settings-message ${configMessage.type}`}>
                {configMessage.text}
              </p>
            ) : null */}
            <button className="settings-save-btn" onClick={handleSave} disabled={configSaving}>
              {configSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}
