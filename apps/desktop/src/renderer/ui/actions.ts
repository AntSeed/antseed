import type { ConfigFormData, ExperienceMode } from '../core/state';
import type { RawChatAttachment } from '../types/bridge';

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
  sendMessage: (text: string, attachments?: RawChatAttachment[]) => void;
  abortChat: () => Promise<void>;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  handleServiceChange: (value: string, explicitPeerId?: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  rejectPaymentSession: () => void;
  retryAfterPayment: () => void;
  requestChannelClose: () => void;
  refreshCredits: () => void;
  refreshWorkspace: () => Promise<void>;
  refreshWorkspaceGitStatus: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  installPlugin: () => Promise<void>;
  setExperienceMode: (mode: ExperienceMode) => void;
  openPaymentsPortal?: (tab?: string) => void;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
