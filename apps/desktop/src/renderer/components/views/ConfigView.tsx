import type { ViewModelProps } from '../types';

type ConfigViewProps = {
  vm: ViewModelProps['vm'];
};

export function ConfigView({ vm }: ConfigViewProps) {
  return (
    <section id="view-config" className={vm.viewClass(vm.shellState.activeView === 'config')} role="tabpanel">
      <div className="page-header">
        <h2>Settings</h2>
        <div className="page-header-right">
          <button id="configSaveBtn" onClick={() => void vm.saveConfig()} disabled={vm.configSaving}>{vm.configSaving ? 'Saving...' : 'Save'}</button>
          <div id="configMeta" className={vm.toneClass(vm.dashboardData.config.ok ? 'active' : 'warn')}>
            {vm.dashboardData.config.ok ? `${vm.safeArray(vm.safeRecord(vm.dashboardData.config.data).plugins).length} plugins` : 'config unavailable'}
          </div>
        </div>
      </div>
      <p id="configMessage" className="message">{vm.configMessage}</p>
      <div className="settings-sections">
        <article className="panel settings-panel">
          <div className="panel-head"><h3>Buyer Settings</h3></div>
          <div className="form-grid">
            <label className="form-label">Proxy Port
              <input id="cfgProxyPort" type="number" className="form-input" value={vm.settings.proxyPort} onChange={(event) => vm.setSettings((current) => ({ ...current, proxyPort: vm.safeNumber(event.target.value, 8377) }))} />
            </label>
            <label className="form-label">Preferred Providers (comma-separated)
              <input id="cfgPreferredProviders" type="text" className="form-input" value={vm.settings.preferredProviders} onChange={(event) => vm.setSettings((current) => ({ ...current, preferredProviders: event.target.value }))} />
            </label>
            <label className="form-label">Max Input Price (USD per 1M)
              <input id="cfgBuyerMaxInputUsdPerMillion" type="number" className="form-input" step="0.01" value={vm.settings.buyerMaxInputUsdPerMillion} onChange={(event) => vm.setSettings((current) => ({ ...current, buyerMaxInputUsdPerMillion: vm.safeNumber(event.target.value, 0) }))} />
            </label>
            <label className="form-label">Max Output Price (USD per 1M)
              <input id="cfgBuyerMaxOutputUsdPerMillion" type="number" className="form-input" step="0.01" value={vm.settings.buyerMaxOutputUsdPerMillion} onChange={(event) => vm.setSettings((current) => ({ ...current, buyerMaxOutputUsdPerMillion: vm.safeNumber(event.target.value, 0) }))} />
            </label>
            <label className="form-label">Min Peer Reputation (0-100)
              <input id="cfgMinRep" type="number" className="form-input" min={0} max={100} value={vm.settings.minRep} onChange={(event) => vm.setSettings((current) => ({ ...current, minRep: vm.safeNumber(event.target.value, 0) }))} />
            </label>
          </div>
        </article>
        <article className="panel settings-panel">
          <div className="panel-head"><h3>Payment Settings</h3></div>
          <div className="form-grid">
            <label className="form-label">Preferred Payment Method
              <select id="cfgPaymentMethod" className="form-input" value={vm.settings.paymentMethod} onChange={(event) => vm.setSettings((current) => ({ ...current, paymentMethod: event.target.value }))}>
                <option value="crypto">Crypto (USDC)</option>
              </select>
            </label>
          </div>
        </article>
      </div>
    </section>
  );
}
