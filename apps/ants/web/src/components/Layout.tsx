import type { ReactNode } from 'react';
import { useApp } from '../app-context';
import { formatLocalTime } from '../format';
import { TABS, href, type Page } from '../router';
import { ActivityDrawer, ActivityIndicator } from './Activity';
import { AddressLink } from './AddressLink';
import { Pill } from './Pill';
import { Toasts } from './Toasts';

interface Props {
  page: Page;
  /** Last successful overview fetch; shown in the footer. */
  updatedAt: number | null;
  loading: boolean;
  children: ReactNode;
}

export function Layout({ page, updatedAt, loading, children }: Props) {
  return (
    <div className="app">
      <TopBar page={page} />
      <main className="main">{children}</main>
      <Footer page={page} updatedAt={updatedAt} loading={loading} />
      <ActivityDrawer />
      <Toasts />
    </div>
  );
}

/** Wordmark, the three tabs, then activity / wallet / chain on the right. */
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
          <ActivityIndicator />
          <span className="wallet-chip">
            <AddressLink value={config.address} copy className="wallet-chip-addr" />
          </span>
          <Pill mono title={`EVM chain id ${config.evmChainId}`}>
            {config.chainId}
          </Pill>
          {config.readOnly ? (
            <Pill tone="amber" title="No wallet available; actions are disabled.">
              read-only
            </Pill>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Footer({ page, updatedAt, loading }: { page: Page; updatedAt: number | null; loading: boolean }) {
  const { theme, toggleTheme } = useApp();
  return (
    <footer className="footer">
      <div className="footer-inner">
        <a href={href('network')} className={page === 'network' ? 'active' : undefined}>
          Network
        </a>
        <a href={href('addresses')} className={page === 'addresses' ? 'active' : undefined}>
          Addresses
        </a>
        <button type="button" className="link-button" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <span className="footer-updated mono">{updatedAt ? `updated ${formatLocalTime(updatedAt)}` : loading ? 'loading…' : ''}</span>
      </div>
    </footer>
  );
}
