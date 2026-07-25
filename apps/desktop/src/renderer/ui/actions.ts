import type { ConfigFormData, VprPeerListing, VprRoutingPreferences } from '../core/state';
import type { ChatPermissionMode, RawChatAttachment, ToolApprovalDecision } from '../types/bridge';

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
  sendMessageToConversation: (convId: string, text: string, attachments?: RawChatAttachment[]) => void;
  abortChat: () => Promise<void>;
  deleteConversation: (convId?: string) => Promise<void>;
  renameConversation: (convId: string, newTitle: string) => void;
  handleServiceChange: (value: string, explicitPeerId?: string) => void;
  handleServiceFocus: () => void;
  handleServiceBlur: () => void;
  clearPinnedPeer: () => void;
  selectVprModel: (provider: string, serviceId: string, peerId?: string | null) => void;
  clearVprPinnedPeer: () => void;
  updateVprRoutingPreferences: (patch: Partial<VprRoutingPreferences>) => void;
  setVprPeerListing: (peerId: string, listing: VprPeerListing) => void;
  setChatPermissionMode: (mode: ChatPermissionMode) => void;
  decideToolApproval: (decision: ToolApprovalDecision, requestId?: string) => void;
  rejectPaymentSession: () => void;
  retryAfterPayment: () => void;
  refreshCredits: () => Promise<void>;
  refreshPaymentSummary: (force?: boolean) => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
  refreshPlugins: () => Promise<void>;
  installPlugin: () => Promise<void>;
  openVprFloat?: (profileName?: string, opts?: { openMenu?: boolean }) => Promise<void>;
  closeVprFloat?: () => Promise<void>;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
