import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Settings02Icon } from '@hugeicons/core-free-icons';
import type { ViewName } from '../types';
import { shallowEqual, useUiSelector } from '../hooks/useUiSelector';
import { formatCredits } from '../../core/format';
import { navViews } from './viewRegistry';
import { ChatListPanel } from './ChatListPanel';
import styles from './VprShell.module.scss';

declare const __APP_VERSION__: string;

type VprShellProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
  children: React.ReactNode;
};

const mainNavEntries = navViews('main');
const devNavEntries = navViews('dev');

export function VprShell({ activeView, onSelectView, children }: VprShellProps) {
  const snap = useUiSelector((state) => ({
    creditsAvailableUsdc: state.creditsAvailableUsdc,
    devMode: state.devMode,
    connectBadgeLabel: state.connectBadge.label,
    networkHealth: state.ovDhtHealth,
    proxyPort: state.ovProxyPort,
    peers: state.ovPeers,
    serviceCount: state.ovServiceCount,
    chatNeedsAttention: state.chatPaymentApprovalVisible || state.chatSendingConversationIds.length > 0,
  }), shallowEqual);

  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  const chatMode = activeView === 'chat';

  return (
    <div className={`${styles.shell}${chatMode ? ` ${styles.shellWithPanel}` : ''}`}>
      {/* Window-drag handle: the hidden-inset title bar has no native drag
          region, so this strip provides one. pointer-events: none keeps web
          clicks working; interactive elements overlapping it opt out with
          -webkit-app-region: no-drag. */}
      <div className={styles.dragStrip} aria-hidden="true" />
      <nav className={styles.sidebar} aria-label="VPR navigation">
        <div className={styles.navGroup}>
          {mainNavEntries.map(({ view, nav }) => {
            const active = activeView === view;
            return (
              <button
                key={view}
                type="button"
                className={`${styles.navButton}${active ? ` ${styles.navButtonActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(view)}
              >
                <HugeiconsIcon icon={nav.icon} size={24} strokeWidth={1.8} />
                <span className={styles.navLabel}>{nav.label}</span>
                {view === 'chat' && snap.chatNeedsAttention && activeView !== 'chat' && (
                  <span className={styles.navDot} aria-label="Chat activity" />
                )}
              </button>
            );
          })}
        </div>
        <div className={styles.navBottom}>
          {snap.devMode && devNavEntries.map(({ view, nav }) => (
            <button
              key={view}
              type="button"
              className={`${styles.navButton}${activeView === view ? ` ${styles.navButtonActive}` : ''}`}
              aria-label={nav.label}
              aria-current={activeView === view ? 'page' : undefined}
              title={nav.label}
              onClick={() => onSelectView(view)}
            >
              <HugeiconsIcon icon={nav.icon} size={24} strokeWidth={1.8} />
            </button>
          ))}
          <button
            type="button"
            className={`${styles.navButton} ${styles.navIconOnly}${activeView === 'preferences' ? ` ${styles.navButtonActive}` : ''}`}
            aria-label="Settings"
            title="Settings"
            onClick={() => onSelectView('preferences')}
          >
            <HugeiconsIcon icon={Settings02Icon} size={24} strokeWidth={1.8} />
          </button>
        </div>
      </nav>
      {chatMode && <ChatListPanel />}
      <main className={styles.mainPane}>
        <button
          type="button"
          className={styles.creditsPill}
          title="Credits balance"
          onClick={() => onSelectView('credits')}
        >
          {formatCredits(snap.creditsAvailableUsdc)} Credits
        </button>
        <div className={styles.content}>{children}</div>
      </main>
      <footer className={styles.statusStrip}>
        <span
          className={`${styles.statusItem}${
            snap.networkHealth === 'Down'
              ? ` ${styles.statusBad}`
              : snap.networkHealth === 'Limited'
                ? ` ${styles.statusWarn}`
                : ''
          }`}
        >
          {snap.networkHealth}
        </span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>{snap.connectBadgeLabel}</span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>Port: {snap.proxyPort}</span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>{snap.peers} Peers</span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>{snap.serviceCount} Services</span>
        <span className={styles.statusSep} aria-hidden="true">|</span>
        <span className={styles.statusItem}>v{appVersion}</span>
      </footer>
    </div>
  );
}
