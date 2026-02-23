import type { AntseedProviderPlugin } from 'antseed-node';
import { EchoProvider } from './provider.js';

/**
 * Provider plugin entry point.
 *
 * The default export must satisfy AntseedProviderPlugin.
 * The CLI loads this via dynamic import() and calls createProvider(config).
 *
 * Rename the package, change the name/displayName, and replace
 * EchoProvider with your real inference implementation.
 */
const plugin: AntseedProviderPlugin = {
  name: 'echo',
  displayName: 'Echo',
  version: '0.1.0',
  type: 'provider',
  description: 'A minimal echo provider — replace with real inference logic',
  configKeys: [
    // Declare the env vars your provider needs.
    // The CLI reads these and passes them to createProvider() as { [key]: value }.
    // { key: 'MY_API_KEY', description: 'API key for my LLM service', required: true, secret: true },
  ],
  createProvider(config) {
    return new EchoProvider(config);
  },
};

export default plugin;
