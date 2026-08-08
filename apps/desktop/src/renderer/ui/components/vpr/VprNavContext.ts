import { createContext } from 'react';
import type { ViewName } from '../../types';

/**
 * View navigation for shared chrome (VprPage's credits pill, header back
 * buttons). Provided by VprShell so per-view code doesn't have to thread
 * onSelectView into every shared header. Null outside the shell (e.g.
 * isolated component tests) — consumers no-op.
 */
export type VprNav = {
  navigate: (view: ViewName) => void;
  leaveDeposit: () => void;
};

export const VprNavContext = createContext<VprNav | null>(null);
