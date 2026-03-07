export const DEFAULT_DASHBOARD_PORT = 3117;
export const POLL_INTERVAL_MS = 5000;

export const DEFAULT_ROUTER_RUNTIME = 'local';

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
