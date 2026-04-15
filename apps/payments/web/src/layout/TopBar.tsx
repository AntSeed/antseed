import type { TabId } from './Sidebar';
import type { BalanceData } from '../types';

interface TopBarProps {
  activeTab: TabId;
  balance: BalanceData | null;
  onOpenWallet: () => void;
}

const TAB_TITLES: Record<TabId, string> = {
  dashboard: 'Dashboard',
  channels:  'Channels',
  emissions: 'Emissions',
};

const TAB_SUBTITLES: Record<TabId, string> = {
  dashboard: 'Your balance, usage, and network activity at a glance.',
  channels:  'Active and historical payment channels.',
  emissions: 'Earn and claim ANTS rewards from network activity.',
};

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SignerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 8.4l2 2 4-4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TopBar({ activeTab, balance, onOpenWallet }: TopBarProps) {
  const total = balance ? parseFloat(balance.total) : null;

  return (
    <header className="dash-topbar">
      <div className="dash-topbar-titles">
        <div className="dash-topbar-title">{TAB_TITLES[activeTab]}</div>
        <div className="dash-topbar-subtitle">{TAB_SUBTITLES[activeTab]}</div>
      </div>
      <div className="dash-topbar-right">
        <button
          type="button"
          className="dash-topbar-wallet"
          onClick={onOpenWallet}
          title="Open signer"
        >
          <span className="dash-topbar-wallet-icon"><SignerIcon /></span>
          <span className="dash-topbar-wallet-text">
            <span className="dash-topbar-wallet-label">Your AntSeed signer</span>
            <span className="dash-topbar-wallet-value">
              {total !== null ? `$${formatUsd(total)}` : '—'}
            </span>
          </span>
        </button>
      </div>
    </header>
  );
}
