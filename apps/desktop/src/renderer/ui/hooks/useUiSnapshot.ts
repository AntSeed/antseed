import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getStateRef } from '../../core/store';
import type { RendererUiState } from '../../core/state';

/**
 * Subscribe to the UI state store. Returns the full mutable state ref.
 * React re-renders whenever notifyUiStateChanged() is called.
 */
export function useUiSnapshot(): RendererUiState {
  useSyncExternalStore(subscribe, getSnapshot);
  return getStateRef();
}
