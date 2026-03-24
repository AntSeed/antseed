import type { ConfigFormData } from '../core/state';
import type { ChatPermissionMode } from '../types/bridge';

export type AppActions = {
  startConnect: () => Promise<void>;
  stopConnect: () => Promise<void>;
  startAll: () => Promise<void>;
  stopAll: () => Promise<void>;
  refreshAll: () => Promise<void>;
  clearLogs: () => Promise<void>;
  scanDht: () => Promise<void>;
  saveConfig: (formData: ConfigFormData) => Promise<void>;
  createNewConversation: () => Promise<void>;
  startNewChat: () => void;
  openConversation: (id: string) => Promise<void>;
  sendMessage: (text: string, imageBase64?: string, imageMimeType?: string) => void;
  abortChat: () => Promise<void>;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  handleServiceChange: (value: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  approvePaymentSession: () => void;
  rejectPaymentSession: () => void;
  refreshCredits: () => void;
  refreshWorkspace: () => Promise<void>;
  refreshWorkspaceGitStatus: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  refreshPlugins: () => Promise<void>;
  installPlugin: () => Promise<void>;
  openPaymentsPortal?: () => void;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
