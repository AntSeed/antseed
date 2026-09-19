import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicTunnelLifecycle, type PublicTunnelStatus } from './lifecycle.js';
import type { PublicTunnelSettings } from './settings.js';

const readyStatus: PublicTunnelStatus = {
  configured: true,
  configuredProviders: ['ngrok', 'cloudflare'],
  activeProvider: 'ngrok',
  running: true,
  baseUrl: 'https://example.ngrok.app/v1',
};

function createHarness(initialSettings: PublicTunnelSettings, status = readyStatus) {
  let settings = initialSettings;
  let running = false;
  let stopCount = 0;
  const starts: Array<Record<string, unknown>> = [];
  const saves: PublicTunnelSettings[] = [];
  const lifecycle = createPublicTunnelLifecycle({
    loadSettings: async () => settings,
    saveSettings: async (nextSettings) => {
      settings = nextSettings;
      saves.push(nextSettings);
    },
    isRunning: () => running,
    startProcess: async (options) => {
      starts.push(options);
      running = true;
    },
    stopProcess: async () => {
      stopCount += 1;
      running = false;
    },
    resolveBuyerPort: async () => 8377,
    waitForReady: async () => status,
  });
  return {
    lifecycle,
    saves,
    starts,
    getSettings: () => settings,
    getStopCount: () => stopCount,
  };
}

function configuredSettings(enabled = false): PublicTunnelSettings {
  return {
    activeProvider: 'cloudflare',
    providers: {
      cloudflare: { tunnelToken: 'cloudflare-token', publicUrl: 'https://llm.example.com' },
      ngrok: { tunnelToken: 'ngrok-token', publicUrl: '' },
    },
    apiKey: 'antseed_key',
    enabled,
  };
}

test('successful start persists enabled state and selected provider', async () => {
  const harness = createHarness(configuredSettings());

  const result = await harness.lifecycle.start('ngrok');

  assert.equal(result.ok, true);
  assert.equal(harness.starts.length, 1);
  assert.deepEqual(harness.starts[0], {
    provider: 'ngrok',
    buyerPort: 8377,
    tunnelToken: 'ngrok-token',
    publicUrl: '',
    apiKey: 'antseed_key',
  });
  assert.equal(harness.getSettings().activeProvider, 'ngrok');
  assert.equal(harness.getSettings().enabled, true);
});

test('failed start does not persist enabled state', async () => {
  const harness = createHarness(configuredSettings(), { ...readyStatus, running: false, baseUrl: null });

  const result = await harness.lifecycle.start();

  assert.equal(result.ok, false);
  assert.equal(harness.saves.length, 0);
  assert.equal(harness.getSettings().enabled, false);
});

test('manual stop persists disabled state before stopping the process', async () => {
  const harness = createHarness(configuredSettings(true));

  await harness.lifecycle.stop();

  assert.equal(harness.getSettings().enabled, false);
  assert.equal(harness.getStopCount(), 1);
});

test('restore starts the previously enabled provider', async () => {
  const harness = createHarness(configuredSettings(true));

  const result = await harness.lifecycle.restore();

  assert.equal(result?.ok, true);
  assert.equal(harness.starts[0]?.['provider'], 'cloudflare');
});

test('restore leaves disabled tunnels stopped', async () => {
  const harness = createHarness(configuredSettings(false));

  const result = await harness.lifecycle.restore();

  assert.equal(result, null);
  assert.equal(harness.starts.length, 0);
});
