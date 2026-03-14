import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from './defaults.js';
import {
  resolveEffectiveBuyerConfig,
  resolveEffectiveRoleConfig,
  resolveEffectiveSellerConfig,
} from './effective.js';

test('effective seller config precedence is flags > env > config > defaults', () => {
  const config = createDefaultConfig();
  config.seller.pricing.defaults.inputUsdPerMillion = 10;
  config.seller.pricing.defaults.outputUsdPerMillion = 20;

  const env = {
    ANTSEED_SELLER_INPUT_USD_PER_MILLION: '30',
    ANTSEED_SELLER_OUTPUT_USD_PER_MILLION: '40',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveSellerConfig({
    config,
    env,
    sellerOverrides: {
      inputUsdPerMillion: 50,
    },
  });

  assert.equal(effective.pricing.defaults.inputUsdPerMillion, 50);
  assert.equal(effective.pricing.defaults.outputUsdPerMillion, 40);
});

test('effective buyer config precedence is flags > env > config > defaults', () => {
  const config = createDefaultConfig();
  config.buyer.minPeerReputation = 25;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 70;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 80;

  const env = {
    ANTSEED_BUYER_MIN_REPUTATION: '45',
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '90',
    ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION: '95',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveBuyerConfig({
    config,
    env,
    buyerOverrides: {
      minPeerReputation: 55,
      maxOutputUsdPerMillion: 99,
    },
  });

  assert.equal(effective.minPeerReputation, 55);
  assert.equal(effective.maxPricing.defaults.inputUsdPerMillion, 90);
  assert.equal(effective.maxPricing.defaults.outputUsdPerMillion, 99);
});

test('effective config resolution does not mutate loaded config', () => {
  const config = createDefaultConfig();
  const original = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '123',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveRoleConfig({
    config,
    env,
    sellerOverrides: {
      outputUsdPerMillion: 44,
    },
  });

  assert.equal(effective.buyer.maxPricing.defaults.inputUsdPerMillion, 123);
  assert.equal(effective.seller.pricing.defaults.outputUsdPerMillion, 44);
  assert.deepEqual(config, original);
});
