import { createContext } from 'react';
import type { ViewName } from '../../types';

/**
 * View navigation for shared chrome (VprPage's credits pill). Provided by
 * VprShell so per-view code doesn't have to thread onSelectView into every
 * shared header. Null outside the shell (e.g. isolated component tests) —
 * consumers no-op.
 */
export const VprNavContext = createContext<((view: ViewName) => void) | null>(null);
