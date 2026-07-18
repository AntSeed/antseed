import { concat, keccak256, toUtf8Bytes } from 'ethers';
import type { ExchangeRecord } from '../../src/verification/exchange-batch.js';

/**
 * Deterministic fixture records shared across test suites (the Solidity
 * tests pin the roots this generation produces — keep the derivation frozen):
 * record i has agentId i+1, requestHash = keccak256("req-i"),
 * responseHash = keccak256("res-i"), and a synthetic 65-byte signature of
 * keccak256("sig-i") ‖ keccak256("sig-i-s") ‖ 0x1b.
 */
export function buildFixtureRecords(n: number): ExchangeRecord[] {
  const records: ExchangeRecord[] = [];
  for (let i = 0; i < n; i++) {
    records.push({
      agentId: BigInt(i + 1),
      requestHash: keccak256(toUtf8Bytes(`req-${i}`)),
      responseHash: keccak256(toUtf8Bytes(`res-${i}`)),
      responseAuthSig: concat([
        keccak256(toUtf8Bytes(`sig-${i}`)),
        keccak256(toUtf8Bytes(`sig-${i}-s`)),
        '0x1b',
      ]),
    });
  }
  return records;
}
