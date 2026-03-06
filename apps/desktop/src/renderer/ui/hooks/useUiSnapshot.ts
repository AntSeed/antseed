import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getStateRef } from '../../core/store';
import type { RendererUiState } from '../../core/state';

export function useUiSnapshot(): RendererUiState {
  useSyncExternalStore(subscribe, getSnapshot);
  const state = getStateRef();
  return {
    ...state,
    installedPlugins: new Set(state.installedPlugins),
    pluginHints: { ...state.pluginHints },
    peerSort: { ...state.peerSort },
    runtimeActivity: { ...state.runtimeActivity },
    configFormData: state.configFormData ? { ...state.configFormData } : null,
    configMessage: state.configMessage ? { ...state.configMessage } : null,
    logs: [...state.logs],
    overviewPeers: [...state.overviewPeers],
    lastPeers: [...state.lastPeers],
    chatConversations: [...state.chatConversations],
    chatMessages: [...state.chatMessages],
    chatModelOptions: [...state.chatModelOptions],
  };
}
