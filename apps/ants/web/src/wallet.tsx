import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { WagmiProvider, useAccount, useWalletClient } from 'wagmi';
import { getDefaultConfig, RainbowKitProvider, ConnectButton } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defineChain, http } from 'viem';
import { request, type DashboardConfig } from './api';
import { invalidateAll } from './data';
import { useJobs } from './jobs';
import type { BrowserTransaction } from '../../src/browser-signer';
import '@rainbow-me/rainbowkit/styles.css';

const queries = new QueryClient();
// The workspace also contains React 19; wagmi declarations resolve that peer. Runtime is deduped by Vite.
const WalletRoot = WagmiProvider as unknown as ComponentType<{ config: ReturnType<typeof getDefaultConfig>; children: ReactNode }>;
export function WalletProvider({ config, children }: { config: DashboardConfig; children: ReactNode }) {
  const wagmi = useMemo(() => getDefaultConfig({
    appName: 'AntSeed Staking', projectId: '9a1851410cb5589bc351a6dabf17140e',
    chains: [defineChain({ id: config.evmChainId, name: config.chainId, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.walletRpcUrl ?? (config.evmChainId === 8453 ? 'https://mainnet.base.org' : config.evmChainId === 84532 ? 'https://sepolia.base.org' : 'http://127.0.0.1:8545')] } } })],
    transports: { [config.evmChainId]: http() },
  }), [config.chainId, config.evmChainId, config.walletRpcUrl]);
  if (!config.browserWallet) return <>{children}</>;
  return <WalletRoot config={wagmi}><QueryClientProvider client={queries}><RainbowKitProvider>{children}</RainbowKitProvider></QueryClientProvider></WalletRoot>;
}

/** Sync wallet identity before enabling jobs. Every transaction has an explicit wallet approval. */
export function WalletControls({ config }: { config: DashboardConfig }) {
  const account = useAccount();
  const { jobs, running } = useJobs();
  const action = jobs.find(job => job.status === 'running');
  const { data: wallet } = useWalletClient();
  const [pending, setPending] = useState<BrowserTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const processing = useRef(false);
  const syncedIdentity = useRef<string | null>(null);
  const syncQueue = useRef<Promise<void>>(Promise.resolve());
  const submitted = useRef(new Map<string, string>());
  const wrongChain = !!account.address && account.chainId !== config.evmChainId;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const identity = `${account.address?.toLowerCase() ?? ''}:${account.chainId ?? ''}`;
    let queued = false;
    function sync(refresh = false) {
      if (queued || stopped) return;
      queued = true;
      // Serialize account updates so a slow request for the previous wallet cannot win.
      syncQueue.current = syncQueue.current.catch(() => {}).then(async () => {
        if (stopped) return;
        try {
          const refreshAccount = refresh && !wrongChain;
          const result = await request<{ changed?: boolean }>('/api/wallet', { method: 'POST', body: { address: wrongChain ? undefined : account.address, chainId: account.chainId, refresh: refreshAccount } });
          if (!stopped) {
            const changed = result.changed ?? (syncedIdentity.current !== identity);
            syncedIdentity.current = identity;
            setError(null);
            if (changed || refreshAccount) invalidateAll({ clear: changed });
          }
        } catch (e) {
          if (!stopped) { setError(e instanceof Error ? e.message : String(e)); timer = setTimeout(() => sync(refresh), 1500); }
        } finally { queued = false; }
      });
    }
    void sync();
    const onFocus = () => { void sync(true); };
    window.addEventListener('focus', onFocus);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [account.address, account.chainId, wrongChain]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await request<BrowserTransaction | null>('/api/wallet/request'); if (!stopped) setPending(next); }
      catch { /* Normal API surfaces handle server errors. */ }
      finally {
        // Keep slow idle discovery for actions from another tab; active jobs poll promptly.
        if (!stopped) timer = setTimeout(() => void poll(), running || pending !== null ? 1000 : 30_000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, pending !== null]);
  const approve = async () => {
    if (!pending || !wallet || processing.current) return;
    processing.current = true; setBusy(true); setError(null);
    let hash = submitted.current.get(pending.id);
    let startedHere = false;
    try {
      if (wallet.account.address.toLowerCase() !== pending.from.toLowerCase() || account.chainId !== pending.chainId) throw new Error('Connect the wallet and network shown in this request.');
      if (!hash) {
        await request('/api/wallet/begin', { method: 'POST', body: { id: pending.id } });
        startedHere = true;
        hash = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: pending.to as `0x${string}`, data: pending.data as `0x${string}`, value: BigInt(pending.value) });
        submitted.current.set(pending.id, hash);
      }
      await request('/api/wallet/result', { method: 'POST', body: { id: pending.id, hash } });
    } catch (e) {
      const short = e && typeof e === 'object' && 'shortMessage' in e ? e.shortMessage : undefined;
      const message = typeof short === 'string' ? short : (e instanceof Error ? e.message : String(e)).split('\n')[0]!;
      setError(message);
      // If broadcast succeeded, keep its hash and retry acknowledgment, never broadcast again.
      if (!hash && startedHere) await request('/api/wallet/result', { method: 'POST', body: { id: pending.id, error: message } }).catch(() => {});
    } finally { processing.current = false; setBusy(false); }
  };
  return <div className="browser-wallet">
    <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
    {wrongChain && <span className="hint">Switch to {config.chainId} to continue.</span>}
    {error && <div role="alert" className="hint">{error}</div>}
    {pending && <div className="wallet-approval" role="status">
      <strong>{pending.submittedHash ? 'Waiting for transaction confirmation…' : 'Transaction ready for your wallet'}</strong>
      {action && <span>{action.steps.at(-1)?.label ?? action.kind}</span>}
      <span className="small mono">{pending.from.slice(0, 8)}…{pending.from.slice(-4)} · {config.chainId}</span>
      {!pending.submittedHash && <><button className="btn" disabled={busy || wrongChain || !wallet || (!!pending.approvalStarted && !submitted.current.has(pending.id))} onClick={() => void approve()}>{busy || pending.approvalStarted && !submitted.current.has(pending.id) ? 'Check your wallet…' : submitted.current.has(pending.id) ? 'Track submitted transaction' : 'Approve in wallet'}</button>
        {!submitted.current.has(pending.id) && <button className="link-button" disabled={busy || pending.approvalStarted} onClick={() => void request('/api/wallet/result', { method: 'POST', body: { id: pending.id, error: 'Cancelled' } })}>Cancel</button>}</>}
    </div>}
  </div>;
}

/** Buyer reward setup uses the same wallet connection as the header. */
export function BuyerWalletAction() {
  return <ConnectButton.Custom>{({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => (
    <button className="btn" disabled={!mounted} onClick={!account ? openConnectModal : chain?.unsupported ? openChainModal : openAccountModal}>
      {!account ? 'Connect wallet' : chain?.unsupported ? 'Switch network' : 'Change wallet'}
    </button>
  )}</ConnectButton.Custom>;
}
