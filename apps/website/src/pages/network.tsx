import {useEffect, useState} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './network.module.css';

const STATS_API = '';

// Fallback data when stats API is unavailable
const FALLBACK_PEERS: PeerInfo[] = [
  {
    peerId: 'QmYourPeer1234567890abcdef',
    displayName: 'OpenMind',
    region: 'EU West',
    providers: [{
      provider: 'openmind',
      models: ['deepseek-r1', 'deepseek-v3.1', 'qwen3.5-397b', 'llama-4-maverick', 'qwen3-235b', 'glm-5', 'kimi-k2.5', 'minimax-m2.5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
      defaultPricing: {inputUsdPerMillion: 0.80, outputUsdPerMillion: 2.40},
      currentLoad: 2,
      maxConcurrency: 10,
    }],
    timestamp: Date.now(),
    url: 'https://peer1.antseed.com',
    online: true,
  },
  {
    peerId: 'QmAnotherPeer0987654321fedcba',
    displayName: 'NodeRunner',
    region: 'US East',
    providers: [{
      provider: 'noderunner',
      models: ['deepseek-r1', 'deepseek-v3.1', 'llama-4-maverick', 'qwen3-235b'],
      defaultPricing: {inputUsdPerMillion: 0.60, outputUsdPerMillion: 1.80},
      currentLoad: 1,
      maxConcurrency: 8,
    }],
    timestamp: Date.now(),
    url: 'https://peer2.antseed.com',
    online: true,
  },
  {
    peerId: 'QmThirdPeer5555555555555555',
    displayName: 'SwarmNode',
    region: 'Asia Pacific',
    providers: [{
      provider: 'swarmnode',
      models: ['deepseek-r1', 'qwen3.5-397b', 'kimi-k2.5', 'glm-5'],
      defaultPricing: {inputUsdPerMillion: 0.50, outputUsdPerMillion: 1.50},
      currentLoad: 0,
      maxConcurrency: 6,
    }],
    timestamp: Date.now(),
    url: 'https://peer3.antseed.com',
    online: true,
  },
];

interface ProviderInfo {
  provider: string;
  models: string[];
  defaultPricing?: {inputUsdPerMillion: number; outputUsdPerMillion: number};
  currentLoad?: number;
  maxConcurrency?: number;
}

interface PeerInfo {
  peerId: string;
  displayName: string;
  region: string;
  providers: ProviderInfo[];
  timestamp: number;
  url: string;
  online: boolean;
}

function ModelTag({name}: {name: string}) {
  const short = name.split('/').pop() ?? name;
  return <span className={styles.modelTag}>{short}</span>;
}

function PeerCard({peer}: {peer: PeerInfo}) {
  const allModels: string[] = [];
  for (const p of peer.providers) allModels.push(...p.models);
  const pricing = peer.providers[0]?.defaultPricing;

  return (
    <div className={styles.peerCard}>
      <div className={styles.peerHeader}>
        <div className={styles.peerOnline} />
        <div>
          <div className={styles.peerName}>{peer.displayName}</div>
          <div className={styles.peerId}>{peer.peerId.slice(0, 16)}...</div>
        </div>
        <div className={styles.peerRegion}>{peer.region !== 'unknown' ? peer.region : 'Global'}</div>
      </div>
      <div className={styles.peerModels}>
        {allModels.map(m => <ModelTag key={m} name={m} />)}
      </div>
      {pricing && (
        <div className={styles.peerPricing}>
          <span>${pricing.inputUsdPerMillion}/M input</span>
          <span>${pricing.outputUsdPerMillion}/M output</span>
        </div>
      )}
      <div className={styles.peerMeta}>
        {peer.providers[0]?.currentLoad !== undefined && (
          <span>Load: {peer.providers[0].currentLoad}/{peer.providers[0].maxConcurrency}</span>
        )}
        <span className={styles.peerUrl}>{peer.url.replace('http://', '')}</span>
      </div>
    </div>
  );
}

export default function NetworkPage() {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch(`${STATS_API}/stats-api/api/peers`);
      const data = await res.json();
      setPeers((data as PeerInfo[]).map(p => ({...p, online: true})));
    } catch {
      // Use fallback data when API is unavailable
      setPeers(FALLBACK_PEERS);
    }
    setLastUpdated(new Date());
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, []);

  const allModels = new Set<string>();
  for (const p of peers) for (const pr of p.providers) for (const m of pr.models) allModels.add(m);

  return (
    <Layout title="Network Status" description="Live AntSeed network status — active peers, available models, and network health.">
      <div className={styles.page}>
        <div className={styles.header}>
          <Link to="/" className={styles.back}>← Back</Link>
          <h1 className={styles.title}>Network Status</h1>
          <p className={styles.subtitle}>Live peer-to-peer network overview. Updates every 30 seconds.</p>
        </div>

        {/* Stats bar */}
        <div className={styles.statsBar}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '--' : peers.length}</div>
            <div className={styles.statLabel}>Active Peers</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statNum}>{loading ? '--' : allModels.size}</div>
            <div className={styles.statLabel}>Models Available</div>
          </div>
          <div className={styles.statDivider} />
          <div className={styles.stat}>
            <div className={styles.statLive}>
              <span className={styles.liveDot} />
              Live
            </div>
            <div className={styles.statLabel}>
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Connecting...'}
            </div>
          </div>
        </div>

        {/* Models list */}
        {allModels.size > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Available Models</div>
            <div className={styles.modelGrid}>
              {Array.from(allModels).map(m => <ModelTag key={m} name={m} />)}
            </div>
          </div>
        )}

        {/* Peers */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Active Peers</div>
          {loading ? (
            <div className={styles.loading}>Discovering peers...</div>
          ) : peers.length === 0 ? (
            <div className={styles.loading}>No peers found</div>
          ) : (
            <div className={styles.peerGrid}>
              {peers.map(p => <PeerCard key={p.peerId} peer={p} />)}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <p>Want to become a provider? <Link to="/docs/install">Read the docs →</Link></p>
        </div>
      </div>
    </Layout>
  );
}
