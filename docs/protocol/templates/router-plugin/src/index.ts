import type { AntseedRouterPlugin } from '@antseed/node';
import { LowestLatencyRouter } from './router.js';

/**
 * Router plugin entry point.
 *
 * The default export must satisfy AntseedRouterPlugin.
 * The CLI loads this via dynamic import() and calls createRouter(config).
 *
 * Rename the package, change the name/displayName, and replace
 * LowestLatencyRouter with your own peer selection strategy.
 */
const plugin: AntseedRouterPlugin = {
  name: 'lowest-latency',
  displayName: 'Lowest Latency',
  version: '0.1.0',
  type: 'router',
  description: 'Routes requests to the peer with the lowest observed latency',
  configKeys: [
    // Declare the env vars your router needs.
    // The CLI reads these and passes them to createRouter() as { [key]: value }.
    // { key: 'MIN_REPUTATION', description: 'Minimum peer reputation 0–100', required: false },
  ],
  createRouter(_config) {
    return new LowestLatencyRouter();
  },
};

export default plugin;
