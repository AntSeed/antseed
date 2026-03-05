import { memo } from 'react';

type ConfigViewProps = {
  active: boolean;
};

const ConfigContent = memo(function ConfigContent() {
  return (
    <>
      <div className="page-header">
        <h2>Settings</h2>
        <div className="page-header-right">
          <button id="configSaveBtn">Save</button>
          <div id="configMeta" className="connection-badge badge-idle">
            Redacted
          </div>
        </div>
      </div>
      <p id="configMessage" className="message">
        Loading config...
      </p>

      <div className="settings-sections">
        <article className="panel settings-panel">
          <div className="panel-head">
            <h3>Buyer Settings</h3>
          </div>
          <div className="form-grid">
            <label className="form-label">
              Proxy Port
              <input id="cfgProxyPort" type="number" className="form-input" defaultValue="8080" />
            </label>
            <label className="form-label">
              Preferred Providers (comma-separated)
              <input id="cfgPreferredProviders" type="text" className="form-input" defaultValue="" />
            </label>
            <label className="form-label">
              Max Input Price (USD per 1M)
              <input
                id="cfgBuyerMaxInputUsdPerMillion"
                type="number"
                className="form-input"
                step="0.01"
                defaultValue="0"
              />
            </label>
            <label className="form-label">
              Max Output Price (USD per 1M)
              <input
                id="cfgBuyerMaxOutputUsdPerMillion"
                type="number"
                className="form-input"
                step="0.01"
                defaultValue="0"
              />
            </label>
            <label className="form-label">
              Min Peer Reputation (0-100)
              <input id="cfgMinRep" type="number" className="form-input" min="0" max="100" defaultValue="0" />
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
              <select id="cfgPaymentMethod" className="form-input" defaultValue="crypto">
                <option value="crypto">Crypto (USDC)</option>
              </select>
            </label>
          </div>
        </article>
      </div>
    </>
  );
});

export function ConfigView({ active }: ConfigViewProps) {
  return (
    <section id="view-config" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <ConfigContent />
    </section>
  );
}
