import { createContext, useCallback, useContext } from 'react';
import type { ViewName } from '../../types';

/**
 * View navigation for shared chrome (VprPage's credits pill, header back
 * buttons). Provided by VprShell so per-view code doesn't have to thread
 * onSelectView into every shared header. Null outside the shell (e.g.
 * isolated component tests) — consumers no-op.
 */
export type VprNav = {
  navigate: (view: ViewName) => void;
  /** Return to the previously active screen; `fallback` when there is no
      history left (fresh launch, history exhausted). */
  back: (fallback: ViewName) => void;
};

export const VprNavContext = createContext<VprNav | null>(null);

/** Back handler for a view's header: pops the nav history so the back button
    returns to wherever the user actually came from, with the view's natural
    parent screen as the empty-history fallback. */
export function useVprNavBack(fallback: ViewName): () => void {
  const nav = useContext(VprNavContext);
  return useCallback(() => nav?.back(fallback), [nav, fallback]);
}
