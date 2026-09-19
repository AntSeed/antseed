import { WalletControls } from '../wallet';
import type { ReactNode } from 'react';
import { useApp } from '../app-context';
import { TABS, href, type Page } from '../router';
import { ActivityDrawer } from './Activity';
import { AddressLink } from './AddressLink';
import { Toasts } from './Toasts';

interface Props {
  page: Page;
  /** Last successful overview fetch; shown in the footer. */
  updatedAt: number | null;
  loading: boolean;
  children: ReactNode;
}

export function Layout({ page, children }: Props) {
  return (
    <div className="app">
      <TopBar page={page} />
      <main className="main">{children}</main>
      <ActivityDrawer />
      <Toasts />
    </div>
  );
}

/** Wordmark, the three tabs, then wallet / chain on the right. */
function TopBar({ page }: { page: Page }) {
  const { config } = useApp();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="wordmark" href={href('stake')}>
          ANTS<span>staking</span>
        </a>
        <nav className="tabs" aria-label="Main">
          {TABS.map((tab) => (
            <a key={tab.id} href={href(tab.id)} className={tab.id === page ? 'active' : undefined} aria-current={tab.id === page ? 'page' : undefined}>
              {tab.label}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          {config.browserWallet ? <WalletControls config={config} /> : <span className="wallet-chip">
            <AddressLink value={config.address} copy className="wallet-chip-addr" />
          </span>}

        </div>
      </div>
    </header>
  );
}
