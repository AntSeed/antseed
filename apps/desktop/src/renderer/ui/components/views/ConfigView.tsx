import { useState, useEffect } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import type { ConfigFormData } from '../../../core/state';

type ConfigViewProps = {
  active: boolean;
};

export function ConfigView({ active }: ConfigViewProps) {
  const { configMeta, configMessage, configFormData, configSaving } = useUiSnapshot();

  const [proxyPort, setProxyPort] = useState('8377');
  const [preferredProviders, setPreferredProviders] = useState('');
  const [maxInput, setMaxInput] = useState('0');
  const [maxOutput, setMaxOutput] = useState('0');
  const [minRep, setMinRep] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState('crypto');

  useEffect(() => {
    if (configFormData) {
      setProxyPort(String(configFormData.proxyPort));
      setPreferredProviders(configFormData.preferredProviders);
      setMaxInput(String(configFormData.maxInputUsdPerMillion));
      setMaxOutput(String(configFormData.maxOutputUsdPerMillion));
      setMinRep(String(configFormData.minRep));
      setPaymentMethod(configFormData.paymentMethod);
    }
  }, [configFormData]);

  const actions = useActions();

  function handleSave() {
    void actions.saveConfig({
      proxyPort: parseInt(proxyPort, 10) || 8377,
      preferredProviders,
      maxInputUsdPerMillion: parseFloat(maxInput) || 0,
      maxOutputUsdPerMillion: parseFloat(maxOutput) || 0,
      minRep: parseInt(minRep, 10) || 0,
      paymentMethod: paymentMethod || 'crypto',
    });
  }

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Settings</h2>
        <div className="page-header-right">
          <button onClick={handleSave} disabled={configSaving}>
            {configSaving ? 'Saving...' : 'Save'}
          </button>
          <div className={`connection-badge badge-${configMeta.tone}`}>{configMeta.label}</div>
        </div>
      </div>
      <p className={`message${configMessage?.type ? ` settings-message ${configMessage.type}` : ''}`}>
        {configMessage?.text ?? 'Loading config...'}
      </p>

      <div className="settings-sections">
        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Buyer Settings</h3>
          </div>
          <div className="form-grid">
            <label className="form-label">
              Proxy Port
              <input
                type="number"
                className="form-input"
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
              />
            </label>
            <label className="form-label">
              Preferred Providers (comma-separated)
              <input
                type="text"
                className="form-input"
                value={preferredProviders}
                onChange={(e) => setPreferredProviders(e.target.value)}
              />
            </label>
            <label className="form-label">
              Max Input Price (USD per 1M)
              <input
                type="number"
                className="form-input"
                step="0.01"
                value={maxInput}
                onChange={(e) => setMaxInput(e.target.value)}
              />
            </label>
            <label className="form-label">
              Max Output Price (USD per 1M)
              <input
                type="number"
                className="form-input"
                step="0.01"
                value={maxOutput}
                onChange={(e) => setMaxOutput(e.target.value)}
              />
            </label>
            <label className="form-label">
              Min Peer Reputation (0-100)
              <input
                type="number"
                className="form-input"
                min="0"
                max="100"
                value={minRep}
                onChange={(e) => setMinRep(e.target.value)}
              />
            </label>
          </div>
        </article>

        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Payment Settings</h3>
          </div>
          <div className="form-grid">
            <label className="form-label">
              Preferred Payment Method
              <select
                className="form-input"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                <option value="crypto">Crypto (USDC)</option>
              </select>
            </label>
          </div>
        </article>
      </div>
    </section>
  );
}
