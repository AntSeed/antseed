import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCryptoConfig } from '../../payment-utils.js';
import type { AntseedConfig } from '../../../config/types.js';

const address = '0x0000000000000000000000000000000000000011';

test('CLI local defaults use the registry nonce rather than the token nonce and preserve overrides', () => {
  const base = { payments: { crypto: { chainId: 'base-local' } } } as AntseedConfig;
  assert.equal(requireCryptoConfig(base).registryContractAddress, '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9');
  assert.equal(requireCryptoConfig({ ...base, payments: { ...base.payments, crypto: { ...base.payments!.crypto!, registryContractAddress: address } } }).registryContractAddress, address);
});
