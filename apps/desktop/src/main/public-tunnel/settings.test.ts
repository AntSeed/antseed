import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublicTunnelSettings } from './settings.js';

test('parsePublicTunnelSettings defaults existing settings to disabled', () => {
  const settings = parsePublicTunnelSettings({
    activeProvider: 'ngrok',
    providers: {
      ngrok: { tunnelToken: 'token', publicUrl: '' },
    },
    apiKey: 'antseed_key',
  });

  assert.equal(settings?.activeProvider, 'ngrok');
  assert.equal(settings?.enabled, false);
});

test('parsePublicTunnelSettings preserves enabled state', () => {
  const settings = parsePublicTunnelSettings({
    activeProvider: 'cloudflare',
    providers: {
      cloudflare: { tunnelToken: 'token', publicUrl: 'https://llm.example.com' },
    },
    apiKey: 'antseed_key',
    enabled: true,
  });

  assert.equal(settings?.enabled, true);
});

test('parsePublicTunnelSettings migrates legacy Cloudflare settings as disabled', () => {
  const settings = parsePublicTunnelSettings({
    tunnelToken: 'token',
    publicUrl: 'https://llm.example.com',
    apiKey: 'antseed_key',
  });

  assert.deepEqual(settings, {
    activeProvider: 'cloudflare',
    providers: {
      cloudflare: { tunnelToken: 'token', publicUrl: 'https://llm.example.com' },
    },
    apiKey: 'antseed_key',
    enabled: false,
  });
});
