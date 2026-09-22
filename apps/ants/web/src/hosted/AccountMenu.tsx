import { useEffect, useRef, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useConfig } from '../app-context';
import { request } from '../api';
import { useJobs } from '../jobs';
import { usePageData } from '../data';
import { ActionDialog } from '../components/Confirm';
import { Input } from '../components/Field';
import { AddressLink } from '../components/AddressLink';
import { shortAddress } from '../format';
import type { BuyerAuthorization, BuyerList } from './buyers';
import type { TransactionRecord } from './activity';

function chainLabel(unsupported: boolean, chainId: string): string {
  if (unsupported) return 'Switch network';
  return chainId === 'base-mainnet' ? 'Base' : chainId;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Wallet connection, saved buyer accounts and transaction recovery for the standalone dashboard. */
export function HostedAccountMenu() {
  const config = useConfig();
  const { running } = useJobs();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = usePageData('hosted:buyers', () => request<BuyerList & { persistent: boolean }>('/api/hosted/buyers'));
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { setOpen(false); setEditing(undefined); setError(null); }, [config.address]);
  const mutate = async (action: string, body: unknown) => {
    setBusy(true); setError(null);
    try { await request(`/api/hosted/buyers/${action}`, { method: 'POST', body }); list.refresh(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };
  return <ConnectButton.Custom>{({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => {
    if (!mounted) return null;
    if (!account) return <button className="btn" onClick={openConnectModal}>Connect wallet</button>;
    return <div className="hosted-account" ref={ref}>
      <button className="btn secondary" disabled={running} onClick={openChainModal}>{chainLabel(chain?.unsupported ?? false, config.chainId)}</button>
      <button className="btn secondary" ref={trigger} aria-expanded={open} aria-controls="hosted-account-menu" onClick={() => setOpen(value => !value)}>{shortAddress(account.address)} ▾</button>
      {open && <div className="hosted-account-menu stack" id="hosted-account-menu">
        <div className="section-label">Connected wallet</div>
        <AddressLink value={account.address} copy />
        <button className="btn secondary" disabled={running} onClick={openAccountModal}>Manage connection / disconnect</button>
        <div className="section-label">Buyer rewards account</div>
        <p className="hint">Saved in this browser. Selecting a buyer does not change your signing wallet.</p>
        {list.data?.buyers.map(buyer => <div className="hosted-buyer-row" key={buyer.address}>
          <button className="btn secondary" aria-pressed={list.data?.selected === buyer.address} disabled={running || busy} onClick={() => void mutate('select', { address: buyer.address })}>
            {list.data?.selected === buyer.address ? '✓ ' : ''}{buyer.label || shortAddress(buyer.address)}<span className="small mono">{shortAddress(buyer.address)}</span>
          </button>
          <button className="link-button" disabled={running || busy} onClick={() => { setAddress(buyer.address); setLabel(buyer.label); setEditing(buyer.address); }}>Edit</button>
        </div>)}
        <button className="btn" disabled={running || busy} onClick={() => { setAddress(''); setLabel(''); setEditing(null); setError(null); }}>Add buyer account</button>
        {list.data?.selected && <button className="link-button" disabled={running || busy} onClick={() => void mutate('select', { address: null })}>Clear selection</button>}
        {list.data?.persistent === false && <p role="status" className="hint">Storage is unavailable. Buyer accounts will only be remembered in this tab until you leave.</p>}
        {(error || list.error) && <p role="alert" className="hint">{error || list.error}</p>}
        {config.writeUnavailableReason && <p role="alert" className="hint">{config.writeUnavailableReason}</p>}
        {!running && <RecoveryPanel />}
      </div>}
      {editing !== undefined && <ActionDialog title={editing ? 'Edit buyer account' : 'Add buyer account'} busy={busy} onClose={() => setEditing(undefined)}>
        <form className="stack" onSubmit={event => { event.preventDefault(); void mutate(editing ? 'rename' : 'add', { address, label }).then(saved => { if (saved) setEditing(undefined); }); }}>
          <Input label="Buyer address" value={address} required disabled={!!editing || busy} onChange={event => setAddress(event.target.value)} hint="Copy the buyer address from your AntSeed app. This is not necessarily your connected wallet." />
          <Input label="Local label (optional)" value={label} maxLength={60} disabled={busy} onChange={event => setLabel(event.target.value)} placeholder="Work laptop" />
          {ADDRESS.test(address) && <BuyerStatus address={address} />}
          {error && <p role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy || running}>{busy ? 'Saving…' : 'Save buyer account'}</button>
          {editing && <><p className="hint">Removing this entry does not revoke on-chain authorization.</p><button className="link-button" type="button" disabled={busy || running} onClick={() => void mutate('remove', { address: editing }).then(saved => { if (saved) setEditing(undefined); })}>Remove saved buyer</button></>}
        </form>
      </ActionDialog>}
    </div>;
  }}</ConnectButton.Custom>;
}

export function BuyerStatus({ address }: { address: string }) {
  const config = useConfig();
  const state = usePageData(`hosted:buyer-status:${config.address}:${address}`, () => request<BuyerAuthorization>('/api/hosted/buyers/verify', { method: 'POST', body: { address } }), 0);
  useEffect(() => {
    const refresh = () => state.refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [state.refresh]);
  const retry = <p className="hint" role="alert">Could not verify authorization. <button className="link-button" onClick={state.refresh}>Retry</button></p>;
  if (state.error) return retry;
  if (!state.data || state.loading) return <p className="hint">Checking buyer authorization…</p>;
  switch (state.data.status) {
    case 'authorized': return <p className="hint">Authorized · rewards are paid to your connected wallet.</p>;
    case 'view-only': return <p className="hint">View only · connect <AddressLink value={state.data.operator} /> to claim.</p>;
    case 'unlinked': return <p className="hint">Authorization required. Open the existing AntSeed app holding this buyer identity and authorize your wallet there. Then return here and refresh.</p>;
    case 'error': return retry;
  }
}

function RecoveryPanel() {
  const { running } = useJobs();
  const records = usePageData('hosted:recovery', () => request<TransactionRecord[]>('/api/hosted/recovery'), 0);
  const [hash, setHash] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (running) return;
    const timer = window.setInterval(records.refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [records.refresh, running]);
  const recover = async (record: TransactionRecord, confirmedNotSubmitted = false) => {
    setBusy(true);
    try {
      const result = await request<{ status: string }>('/api/hosted/recovery/resolve', { method: 'POST', body: { id: record.id, hash: record.submittedHash || hash || undefined, confirmedNotSubmitted } });
      setMessage(`Transaction ${result.status}. Nothing was resubmitted.`); records.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!records.data?.length) return records.error ? <p className="hint" role="alert">Recovery unavailable: {records.error}</p> : null;
  return <details><summary>Transaction recovery ({records.data.length})</summary><div className="stack">
    <p className="hint">Check the original wallet before starting another action. No approvals resume automatically.</p>
    {records.data.map(record => <div className="stack" key={record.id}>
      <span className="small mono">{shortAddress(record.to)} · {new Date(record.at).toLocaleString()}</span>
      {record.submittedHash ? <span className="small mono hosted-hash">{record.submittedHash}</span> : <Input label="Submitted transaction hash, if any" value={hash} onChange={event => setHash(event.target.value)} />}
      <button className="btn secondary" disabled={busy || running} onClick={() => void recover(record)}>Check transaction</button>
      {!record.submittedHash && !hash && <button className="link-button" disabled={busy || running} onClick={() => void recover(record, true)}>I checked my wallet: nothing was submitted</button>}
    </div>)}
    {message && <p role="status" className="hint">{message}</p>}
  </div></details>;
}
