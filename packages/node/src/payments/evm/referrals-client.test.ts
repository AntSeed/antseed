import { describe, expect, it } from 'vitest';
import { Wallet, verifyTypedData } from 'ethers';
import { REFERRAL_BIND_TYPES } from './referrals-client.js';

describe('referral binding typed data', () => {
  it('binds the buyer directly to the referrer wallet', async () => {
    const buyer = new Wallet(`0x${'11'.repeat(32)}`);
    const domain = {
      name: 'AntseedReferrals',
      version: '1',
      chainId: 8453,
      verifyingContract: `0x${'22'.repeat(20)}`,
    };
    const value = {
      buyer: buyer.address,
      referrer: `0x${'33'.repeat(20)}`,
      nonce: 0n,
      deadline: 1_800_000_000n,
    };
    const signature = await buyer.signTypedData(domain, REFERRAL_BIND_TYPES, value);
    expect(verifyTypedData(domain, REFERRAL_BIND_TYPES, value, signature)).toBe(buyer.address);
  });
});
