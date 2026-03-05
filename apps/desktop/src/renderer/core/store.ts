import type { RendererUiState } from './state';

type Listener = () => void;

let listeners: Listener[] = [];
let version = 0;
let stateRef: RendererUiState | null = null;

export function initStore(state: RendererUiState): void {
  stateRef = state;
}

export function notifyUiStateChanged(): void {
  version++;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribe(listener: Listener): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function getSnapshot(): number {
  return version;
}

export function getStateRef(): RendererUiState {
  if (!stateRef) {
    throw new Error('Store not initialized — call initStore() before rendering');
  }
  return stateRef;
}
