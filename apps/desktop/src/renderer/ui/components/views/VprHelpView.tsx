import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  NewTwitterIcon,
  TelegramIcon,
} from '@hugeicons/core-free-icons';
import { getUiStateRef } from '../../../core/store';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { VprCard, VprPage, VprSettingRow, VprToggle } from '../vpr/VprKit';
import styles from './VprHelpView.module.scss';

declare const __APP_VERSION__: string;

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const TELEGRAM_URL = 'https://t.me/antseed';
const X_URL = 'https://x.com/antseed';
const DOCS_BASE_URL = 'https://antseed.com/docs';

type HelpSection = { heading: string; body: string };
type HelpArticle = {
  key: string;
  label: string;
  /** Lead paragraph shown before the titled sections. */
  intro: string;
  sections: HelpSection[];
  /** Docs path (appended to DOCS_BASE_URL) for the "Read more" link. */
  docsPath: string;
};
type HelpTopic = { key: string; label: string; articles: HelpArticle[] };

const HELP_TOPICS: HelpTopic[] = [
  {
    key: 'how-to',
    label: 'How to use AntSeed',
    articles: [
      {
        key: 'what-is',
        label: 'What is AntSeed?',
        intro: 'AntSeed is a peer-to-peer network of AI sellers. Instead of subscribing to a single provider, your requests are routed to the best available seller for the model you choose, and you pay only for the tokens you use.',
        sections: [
          {
            heading: 'Your local router',
            body: 'The VPR (Virtual Peer Router) runs on your machine. It discovers sellers, compares their prices and reputation, opens a payment channel with the one it picks, and forwards your app traffic to it — all locally, with your keys.',
          },
          {
            heading: 'Start and stop',
            body: 'The power button on the main screen starts and stops the router. The status strip at the bottom shows network health, your port, and how many peers and services are currently visible.',
          },
        ],
        docsPath: '/',
      },
      {
        key: 'models',
        label: 'Choose a model and seller',
        intro: 'Open Models to browse every model available on the network, with live prices and expected savings against retail. Tap a model to see its sellers, their reputation scores, and per-token prices.',
        sections: [
          {
            heading: 'Set the new session model',
            body: 'Use sets the model new sessions start on: everything you connect routes through it. With Auto select on, AntSeed keeps re-picking the best seller for that model based on your price and trust preferences.',
          },
          {
            heading: 'Pin a seller',
            body: 'Prefer a specific seller? Tap it in the sellers list to pin it. Pinned sellers stay fixed until you unpin them from the model page or Preferences.',
          },
        ],
        docsPath: '/pricing',
      },
      {
        key: 'apps',
        label: 'Connect your apps',
        intro: 'On the main screen, click any app under "Use it on your favorite app" to connect it in one click. The app keeps its normal interface, but its AI requests now route through AntSeed.',
        sections: [
          {
            heading: 'Restarts',
            body: 'Some apps read a config file and need a restart to pick up the change — the Apps page offers a restart button next to those.',
          },
          {
            heading: 'App pills and the pop-out',
            body: 'Each connected app shows a pill on the main screen. The pop-out button detaches a small floating window you can keep above the app you are working in.',
          },
        ],
        docsPath: '/config',
      },
      {
        key: 'float',
        label: 'The floating window',
        intro: 'The floating pill stays on top of other windows and follows you across desktops. It shows the routed model and live token and cost totals for the current payment channel.',
        sections: [
          {
            heading: 'Switch model or pin a chat',
            body: 'Click the model name to open the list: the New session model row changes the global route, and each recent chat can pin its own model. A chat that is receiving traffic shows a green pulse next to its name.',
          },
          {
            heading: 'Back to the main window',
            body: 'Click the AntSeed icon to bring the main window back, or the X to close the pill.',
          },
        ],
        docsPath: '/faq',
      },
      {
        key: 'balance',
        label: 'Balance and payments',
        intro: 'AntSeed is pay-per-use: you deposit USDC once, and each request is settled from a payment channel between you and the seller. There are no subscriptions and no lock-in.',
        sections: [
          {
            heading: 'Add and track balance',
            body: 'Add balance from the Profile screen with a card or USDC on Base. Your balance, reserved funds, and per-channel spending are all visible there, and unused credits can be withdrawn at any time.',
          },
          {
            heading: 'How sellers get paid',
            body: 'Sellers are paid only for what they serve, with signed vouchers per request — if a seller disappears, your remaining balance stays yours.',
          },
        ],
        docsPath: '/guides/payments',
      },
      {
        key: 'preferences',
        label: 'Routing preferences',
        intro: 'Preferences control how Auto select picks sellers for every model set to Auto.',
        sections: [
          {
            heading: 'Trust, price and free peers',
            body: 'Minimum trust score is a hard eligibility gate. Price preference strongly penalizes sellers above your preferred input-token price, while maxPricing remains the hard spending cap. Prefer free peers gives zero-cost offers a strong routing bonus.',
          },
          {
            heading: 'Pausing auto select',
            body: 'Turning Auto select off pauses routing decisions everywhere — connected apps stay on their last picked seller.',
          },
        ],
        docsPath: '/pricing',
      },
    ],
  },
  {
    key: 'cannot-connect',
    label: "I can't get connected",
    articles: [
      {
        key: 'no-peers',
        label: 'No peers or models listed',
        intro: 'Make sure the router is running — the power button on the main screen should be green and the status strip should read Healthy.',
        sections: [
          {
            heading: 'Give discovery a moment',
            body: 'Peer discovery can take a few seconds after startup. If the Models list stays empty, use its Refresh models button.',
          },
          {
            heading: 'Check your firewall',
            body: 'If the network still looks empty, your firewall may be blocking peer-to-peer connections. AntSeed uses WebRTC data channels; allow the app through your firewall and try again.',
          },
        ],
        docsPath: '/faq',
      },
      {
        key: 'app-connect',
        label: "An app won't connect",
        intro: 'Try disconnecting and reconnecting the app from the Apps page. Watch the status line under the app for the current connection state and request count.',
        sections: [
          {
            heading: 'Config-file apps need a restart',
            body: 'Apps that are configured through a config file (rather than a proxy) need to be restarted after connecting — use the restart button that appears on their row.',
          },
          {
            heading: 'Check for overrides',
            body: 'If the app was already running with its own API settings, check it is not overriding the base URL AntSeed configured.',
          },
        ],
        docsPath: '/config',
      },
      {
        key: 'trust-ca',
        label: 'Trust the local certificate',
        intro: 'Apps connected through the local proxy need to trust the certificate AntSeed generates, so it can serve their API domains locally.',
        sections: [
          {
            heading: 'Trust the CA from Apps',
            body: 'If requests fail with TLS or certificate errors, open Apps and use the Trust CA button that appears on the affected app when the certificate is not yet trusted.',
          },
          {
            heading: 'What macOS asks for',
            body: 'macOS asks for your password once to add the certificate to your keychain. Nothing leaves your machine — the certificate is generated locally and only used for local interception.',
          },
        ],
        docsPath: '/faq',
      },
    ],
  },
  {
    key: 'connected-problem',
    label: 'I can connect but there is a problem',
    articles: [
      {
        key: 'payments',
        label: 'Requests fail with payment errors',
        intro: 'Payment errors usually mean your available balance is too low to reserve a channel with the seller. Check the Profile screen and add balance.',
        sections: [
          {
            heading: 'Channel switchovers',
            body: 'When a channel is exhausted mid-session, AntSeed settles it and opens a new one automatically — a single failed request may just be that switchover; retry it.',
          },
          {
            heading: 'Reserved funds',
            body: 'Funds reserved for open channels are released back to your balance when channels settle or close.',
          },
        ],
        docsPath: '/guides/payments',
      },
      {
        key: 'model-not-served',
        label: '"Model is not served by this peer"',
        intro: 'This means a request reached a seller that does not offer the requested model — usually after routing changed while an app kept its old model list.',
        sections: [
          {
            heading: 'Re-select the model',
            body: 'Re-select your model (main screen dropdown, model page, or the floating window) — this re-syncs every connected app to the new route.',
          },
          {
            heading: 'Still stuck?',
            body: 'If it persists, disconnect and reconnect the app from the Apps page.',
          },
        ],
        docsPath: '/faq',
      },
      {
        key: 'slow',
        label: 'Responses are slow or time out',
        intro: 'Seller performance varies. Open the model page and try a different seller — reputation reflects reliability, and you can pin any seller you like.',
        sections: [
          {
            heading: 'Automatic retries',
            body: 'Timeouts are retried on another route automatically when possible. Frequent timeouts on one seller lower its score for future routing.',
          },
          {
            heading: 'Large requests',
            body: 'Very large requests take longer to upload over peer-to-peer connections; the floating window pulse shows when data is actually moving.',
          },
        ],
        docsPath: '/faq',
      },
      {
        key: 'withdraw',
        label: 'Withdraw unused credits',
        intro: 'Your deposit stays yours. Open Profile and use "Withdraw unused credits" to move available balance back to your wallet.',
        sections: [
          {
            heading: 'Reserved funds',
            body: 'Funds reserved by open channels become available after the channels settle or close; if a seller is unresponsive, a channel can be force-closed after a grace period.',
          },
        ],
        docsPath: '/guides/payments',
      },
    ],
  },
];

/** Global reading order for the "Read next" link at the bottom of articles. */
const ARTICLE_ORDER: Array<{ topicKey: string; article: HelpArticle }> = HELP_TOPICS.flatMap(
  (topic) => topic.articles.map((article) => ({ topicKey: topic.key, article })),
);

function nextArticle(topicKey: string, articleKey: string): { topicKey: string; article: HelpArticle } | null {
  const index = ARTICLE_ORDER.findIndex(
    (entry) => entry.topicKey === topicKey && entry.article.key === articleKey,
  );
  return index >= 0 ? ARTICLE_ORDER[index + 1] ?? null : null;
}

/** Diagnostic screens surfaced from Help — the only entry point for them. */
const DIAGNOSTIC_ROUTES: Array<{ view: import('../../types').ViewName; label: string }> = [
  { view: 'peers', label: 'Available peers' },
  { view: 'connection', label: 'Connection details' },
  { view: 'config', label: 'Configuration' },
];

function openExternal(url: string): void {
  void window.antseedDesktop?.openExternalUrl?.(url);
}

// Must match the pane animation duration in VprHelpView.module.scss.
const PAGE_SLIDE_MS = 300;

type HelpPage = { topicKey: string | null; articleKey: string | null };

function pageDepth(page: HelpPage): number {
  return page.articleKey ? 2 : page.topicKey ? 1 : 0;
}

function pageKey(page: HelpPage): string {
  return `${page.topicKey ?? ''}/${page.articleKey ?? ''}`;
}

// Renderer-lifetime scroll positions per help page. Written once per
// navigation (and on view unmount) — no scroll listeners, no state updates —
// so drilling into a topic or a diagnostic screen and coming back lands at
// the same spot.
const helpScrollByPage = new Map<string, number>();

export function VprHelpView({ onSelectView }: Props) {
  const snap = useUiSelector((state) => ({
    connectBadgeLabel: state.connectBadge.label,
    networkHealth: state.ovDhtHealth,
    proxyPort: state.ovProxyPort,
    peers: state.ovPeers,
    serviceCount: state.ovServiceCount,
    modelLabel: state.vprRouteSelection.model?.label ?? null,
    devMode: state.devMode,
    configFormData: state.configFormData,
    configSaving: state.configSaving,
  }), shallowEqual);
  const actions = useActions();

  // Internal page slide (same ExpressVPN-style transition as the top-level
  // ViewHost): the outgoing page stays mounted for one animation beat.
  const [nav, setNav] = useState<{ page: HelpPage; previous: HelpPage | null; direction: 'forward' | 'back' }>({
    page: { topicKey: null, articleKey: null },
    previous: null,
    direction: 'forward',
  });

  const activePaneRef = useRef<HTMLDivElement | null>(null);
  const currentPageRef = useRef(nav.page);
  currentPageRef.current = nav.page;

  // The pane itself is a pinned-header flex column; the scrolling element is
  // the VprPage body inside it.
  function paneScroller(): HTMLElement | null {
    return activePaneRef.current?.querySelector<HTMLElement>('[data-view-scroll]') ?? null;
  }

  function goTo(page: HelpPage, direction?: 'forward' | 'back'): void {
    const el = paneScroller();
    if (el) helpScrollByPage.set(pageKey(currentPageRef.current), el.scrollTop);
    setNav((current) => ({
      page,
      previous: current.page,
      direction: direction ?? (pageDepth(page) >= pageDepth(current.page) ? 'forward' : 'back'),
    }));
  }

  // Restore the incoming page's scroll before paint; save on unmount (e.g.
  // when a diagnostic row navigates to another view).
  useLayoutEffect(() => {
    const el = paneScroller();
    if (el) el.scrollTop = helpScrollByPage.get(pageKey(nav.page)) ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey(nav.page)]);
  useEffect(() => () => {
    const el = paneScroller();
    if (el) helpScrollByPage.set(pageKey(currentPageRef.current), el.scrollTop);
  }, []);

  useEffect(() => {
    if (!nav.previous) return undefined;
    const timer = window.setTimeout(() => {
      setNav((current) => (current.previous ? { ...current, previous: null } : current));
    }, PAGE_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [nav]);

  const [copied, setCopied] = useState(false);
  const [appVersion, setAppVersion] = useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  );
  useEffect(() => {
    window.antseedDesktop?.getAppVersion?.().then(setAppVersion).catch(() => {});
  }, []);

  // Developer mode is the single switch for diagnostics: it enables debug
  // logging (settings module) and reveals the diagnostic screens below.
  function toggleDevMode(next: boolean): void {
    if (!snap.configFormData) return;
    void actions.saveConfig({ ...snap.configFormData, devMode: next });
  }

  async function copyDiagnostics(): Promise<void> {
    const state = getUiStateRef();
    const recentLogs = state.logs.slice(-50)
      .map((event) => `[${event.mode}] ${event.line}`)
      .join('\n');
    const report = [
      `AntSeed VPR v${appVersion}`,
      `Status: ${snap.networkHealth} | ${snap.connectBadgeLabel} | Port ${snap.proxyPort}`,
      `Network: ${snap.peers} peers, ${snap.serviceCount} services`,
      `Model: ${snap.modelLabel ?? 'none selected'}`,
      '',
      '--- Recent logs ---',
      recentLogs,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard unavailable */ }
  }

  function renderArticlePage(topic: HelpTopic, article: HelpArticle) {
    const next = nextArticle(topic.key, article.key);
    return (
      <VprPage title={topic.label} onBack={() => goTo({ topicKey: topic.key, articleKey: null })}>
      <div className={styles.stack}>
        <h2 className={styles.title}>{article.label}</h2>
        <VprCard className={styles.articleCard}>
          <p className={styles.paragraph}>{article.intro}</p>
          {article.sections.map((section) => (
            <div key={section.heading} className={styles.articleSection}>
              <h3 className={styles.articleHeading}>{section.heading}</h3>
              <p className={styles.paragraph}>{section.body}</p>
            </div>
          ))}
          <button
            type="button"
            className={styles.docsLink}
            onClick={() => openExternal(`${DOCS_BASE_URL}${article.docsPath}`)}
          >
            <span>Read more in the docs</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={2} />
          </button>
        </VprCard>
        {next && (
          <button
            type="button"
            className={styles.nextRow}
            onClick={() => goTo({ topicKey: next.topicKey, articleKey: next.article.key }, 'forward')}
          >
            <span className={styles.nextKicker}>Read next</span>
            <span className={styles.nextLabel}>
              <span className={styles.nextLabelText}>{next.article.label}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </span>
          </button>
        )}
      </div>
      </VprPage>
    );
  }

  function renderTopicPage(topic: HelpTopic) {
    return (
      <VprPage title="Help & Support" onBack={() => goTo({ topicKey: null, articleKey: null })}>
      <div className={styles.stack}>
        <h2 className={styles.title}>{topic.label}</h2>
        <VprCard>
          {topic.articles.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={styles.row}
              onClick={() => goTo({ topicKey: topic.key, articleKey: entry.key })}
            >
              <span className={styles.rowLabel}>{entry.label}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          ))}
        </VprCard>
      </div>
      </VprPage>
    );
  }

  function renderRootPage() {
    return (
      <VprPage title="Help & Support" backFallback="home">
      <div className={styles.stack}>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Community</p>
          <p className={styles.sectionHint}>
            Get help from the team and the community, and follow what we ship.
          </p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal(TELEGRAM_URL)}>
              <HugeiconsIcon icon={TelegramIcon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
              <span className={styles.rowLabel}>Join our Telegram</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={() => openExternal(X_URL)}>
              <HugeiconsIcon icon={NewTwitterIcon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
              <span className={styles.rowLabel}>Follow us on X</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>VPR</p>
          <VprCard>
            {HELP_TOPICS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={styles.row}
                onClick={() => goTo({ topicKey: entry.key, articleKey: null })}
              >
                <span className={styles.rowLabel}>{entry.label}</span>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
              </button>
            ))}
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Diagnostic tools</p>
          <VprCard className={styles.settingCard}>
            <VprSettingRow
              title="Developer mode"
              hint="Enables debug logging and the diagnostic screens below"
              control={(
                <VprToggle
                  checked={snap.devMode}
                  onChange={toggleDevMode}
                  ariaLabel="Developer mode"
                  disabled={!snap.configFormData || snap.configSaving}
                />
              )}
            />
            {snap.devMode && (
              <>
                <button
                  type="button"
                  className={`${styles.row} ${styles.rowFlush}`}
                  onClick={() => onSelectView?.('desktop')}
                >
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>Live logs</span>
                    <span className={styles.rowHint}>Runtime activity as it happens</span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                </button>
                {DIAGNOSTIC_ROUTES.map((route) => (
                  <button
                    key={route.view}
                    type="button"
                    className={`${styles.row} ${styles.rowFlush}`}
                    onClick={() => onSelectView?.(route.view)}
                  >
                    <span className={styles.rowLabel}>{route.label}</span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                  </button>
                ))}
                <button type="button" className={`${styles.row} ${styles.rowFlush}`} onClick={() => { void copyDiagnostics(); }}>
                  <HugeiconsIcon icon={Copy01Icon} size={18} strokeWidth={1.8} className={styles.rowIcon} />
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>{copied ? 'Copied to clipboard' : 'Copy diagnostic report'}</span>
                    <span className={styles.rowHint}>Version, runtime status and recent logs</span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
                </button>
              </>
            )}
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>Legal</p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal('https://antseed.com/terms-of-service#16-privacy-and-data')}>
              <span className={styles.rowLabel}>Privacy Policy</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <button type="button" className={styles.row} onClick={() => openExternal('https://antseed.com/terms-of-service')}>
              <span className={styles.rowLabel}>Terms of Service</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
          </VprCard>
        </div>

        <div className={styles.section}>
          <p className={styles.sectionLabel}>App details</p>
          <VprCard>
            <button type="button" className={styles.row} onClick={() => openExternal('https://github.com/AntSeed/antseed/blob/main/CHANGELOG.md')}>
              <span className={styles.rowLabel}>Changelog</span>
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} className={styles.rowGlyph} />
            </button>
            <div className={styles.row}>
              <span className={styles.rowLabel}>App version</span>
              <span className={styles.rowValue}>v{appVersion}</span>
            </div>
          </VprCard>
        </div>
      </div>
      </VprPage>
    );
  }

  function renderPage(page: HelpPage) {
    const topic = page.topicKey ? HELP_TOPICS.find((entry) => entry.key === page.topicKey) ?? null : null;
    if (topic && page.articleKey) {
      const article = topic.articles.find((entry) => entry.key === page.articleKey);
      if (article) return renderArticlePage(topic, article);
    }
    if (topic) return renderTopicPage(topic);
    return renderRootPage();
  }

  const sliding = nav.previous !== null;

  return (
    <section
      className={`${styles.host}${sliding ? ` ${styles.hostSliding} ${nav.direction === 'forward' ? styles.hostForward : styles.hostBack}` : ''}`}
      role="tabpanel"
    >
      {nav.previous && (
        <div
          key={`out-${pageKey(nav.previous)}`}
          className={`view view-vpr-help view-pinned-header ${styles.view} ${styles.pane} ${styles.paneOut}`}
          aria-hidden="true"
        >
          {renderPage(nav.previous)}
        </div>
      )}
      <div
        key={pageKey(nav.page)}
        ref={activePaneRef}
        className={`view view-vpr-help view-pinned-header ${styles.view} ${styles.pane}${sliding ? ` ${styles.paneIn}` : ''}`}
      >
        {renderPage(nav.page)}
      </div>
    </section>
  );
}
