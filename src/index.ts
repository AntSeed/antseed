import type { AntseedRouterPlugin } from '@antseed/node';
import { WELL_KNOWN_TOOL_HINTS, formatToolHints } from '@antseed/router-core';
import { LocalChatRouter } from './router.js';

const plugin: AntseedRouterPlugin = {
  name: 'local-chat',
  displayName: 'Local Chat',
  version: '0.1.0',
  type: 'router',
  description: 'Latency-prioritized router for desktop chat applications',
  configSchema: [
    { key: 'ANTSEED_MIN_REPUTATION', label: 'Min Reputation', type: 'number', required: false, default: 50, description: 'Min peer reputation 0-100' },
    { key: 'ANTSEED_MAX_FAILURES', label: 'Max Failures', type: 'number', required: false, default: 3, description: 'Max consecutive failures before excluding peer' },
    { key: 'ANTSEED_FAILURE_COOLDOWN_MS', label: 'Failure Cooldown (ms)', type: 'number', required: false, default: 30000, description: 'Cooldown after repeated failures (ms)' },
    { key: 'ANTSEED_MAX_PEER_STALENESS_MS', label: 'Max Peer Staleness (ms)', type: 'number', required: false, default: 300000, description: 'Peer staleness horizon (ms)' },
  ],
  createRouter(config: Record<string, string>) {
    const minReputation = config['ANTSEED_MIN_REPUTATION'] ? parseInt(config['ANTSEED_MIN_REPUTATION'], 10) : undefined;
    if (minReputation !== undefined && Number.isNaN(minReputation)) {
      throw new Error('ANTSEED_MIN_REPUTATION must be a valid number');
    }
    const maxFailures = config['ANTSEED_MAX_FAILURES'] ? parseInt(config['ANTSEED_MAX_FAILURES'], 10) : undefined;
    if (maxFailures !== undefined && Number.isNaN(maxFailures)) {
      throw new Error('ANTSEED_MAX_FAILURES must be a valid number');
    }
    const failureCooldownMs = config['ANTSEED_FAILURE_COOLDOWN_MS'] ? parseInt(config['ANTSEED_FAILURE_COOLDOWN_MS'], 10) : undefined;
    if (failureCooldownMs !== undefined && Number.isNaN(failureCooldownMs)) {
      throw new Error('ANTSEED_FAILURE_COOLDOWN_MS must be a valid number');
    }
    const maxPeerStalenessMs = config['ANTSEED_MAX_PEER_STALENESS_MS'] ? parseInt(config['ANTSEED_MAX_PEER_STALENESS_MS'], 10) : undefined;
    if (maxPeerStalenessMs !== undefined && Number.isNaN(maxPeerStalenessMs)) {
      throw new Error('ANTSEED_MAX_PEER_STALENESS_MS must be a valid number');
    }
    return new LocalChatRouter({
      minReputation,
      maxFailures,
      failureCooldownMs,
      maxPeerStalenessMs,
    });
  },
};

export default plugin;

export const TOOL_HINTS = WELL_KNOWN_TOOL_HINTS;
export { formatToolHints };
