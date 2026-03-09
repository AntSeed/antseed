import {useEffect, useState, useMemo} from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './network.module.css';

const STATS_URL = 'https://network.antseed.com/stats';
const DEV_STATS_URL = 'http://localhost:4000/stats';

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
}

interface StatsResponse {
  peers: PeerInfo[];
  updatedAt: string;
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
      {peer.providers[0]?.currentLoad !== undefined && (
        <div className={styles.peerMeta}>
          <span>Load: {peer.providers[0].currentLoad}/{peer.providers[0].maxConcurrency}</span>
        </div>
      )}
    </div>
  );
}

export default function NetworkPage() {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      // Try production URL first, then dev
      for (const url of [STATS_URL, DEV_STATS_URL]) {
        try {
          const res = await fetch(url, {signal: AbortSignal.timeout(5000)});
          if (!res.ok) continue;
          const data = (await res.json()) as StatsResponse;
          setPeers(data.peers);
          setUpdatedAt(data.updatedAt);
          setLoading(false);
          setError(false);
          return;
        } catch { /* try next */ }
      }
      setLoading(false);
      setError(true);
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, []);

  const allModels = useMemo(() => {
    const set = new Set<string>();
    for (const p of peers) for (const pr of p.providers) for (const m of pr.models) set.add(m);
    return set;
  }, [peers]);

  const updatedLabel = updatedAt
    ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : null;

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
              {error ? 'Offline' : 'Live'}
            </div>
            <div className={styles.statLabel}>
              {updatedLabel ?? (loading ? 'Connecting...' : 'Unable to reach stats server')}
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
            <div className={styles.loading}>{error ? 'Could not reach the network stats server.' : 'No peers found'}</div>
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
