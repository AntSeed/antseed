import { useSyncExternalStore } from 'react';
import { subscribe, getUiSnapshot } from '../../core/store';
import type { RendererUiState } from '../../core/state';

export function useUiSnapshot(): RendererUiState {
  return useSyncExternalStore(subscribe, getUiSnapshot, getUiSnapshot);
}
