import React, { useEffect, useState } from 'react';
import { ConfigResponse } from './api-types';
import { debugError } from '../utils/debug';

interface FormSection {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: FormSection) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Settings() {
  const [config, setConfig] = useState<ConfigResponse['config'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ConfigResponse) => setConfig(data.config))
      .catch(debugError);
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setMessage('Configuration saved successfully');
      } else {
        setMessage('Failed to save configuration');
      }
    } catch {
      setMessage('Error saving configuration');
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <div className="loading">Loading...</div>;

  return (
    <div className="settings-page">
      <div className="page-header">
        <h2>Settings</h2>
        <button
          className="save-btn"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {message && <div className="settings-message">{message}</div>}

      <Section title="Seller Settings">
        <label className="form-label">
          Reserve Floor (msg/hr)
          <input
            type="number"
            className="form-input"
            value={config.seller.reserveFloor}
            onChange={(e) =>
              setConfig({
                ...config,
                seller: { ...config.seller, reserveFloor: parseInt(e.target.value) || 0 },
              })
            }
          />
        </label>
        <label className="form-label">
          Input Price (USD per 1M tokens)
          <input
            type="number"
            className="form-input"
            step="0.01"
            value={config.seller.pricing.defaults.inputUsdPerMillion}
            onChange={(e) =>
              setConfig({
                ...config,
                seller: {
                  ...config.seller,
                  pricing: {
                    ...config.seller.pricing,
                    defaults: {
                      ...config.seller.pricing.defaults,
                      inputUsdPerMillion: parseFloat(e.target.value) || 0,
                    },
                  },
                },
              })
            }
          />
        </label>
        <label className="form-label">
          Output Price (USD per 1M tokens)
          <input
            type="number"
            className="form-input"
            step="0.01"
            value={config.seller.pricing.defaults.outputUsdPerMillion}
            onChange={(e) =>
              setConfig({
                ...config,
                seller: {
                  ...config.seller,
                  pricing: {
                    ...config.seller.pricing,
                    defaults: {
                      ...config.seller.pricing.defaults,
                      outputUsdPerMillion: parseFloat(e.target.value) || 0,
                    },
                  },
                },
              })
            }
          />
        </label>
        <label className="form-label">
          Max Concurrent Buyers
          <input
            type="number"
            className="form-input"
            value={config.seller.maxConcurrentBuyers}
            onChange={(e) =>
              setConfig({
                ...config,
                seller: { ...config.seller, maxConcurrentBuyers: parseInt(e.target.value) || 1 },
              })
            }
          />
        </label>
      </Section>

      <Section title="Buyer Settings">
        <label className="form-label">
          Proxy Port
          <input
            type="number"
            className="form-input"
            value={config.buyer.proxyPort}
            onChange={(e) =>
              setConfig({
                ...config,
                buyer: { ...config.buyer, proxyPort: parseInt(e.target.value) || 8080 },
              })
            }
          />
        </label>
        <label className="form-label">
          Max Input Price (USD per 1M tokens)
          <input
            type="number"
            className="form-input"
            step="0.01"
            value={config.buyer.maxPricing.defaults.inputUsdPerMillion}
            onChange={(e) =>
              setConfig({
                ...config,
                buyer: {
                  ...config.buyer,
                  maxPricing: {
                    ...config.buyer.maxPricing,
                    defaults: {
                      ...config.buyer.maxPricing.defaults,
                      inputUsdPerMillion: parseFloat(e.target.value) || 0,
                    },
                  },
                },
              })
            }
          />
        </label>
        <label className="form-label">
          Max Output Price (USD per 1M tokens)
          <input
            type="number"
            className="form-input"
            step="0.01"
            value={config.buyer.maxPricing.defaults.outputUsdPerMillion}
            onChange={(e) =>
              setConfig({
                ...config,
                buyer: {
                  ...config.buyer,
                  maxPricing: {
                    ...config.buyer.maxPricing,
                    defaults: {
                      ...config.buyer.maxPricing.defaults,
                      outputUsdPerMillion: parseFloat(e.target.value) || 0,
                    },
                  },
                },
              })
            }
          />
        </label>
        <label className="form-label">
          Min Peer Reputation (0-100)
          <input
            type="number"
            className="form-input"
            step="1"
            min="0"
            max="100"
            value={config.buyer.minPeerReputation}
            onChange={(e) =>
              setConfig({
                ...config,
                buyer: { ...config.buyer, minPeerReputation: parseInt(e.target.value, 10) || 0 },
              })
            }
          />
        </label>
      </Section>

      <Section title="Payment Settings">
        <label className="form-label">
          Preferred Payment Method
          <select
            className="form-input"
            value={config.payments.preferredMethod}
            onChange={(e) =>
              setConfig({
                ...config,
                payments: { ...config.payments, preferredMethod: e.target.value as 'crypto' },
              })
            }
          >
            <option value="crypto">Crypto (USDC)</option>
          </select>
        </label>
      </Section>
    </div>
  );
}
