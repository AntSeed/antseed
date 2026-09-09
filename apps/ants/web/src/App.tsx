import { Card } from './components/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getToken, onUnauthorized } from './api';
import { AppContext, type AppValue, type Theme } from './app-context';
import { ErrorBox } from './components/Feedback';
import { Layout } from './components/Layout';
import { usePageData } from './data';
import { JobsProvider } from './jobs';
import { AddressesPage } from './pages/Addresses';
import { NetworkPage } from './pages/Network';
import { RewardsPage } from './pages/Rewards';
import { SellerPage } from './pages/Seller';
import { StakePage } from './pages/Stake';
import { useRoute, type Page } from './router';

const THEME_KEY = 'ants.dashboard.theme';
/** The shell re-reads the overview on this cadence so the footer "updated" time and the tiles stay fresh. */
const OVERVIEW_POLL_MS = 60_000;

/** Stored preference wins; otherwise follow the OS setting; light by default. */
function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage unavailable */
  }
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function App() {
  const [unauthorized, setUnauthorized] = useState(() => getToken() === null);
  useEffect(() => onUnauthorized(() => setUnauthorized(true)), []);

  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  if (unauthorized) return <AuthGate />;
  return <Shell theme={theme} toggleTheme={toggleTheme} />;
}

function AuthGate() {
  return (
    <div className="full-page">
      <Card className="full-page-inner">
        <div className="wordmark">
          ANTS<span>staking</span>
        </div>
        <p>
          Open this dashboard from <code>antseed ants</code>.
        </p>
        <p className="muted small">
          The CLI starts the local server and opens the browser with a one-time session token. This page has no token (or the server rejected it), so it cannot read
          wallet or chain data.
        </p>
      </Card>
    </div>
  );
}

function Shell({ theme, toggleTheme }: { theme: Theme; toggleTheme: () => void }) {
  const config = usePageData('config', api.config, Number.POSITIVE_INFINITY);
  const overview = usePageData('overview', api.overview);
  const route = useRoute();

  const refreshOverview = overview.refresh;
  useEffect(() => {
    const timer = window.setInterval(refreshOverview, OVERVIEW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshOverview]);

  const value = useMemo<AppValue | null>(
    () => (config.data ? { config: config.data, overview: overview.data, theme, toggleTheme } : null),
    [config.data, overview.data, theme, toggleTheme],
  );

  if (!value) {
    return (
      <div className="full-page">
        <Card className="full-page-inner">
          {config.error ? <ErrorBox error={config.error} onRetry={config.refresh} title="Could not load dashboard config" /> : <span className="muted">Connecting to the local server…</span>}
        </Card>
      </div>
    );
  }

  return (
    <AppContext.Provider value={value}>
      <JobsProvider>
        <Layout page={route.page} updatedAt={overview.updatedAt} loading={overview.loading}>
          <PageView page={route.page} />
        </Layout>
      </JobsProvider>
    </AppContext.Provider>
  );
}

function PageView({ page }: { page: Page }) {
  switch (page) {
    case 'rewards':
      return <RewardsPage />;
    case 'seller':
      return <SellerPage />;
    case 'network':
      return <NetworkPage />;
    case 'addresses':
      return <AddressesPage />;
    case 'stake':
    default:
      return <StakePage />;
  }
}
