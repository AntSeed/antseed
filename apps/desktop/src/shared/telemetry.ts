export const TELEMETRY_USER_ACTIONS = [
  'view_opened',
  'runtime_start',
  'runtime_stop',
  'discovery_refresh',
  'chat_new',
  'chat_open',
  'chat_send',
  'chat_stop',
  'chat_retry',
  'conversation_delete',
  'conversation_rename',
  'image_generate',
  'attachment_add',
  'model_picker_open',
  'model_select',
  'peer_select',
  'route_mode_change',
  'routing_preferences_change',
  'peer_access_change',
  'app_connect',
  'app_disconnect',
  'deposit_start',
  'withdraw_start',
  'workspace_change',
  'chat_permission_change',
  'tool_approval_decision',
  'settings_save',
  'plugin_install',
  'api_config_copy',
  'floating_window_open',
  'floating_window_close',
] as const;

export type TelemetryUserAction = (typeof TELEMETRY_USER_ACTIONS)[number];

export const TELEMETRY_ACTION_SURFACES = [
  'home',
  'explore',
  'model',
  'apps',
  'tunnels',
  'chats',
  'preferences',
  'credits',
  'deposit',
  'activity',
  'rewards',
  'chat',
  'help',
  'peers',
  'connection',
  'desktop',
  'config',
  'setup',
  'floating_window',
  'unknown',
] as const;

export type TelemetryActionSurface = (typeof TELEMETRY_ACTION_SURFACES)[number];

export type FirstModelShownSignal = {
  service: string;
  peerId?: string | null;
};

export type UserActionSignal = {
  action: TelemetryUserAction;
  surface: TelemetryActionSurface;
};
