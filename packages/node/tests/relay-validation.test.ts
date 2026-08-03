import { Wallet, ZeroHash } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { AuditRelayJobPayload } from '../src/types/protocol.js';
import {
  RelayJobValidator,
  estimateFrozenRelayPayout,
  preflightRelayBudget,
} from '../src/verification/relay-validation.js';
import { hashRequest } from '../src/verification/response-auth.js';
import { serviceHash } from '../src/payments/evm/verifier-client.js';

const AUDIT_ID = '0x' + '11'.repeat(32);
const REGISTRY = '0x' + '22'.repeat(20);
const TREASURY = '0x' + '33'.repeat(20);
const VERIFIER_WALLET = new Wallet('0x' + '44'.repeat(32));
const VERIFIER = VERIFIER_WALLET.address;
const RELAY = '0x' + '55'.repeat(20);
const SELLER = '0x' + '66'.repeat(20);
const ROOT = '0x' + '77'.repeat(32);
const SERVICE = 'gpt-5.6-sol';
const ASSIGNMENT_DIGEST = '0x' + 'aa'.repeat(32);

function request(): SerializedHttpRequest {
  return {
    requestId: 'audit-1-job-0',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      model: SERVICE,
      messages: [{ role: 'user', content: 'test' }],
      max_completion_tokens: 160,
      temperature: 0,
    })),
  };
}

function offer(): AuditRelayJobPayload {
  const exactRequest = request();
  return {
    version: 1,
    jobId: `${AUDIT_ID}:0`,
    chainId: 'base-local',
    registryAddress: REGISTRY,
    treasuryAddress: TREASURY,
    auditSnapshot: {
      committer: VERIFIER,
      auditJobRoot: ROOT,
      jobCount: 10,
      payoutPerJobUsdc: '2500',
      reservedRelayBudgetUsdc: '25000',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
      forceClaimAvailableAt: 1_800_022_200,
      forceClaimDeadline: 1_802_614_200,
      attested: false,
    },
    job: {
      auditId: AUDIT_ID,
      jobIndex: 0,
      sellerPeerId: SELLER,
      serviceHash: serviceHash(SERVICE),
      requestHash: hashRequest(exactRequest),
      jobSalt: '0x' + '88'.repeat(32),
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    jobProof: ['0x' + '99'.repeat(32)],
    assignment: {
      auditId: AUDIT_ID,
      jobIndex: 0,
      attempt: 0,
      relayBuyer: RELAY,
      payoutPerJobUsdc: '2500',
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
    },
    verifierSignature: VERIFIER_WALLET.signingKey.sign(ASSIGNMENT_DIGEST).serialized,
    targetPeerId: SELLER.slice(2),
    service: SERVICE,
    requestBytesBase64: Buffer.from(encodeHttpRequest(exactRequest)).toString('base64'),
    payoutPerJobUsdc: '2500',
    timeoutMs: 30_000,
  };
}

function clients(overrides: {
  paidRequestHash?: string;
  proofValid?: boolean;
  remainingBudgetUsdc?: bigint;
  released?: boolean;
} = {}) {
  const registry = {
    getAudit: vi.fn().mockResolvedValue({
      committer: VERIFIER,
      auditJobRoot: ROOT,
      jobCount: 10,
      payoutPerJobUsdc: 2500n,
      reservedRelayBudgetUsdc: 25000n,
      executeAfter: 1_800_000_000,
      executeBefore: 1_800_000_600,
      forceClaimAvailableAt: 1_800_022_200,
      forceClaimDeadline: 1_802_614_200,
      attested: false,
    }),
    hashAuditJob: vi.fn().mockResolvedValue('0x' + 'aa'.repeat(32)),
    hashRelayAssignment: vi.fn().mockResolvedValue(ASSIGNMENT_DIGEST),
    isRelayJobPaid: vi.fn().mockResolvedValue(false),
    paidRequestHash: vi.fn().mockResolvedValue(overrides.paidRequestHash ?? ZeroHash),
    verifyAuditJobProof: vi.fn().mockResolvedValue(overrides.proofValid ?? true),
  };
  const treasury = {
    getReservation: vi.fn().mockResolvedValue({
      payoutPerJobUsdc: 2500n,
      totalBudgetUsdc: 25000n,
      remainingBudgetUsdc: overrides.remainingBudgetUsdc ?? 25000n,
      jobCount: 10,
      released: overrides.released ?? false,
    }),
  };
  return { registry, treasury };
}

describe('RelayJobValidator', () => {
  it('accepts a funded, committed, byte-exact job in its execution window', async () => {
    const { registry, treasury } = clients();
    const validator = new RelayJobValidator({
      chainId: 'base-local',
      registryAddress: REGISTRY,
      treasuryAddress: TREASURY,
      relayBuyerAddress: RELAY,
      minimumPayoutPerJobUsdc: 2000n,
      verifierRegistryClient: registry as never,
      relayTreasuryClient: treasury as never,
      now: () => 1_800_000_100_000,
    });

    await expect(validator.validate(offer())).resolves.toMatchObject({
      request: { requestId: 'audit-1-job-0' },
      job: { auditId: AUDIT_ID, jobIndex: 0, sellerPeerId: SELLER },
    });
    expect(registry.verifyAuditJobProof).toHaveBeenCalledWith(ROOT, '0x' + 'aa'.repeat(32), 0, 10, [
      '0x' + '99'.repeat(32),
    ]);
  });

  it('rejects replayed requests before seller execution', async () => {
    const { registry, treasury } = clients({ paidRequestHash: '0x' + 'ab'.repeat(32) });
    const validator = new RelayJobValidator({
      chainId: 'base-local',
      registryAddress: REGISTRY,
      treasuryAddress: TREASURY,
      relayBuyerAddress: RELAY,
      minimumPayoutPerJobUsdc: 0n,
      verifierRegistryClient: registry as never,
      relayTreasuryClient: treasury as never,
      now: () => 1_800_000_100_000,
    });
    await expect(validator.validate(offer())).rejects.toThrow(/already paid/);
  });

  it('rejects malformed proofs and underfunded reservations', async () => {
    const invalidProof = clients({ proofValid: false });
    const proofValidator = new RelayJobValidator({
      chainId: 'base-local',
      registryAddress: REGISTRY,
      treasuryAddress: TREASURY,
      relayBuyerAddress: RELAY,
      minimumPayoutPerJobUsdc: 0n,
      verifierRegistryClient: invalidProof.registry as never,
      relayTreasuryClient: invalidProof.treasury as never,
      now: () => 1_800_000_100_000,
    });
    await expect(proofValidator.validate(offer())).rejects.toThrow(/positional job proof/);

    const underfunded = clients({ remainingBudgetUsdc: 1000n });
    const fundingValidator = new RelayJobValidator({
      chainId: 'base-local',
      registryAddress: REGISTRY,
      treasuryAddress: TREASURY,
      relayBuyerAddress: RELAY,
      minimumPayoutPerJobUsdc: 0n,
      verifierRegistryClient: underfunded.registry as never,
      relayTreasuryClient: underfunded.treasury as never,
      now: () => 1_800_000_100_000,
    });
    await expect(fundingValidator.validate(offer())).rejects.toThrow(/exhausted/);
  });
});

describe('relay payout preflight', () => {
  it('freezes the maximum seller quote plus the flat relay fee', () => {
    expect(estimateFrozenRelayPayout([900n, 1200n, 1100n], 300n)).toBe(1500n);
  });

  it('checks all treasury caps and available funding before commitment', async () => {
    const treasury = {
      maxPayoutPerJob: vi.fn().mockResolvedValue(3000n),
      maxPayoutPerAudit: vi.fn().mockResolvedValue(30000n),
      maxCommittedBudgetPerEpoch: vi.fn().mockResolvedValue(100000n),
      committedBudgetByEpoch: vi.fn().mockResolvedValue(5000n),
      availableBalance: vi.fn().mockResolvedValue(50000n),
    };
    await expect(preflightRelayBudget({
      treasury: treasury as never,
      epoch: 4n,
      jobCount: 10,
      payoutPerJobUsdc: 2500n,
    })).resolves.toEqual({ requiredBudgetUsdc: 25000n });

    treasury.availableBalance.mockResolvedValue(24999n);
    await expect(preflightRelayBudget({
      treasury: treasury as never,
      epoch: 4n,
      jobCount: 10,
      payoutPerJobUsdc: 2500n,
    })).rejects.toThrow(/underfunded/);
  });
});
