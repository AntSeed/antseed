import { useCallback, useMemo, useState } from 'react';
import { TAB_IDS, type TabId } from '../components/layout/sidebar';

const VALID_TABS: ReadonlySet<TabId> = new Set(TAB_IDS);

function parseTabFromUrl(): TabId {
  const raw = new URLSearchParams(window.location.search).get('tab');
  if (!raw) return 'overview';
  // Legacy compat: the old deposits tab no longer exists, and the overview tab
  // was previously named "dashboard". Map both to the current overview tab.
  if (raw === 'deposit' || raw === 'deposits' || raw === 'dashboard') return 'overview';
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : 'overview';
}

function shouldOpenDepositFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action') ?? params.get('modal');
  const tab = params.get('tab');
  return action === 'deposit' || tab === 'deposit' || tab === 'deposits';
}

function writeTabToUrl(tab: TabId) {
  const url = new URL(window.location.href);
  url.searchParams.set('tab', tab);
  window.history.replaceState({}, '', url.toString());
}

function clearDepositActionFromUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('action') === 'deposit') url.searchParams.delete('action');
  if (url.searchParams.get('modal') === 'deposit') url.searchParams.delete('modal');
  window.history.replaceState({}, '', url.toString());
}

export function useTabUrl() {
  const [activeTab, setActiveTab] = useState<TabId>(() => parseTabFromUrl());
  const initialActionModal = useMemo(
    () => (shouldOpenDepositFromUrl() ? ('deposit' as const) : null),
    [],
  );

  const selectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  return {
    activeTab,
    selectTab,
    initialActionModal,
    clearDepositAction: clearDepositActionFromUrl,
  };
}
