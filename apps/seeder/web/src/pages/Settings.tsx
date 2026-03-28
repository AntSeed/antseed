import { useState, useEffect } from 'react';
import { fetchJson } from '../api';

interface NodeConfig {
  identity: { displayName: string; walletAddress?: string };
  seller: {
    reserveFloor: number;
    maxConcurrentBuyers: number;
    enabledProviders: string[];
    pricing: {
      defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number };
    };
  };
  buyer: {
    maxPricing: { defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number } };
    minPeerReputation: number;
    proxyPort: number;
  };
  payments: {
    preferredMethod: string;
    platformFeeRate: number;
    crypto?: {
      chainId: string;
      rpcUrl: string;
      depositsContractAddress: string;
      usdcContractAddress: string;
    };
  };
  network: { bootstrapNodes: string[] };
}

export function Settings() {
  const [config, setConfig] = useState<NodeConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    fetchJson<{ config: NodeConfig }>('/api/node-config').then(d => setConfig(d.config)).catch(() => {});
  }, []);

  const updateField = (path: string, value: unknown) => {
    if (!config) return;
    const clone = JSON.parse(JSON.stringify(config));
    const parts = path.split('.');
    let obj = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in obj)) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    setConfig(clone);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await fetchJson('/api/node-config', {
        method: 'PUT',
        body: JSON.stringify({
          seller: config.seller,
          buyer: config.buyer,
          payments: config.payments,
          network: config.network,
        }),
      });
      setSaveResult({ ok: true });
    } catch (err) {
      setSaveResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <div style={{ color: 'var(--text-muted)', padding: 40 }}>Loading config...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {saveResult && (
        <div className={`status-msg ${saveResult.ok ? 'status-success' : 'status-error'}`} style={{ marginBottom: 16 }}>
          {saveResult.ok ? 'Configuration saved' : `Error: ${saveResult.error}`}
        </div>
      )}

      <div className="two-col section">
        {/* Seller settings */}
        <div className="card">
          <div className="card-section-title">Seller</div>
          <div className="input-group">
            <label className="input-label">Reserve Floor (USDC)</label>
            <input className="input-field" type="number" value={config.seller.reserveFloor}
              onChange={e => updateField('seller.reserveFloor', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="input-group">
            <label className="input-label">Max Concurrent Buyers</label>
            <input className="input-field" type="number" value={config.seller.maxConcurrentBuyers}
              onChange={e => updateField('seller.maxConcurrentBuyers', parseInt(e.target.value) || 1)} />
          </div>
          <div className="input-group">
            <label className="input-label">Input Price ($/1M tokens)</label>
            <input className="input-field" type="number" value={config.seller.pricing.defaults.inputUsdPerMillion}
              onChange={e => updateField('seller.pricing.defaults.inputUsdPerMillion', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="input-group">
            <label className="input-label">Output Price ($/1M tokens)</label>
            <input className="input-field" type="number" value={config.seller.pricing.defaults.outputUsdPerMillion}
              onChange={e => updateField('seller.pricing.defaults.outputUsdPerMillion', parseFloat(e.target.value) || 0)} />
          </div>
        </div>

        {/* Buyer settings */}
        <div className="card">
          <div className="card-section-title">Buyer</div>
          <div className="input-group">
            <label className="input-label">Proxy Port</label>
            <input className="input-field" type="number" value={config.buyer.proxyPort}
              onChange={e => updateField('buyer.proxyPort', parseInt(e.target.value) || 8080)} />
          </div>
          <div className="input-group">
            <label className="input-label">Min Peer Reputation</label>
            <input className="input-field" type="number" step="0.1" value={config.buyer.minPeerReputation}
              onChange={e => updateField('buyer.minPeerReputation', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="input-group">
            <label className="input-label">Max Input Price ($/1M tokens)</label>
            <input className="input-field" type="number" value={config.buyer.maxPricing.defaults.inputUsdPerMillion}
              onChange={e => updateField('buyer.maxPricing.defaults.inputUsdPerMillion', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="input-group">
            <label className="input-label">Max Output Price ($/1M tokens)</label>
            <input className="input-field" type="number" value={config.buyer.maxPricing.defaults.outputUsdPerMillion}
              onChange={e => updateField('buyer.maxPricing.defaults.outputUsdPerMillion', parseFloat(e.target.value) || 0)} />
          </div>
        </div>
      </div>

      {/* Payment config */}
      <div className="card section">
        <div className="card-section-title">Chain Configuration</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="input-group">
            <label className="input-label">Chain ID</label>
            <input className="input-field" value={config.payments.crypto?.chainId ?? ''}
              onChange={e => updateField('payments.crypto.chainId', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">RPC URL</label>
            <input className="input-field" value={config.payments.crypto?.rpcUrl ?? ''}
              onChange={e => updateField('payments.crypto.rpcUrl', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Deposits Contract</label>
            <input className="input-field mono" value={config.payments.crypto?.depositsContractAddress ?? ''}
              onChange={e => updateField('payments.crypto.depositsContractAddress', e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">USDC Contract</label>
            <input className="input-field mono" value={config.payments.crypto?.usdcContractAddress ?? ''}
              onChange={e => updateField('payments.crypto.usdcContractAddress', e.target.value)} />
          </div>
        </div>
      </div>
    </div>
  );
}
