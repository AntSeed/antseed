import type { ConfigFormData } from '../core/state';

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
  handleModelChange: (value: string) => void;
  handleModelFocus: () => void;
  handleModelBlur: () => void;
  refreshPlugins: () => Promise<void>;
  installPlugin: () => Promise<void>;
};

let _actions: AppActions | null = null;

export function registerActions(actions: AppActions): void {
  _actions = actions;
}

export function getActions(): AppActions {
  if (!_actions) throw new Error('App actions not yet registered');
  return _actions;
}
