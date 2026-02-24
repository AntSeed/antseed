import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type {
  AntseedProviderPlugin,
  AntseedRouterPlugin,
  PluginConfigKey,
} from '@antseed/node';

// Import actual plugin packages (antseed-e2e depends on them via file: refs)
import providerPlugin from 'antseed-provider-anthropic';
import routerPlugin, { TOOL_HINTS } from 'antseed-router-claude-code';

// Import registry directly from CLI source (vitest can resolve .ts)
import { TRUSTED_PLUGINS, type TrustedPlugin } from '../../cli/src/plugins/registry.js';

// ---------------------------------------------------------------------------
// Helper: buildPluginConfig (mirrors antseed-cli/src/plugins/loader.ts)
// ---------------------------------------------------------------------------
function buildPluginConfig(configKeys: PluginConfigKey[]): Record<string, string> {
  const config: Record<string, string> = {};
  for (const key of configKeys) {
    const value = process.env[key.key];
    if (value !== undefined) {
      config[key.key] = value;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Plugin Loader
// ---------------------------------------------------------------------------
describe('Plugin Loader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'antseed-loader-test-'));
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('loads a valid provider plugin from a local path', async () => {
    // Create a minimal plugin module file
    const pluginDir = join(tmpDir, 'fake-provider');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default {
        name: 'test-provider',
        displayName: 'Test Provider',
        version: '1.0.0',
        type: 'provider',
        description: 'A test provider',
        configKeys: [],
        createProvider(config) {
          return {
            name: 'test',
            models: ['test-model'],
            pricing: {
              defaults: {
                inputUsdPerMillion: 10,
                outputUsdPerMillion: 10,
              },
            },
            maxConcurrency: 1,
            handleRequest: async (req) => ({
              requestId: req.requestId,
              statusCode: 200,
              headers: {},
              body: new Uint8Array(),
            }),
            getCapacity: () => ({ current: 0, max: 1 }),
          };
        },
      };`,
    );

    const pluginPath = pathToFileURL(join(pluginDir, 'index.mjs')).href;
    const mod = await import(pluginPath) as { default?: unknown };
    const plugin = mod.default as AntseedProviderPlugin;

    expect(plugin).toBeDefined();
    expect(plugin.type).toBe('provider');
    expect(plugin.name).toBe('test-provider');
    expect(typeof plugin.createProvider).toBe('function');
  });

  it('loads a valid router plugin from a local path', async () => {
    const pluginDir = join(tmpDir, 'fake-router');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default {
        name: 'test-router',
        displayName: 'Test Router',
        version: '1.0.0',
        type: 'router',
        description: 'A test router',
        configKeys: [],
        createRouter(config) {
          return {
            selectPeer: (_req, peers) => peers[0] || null,
            onResult: () => {},
          };
        },
      };`,
    );

    const pluginPath = pathToFileURL(join(pluginDir, 'index.mjs')).href;
    const mod = await import(pluginPath) as { default?: unknown };
    const plugin = mod.default as AntseedRouterPlugin;

    expect(plugin).toBeDefined();
    expect(plugin.type).toBe('router');
    expect(plugin.name).toBe('test-router');
    expect(typeof plugin.createRouter).toBe('function');
  });

  it('rejects a plugin with wrong type field', async () => {
    const pluginDir = join(tmpDir, 'bad-type');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default { name: 'bad', type: 'unknown', version: '1.0.0' };`,
    );

    const pluginPath = pathToFileURL(join(pluginDir, 'index.mjs')).href;
    const mod = await import(pluginPath) as { default?: unknown };
    const plugin = mod.default as { type?: string };

    // Replicate the loader's validation logic
    const isValidProvider = plugin && typeof plugin === 'object' && plugin.type === 'provider';
    const isValidRouter = plugin && typeof plugin === 'object' && plugin.type === 'router';

    expect(isValidProvider).toBe(false);
    expect(isValidRouter).toBe(false);
  });

  it('rejects a plugin with missing default export', async () => {
    const pluginDir = join(tmpDir, 'no-default');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export const name = 'not-a-default';`,
    );

    const pluginPath = pathToFileURL(join(pluginDir, 'index.mjs')).href;
    const mod = await import(pluginPath) as { default?: unknown };
    const plugin = mod.default;

    // The loader checks: !plugin || typeof plugin !== 'object'
    const isValid = plugin && typeof plugin === 'object';
    expect(isValid).toBeFalsy();
  });

  it('buildPluginConfig reads env vars by key name', () => {
    const originalEnv = process.env;
    try {
      process.env = {
        ...originalEnv,
        TEST_KEY_A: 'value-a',
        TEST_KEY_B: 'value-b',
      };

      const configKeys: PluginConfigKey[] = [
        { key: 'TEST_KEY_A', description: 'Key A', required: true },
        { key: 'TEST_KEY_B', description: 'Key B', required: false },
      ];

      const config = buildPluginConfig(configKeys);
      expect(config).toEqual({
        TEST_KEY_A: 'value-a',
        TEST_KEY_B: 'value-b',
      });
    } finally {
      process.env = originalEnv;
    }
  });

  it('buildPluginConfig skips missing env vars', () => {
    const originalEnv = process.env;
    try {
      process.env = { ...originalEnv, PRESENT_KEY: 'here' };
      delete process.env['ABSENT_KEY'];

      const configKeys: PluginConfigKey[] = [
        { key: 'PRESENT_KEY', description: 'Present', required: true },
        { key: 'ABSENT_KEY', description: 'Absent', required: false },
      ];

      const config = buildPluginConfig(configKeys);
      expect(config).toEqual({ PRESENT_KEY: 'here' });
      expect(config['ABSENT_KEY']).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------
describe('Plugin Registry', () => {
  it('has anthropic as a trusted provider', () => {
    const anthropic = TRUSTED_PLUGINS.find(
      (p: TrustedPlugin) => p.name === 'anthropic',
    );
    expect(anthropic).toBeDefined();
    expect(anthropic!.type).toBe('provider');
  });

  it('has claude-code as a trusted router', () => {
    const claudeCode = TRUSTED_PLUGINS.find(
      (p: TrustedPlugin) => p.name === 'claude-code',
    );
    expect(claudeCode).toBeDefined();
    expect(claudeCode!.type).toBe('router');
  });

  it('all trusted plugins have required fields (name, type, package, description)', () => {
    for (const plugin of TRUSTED_PLUGINS) {
      expect(plugin.name).toBeTruthy();
      expect(['provider', 'router']).toContain(plugin.type);
      expect(plugin.package).toBeTruthy();
      expect(plugin.description).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// antseed-provider-anthropic plugin shape
// ---------------------------------------------------------------------------
describe('antseed-provider-anthropic plugin shape', () => {
  it('satisfies AntseedProviderPlugin interface', () => {
    const plugin = providerPlugin as AntseedProviderPlugin;
    expect(plugin.name).toBe('anthropic');
    expect(plugin.displayName).toBeTruthy();
    expect(plugin.version).toBeTruthy();
    expect(plugin.description).toBeTruthy();
    expect(typeof plugin.createProvider).toBe('function');
  });

  it('has type === provider', () => {
    expect(providerPlugin.type).toBe('provider');
  });

  it('exports configKeys array', () => {
    expect(Array.isArray(providerPlugin.configKeys)).toBe(true);
    expect(providerPlugin.configKeys!.length).toBeGreaterThan(0);

    for (const key of providerPlugin.configKeys!) {
      expect(key.key).toBeTruthy();
      expect(key.description).toBeTruthy();
      expect(typeof key.required).toBe('boolean');
    }
  });

  it('createProvider returns a Provider', () => {
    const provider = providerPlugin.createProvider({
      ANTHROPIC_API_KEY: 'test-key',
      ANTSEED_AUTH_TYPE: 'apikey',
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBeTruthy();
    expect(Array.isArray(provider.models)).toBe(true);
    expect(typeof provider.pricing.defaults.inputUsdPerMillion).toBe('number');
    expect(typeof provider.pricing.defaults.outputUsdPerMillion).toBe('number');
    expect(typeof provider.maxConcurrency).toBe('number');
    expect(typeof provider.handleRequest).toBe('function');
    expect(typeof provider.getCapacity).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// antseed-router-claude-code plugin shape
// ---------------------------------------------------------------------------
describe('antseed-router-claude-code plugin shape', () => {
  it('satisfies AntseedRouterPlugin interface', () => {
    const plugin = routerPlugin as AntseedRouterPlugin;
    expect(plugin.name).toBe('claude-code');
    expect(plugin.displayName).toBeTruthy();
    expect(plugin.version).toBeTruthy();
    expect(plugin.description).toBeTruthy();
    expect(typeof plugin.createRouter).toBe('function');
  });

  it('has type === router', () => {
    expect(routerPlugin.type).toBe('router');
  });

  it('exports TOOL_HINTS array', () => {
    expect(Array.isArray(TOOL_HINTS)).toBe(true);
    expect(TOOL_HINTS.length).toBeGreaterThan(0);

    for (const hint of TOOL_HINTS) {
      expect(hint.name).toBeTruthy();
      expect(hint.envVar).toBeTruthy();
    }
  });

  it('createRouter returns a Router', () => {
    const router = routerPlugin.createRouter({});

    expect(router).toBeDefined();
    expect(typeof router.selectPeer).toBe('function');
    expect(typeof router.onResult).toBe('function');
  });
});
