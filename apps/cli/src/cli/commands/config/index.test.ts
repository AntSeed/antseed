import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import {
  redactConfig,
  resolvePluginPackage,
  setConfigValue,
} from './index.js';

test('resolvePluginPackage maps trusted plugin aliases to package names', () => {
  assert.equal(resolvePluginPackage('openai'), '@antseed/provider-openai');
  assert.equal(resolvePluginPackage('@custom/provider'), '@custom/provider');
});

test('setConfigValue creates nested seller provider paths for dynamic keys', () => {
  const config = createDefaultConfig() as unknown as Record<string, unknown>;

  setConfigValue(
    config,
    'seller.providers.together.services.kimi-k2_5.pricing.inputUsdPerMillion',
    '0.5',
  );

  const seller = config['seller'] as Record<string, unknown>;
  const providers = seller['providers'] as Record<string, unknown>;
  const together = providers['together'] as Record<string, unknown>;
  const services = together['services'] as Record<string, unknown>;
  const kimi = services['kimi-k2_5'] as Record<string, unknown>;
  const pricing = kimi['pricing'] as Record<string, unknown>;

  assert.equal(pricing['inputUsdPerMillion'], 0.5);
});

test('redactConfig returns a detached clone of the config object', () => {
  const config = createDefaultConfig();
  config.identity.displayName = 'Original';

  const redacted = redactConfig(config);
  (redacted['identity'] as Record<string, unknown>)['displayName'] = 'Mutated';

  assert.equal(config.identity.displayName, 'Original');
});
