import { createContext, useContext } from 'react';
import type { TabId } from '../components/layout/sidebar';

export type OverlayPhase = 'deposit' | 'success' | null;

export interface AppShellContextValue {
  activeTab: TabId;
  selectTab: (tab: TabId) => void;
  isDark: boolean;
  toggleTheme: () => void;
  openDeposit: () => void;
  openWithdraw: () => void;
  refreshBalance: () => Promise<void>;
  handleDeposited: () => Promise<void>;
}

export const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext);
  if (!ctx) {
    throw new Error('useAppShell must be used inside <AppShell>');
  }
  return ctx;
}
