export const DEFAULT_DASHBOARD_PORT = 3117;
export const POLL_INTERVAL_MS = 5000;

export const STORAGE_KEYS = {
  seedAuthPrefs: 'antseed-seed-auth-prefs',
  appMode: 'antseed-app-mode',
} as const;

export const DEFAULT_PROVIDER_RUNTIME = 'anthropic';
export const DEFAULT_ROUTER_RUNTIME = 'local';

export const PROVIDER_PACKAGE_ALIASES: Record<string, string> = {
  anthropic: '@antseed/provider-anthropic',
  openai: '@antseed/provider-openai',
  'local-llm': '@antseed/provider-local-llm',
  'provider-anthropic': '@antseed/provider-anthropic',
  'provider-openai': '@antseed/provider-openai',
  'provider-local-llm': '@antseed/provider-local-llm',
  'antseed-provider-anthropic': '@antseed/provider-anthropic',
  'antseed-provider-openai': '@antseed/provider-openai',
  'antseed-provider-local-llm': '@antseed/provider-local-llm',
  'claude-code': '@antseed/provider-claude-code',
  'provider-claude-code': '@antseed/provider-claude-code',
  'antseed-provider-claude-code': '@antseed/provider-claude-code',
  '@antseed/provider-claude-code': '@antseed/provider-claude-code',
  'claude-oauth': '@antseed/provider-claude-oauth',
  'provider-claude-oauth': '@antseed/provider-claude-oauth',
  '@antseed/provider-claude-oauth': '@antseed/provider-claude-oauth',
  '@antseed/provider-anthropic': '@antseed/provider-anthropic',
  '@antseed/provider-openai': '@antseed/provider-openai',
  '@antseed/provider-local-llm': '@antseed/provider-local-llm',
};

export const ROUTER_PACKAGE_ALIASES: Record<string, string> = {
  local: '@antseed/router-local',
  'claude-code': '@antseed/router-local',
  'router-local': '@antseed/router-local',
  'antseed-router-claude-code': '@antseed/router-local',
  'antseed-router-local': '@antseed/router-local',
  '@antseed/router-local': '@antseed/router-local',
};

export const UI_MESSAGES = {
  proxyPortInUse:
    'Buyer proxy port is already in use. Stop the conflicting process or change `buyer.proxyPort` in config.',
  desktopBridgeUnavailable:
    'Desktop bridge unavailable: preload failed to inject API. Restart app after main/preload compile.',
  localServicePortInUse: 'Local data service port already in use; reusing the existing service.',
  buyerAutoStarted: 'Buyer runtime auto-started for local proxy chat.',
} as const;
