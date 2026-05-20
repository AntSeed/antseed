import { randomBytes } from 'node:crypto';
import type { AbstractSigner } from 'ethers';
import type { Identity } from '../p2p/identity.js';
import type { VerificationMux } from '../p2p/verification-mux.js';
import type { StakingClient } from './evm/staking-client.js';
import { UsageVerificationClient } from './evm/usage-verification-client.js';
import type { UsageVerificationClientConfig } from './evm/usage-verification-client.js';
import type { StoredChannel } from './channel-store.js';
import { UsageVerificationStore } from './usage-verification-store.js';
import type { UsageAttestationRecord, UsageSnapshotRecord } from './usage-verification-store.js';
import type {
  VerificationCommitRequestPayload,
  VerificationCommitResponsePayload,
  VerificationRevealPackagePayload,
  VerificationRevealResponsePayload,
  VerificationUsageClaimPayload,
} from '../types/protocol.js';
import {
  computeServiceKey,
  computeUsageClaimHash,
  computeUsageRevealHash,
  makeUsageVerificationDomain,
  signUsageCommit,
  USAGE_CLAIM_VERSION,
  USAGE_PARTY_BUYER,
  USAGE_PARTY_SELLER,
} from './evm/signatures.js';
import type { UsageClaimMessage } from './evm/signatures.js';
import { debugWarn } from '../utils/debug.js';
import { computeCostUsdc, type ServicePricing } from './pricing.js';

export interface UsageVerificationConfig extends UsageVerificationClientConfig {
  chainId: number;
  dataDir: string;
}

export interface SellerUsageRecordInput {
  requestId: string;
  channel: StoredChannel;
  providerName: string;
  serviceName: string;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  freshInputTokens: bigint;
  outputTokens: bigint;
  costUsdc: bigint;
  paymentCumulativeAmount: bigint;
  mux: VerificationMux;
}

export class SellerUsageVerificationManager {
  private _signer: AbstractSigner;
  private readonly _client: UsageVerificationClient;
  private readonly _store: UsageVerificationStore;
  private readonly _domain: ReturnType<typeof makeUsageVerificationDomain>;
  private readonly _stakingClient?: StakingClient;

  constructor(identity: Identity, config: UsageVerificationConfig, stakingClient?: StakingClient) {
    this._signer = identity.wallet;
    this._client = new UsageVerificationClient(config);
    this._store = new UsageVerificationStore(config.dataDir);
    this._domain = makeUsageVerificationDomain(config.chainId, config.contractAddress);
    this._stakingClient = stakingClient;
  }

  get client(): UsageVerificationClient { return this._client; }

  setSigner(signer: AbstractSigner): void { this._signer = signer; }

  async recordAndRequestCommit(input: SellerUsageRecordInput): Promise<void> {
    const epoch = (await this._client.currentEpoch()).toString();
    const serviceKey = computeServiceKey(input.providerName, input.serviceName);
    const existing = this._store.getSnapshot(input.channel.sessionId, serviceKey, epoch);
    const now = Date.now();
    const sellerAgentId = await this._resolveSellerAgentId(input.channel.sellerEvmAddr);

    const snapshot: UsageSnapshotRecord = {
      channelId: input.channel.sessionId,
      serviceKey,
      providerName: input.providerName,
      serviceName: input.serviceName,
      epoch,
      buyerEvmAddr: input.channel.buyerEvmAddr,
      sellerEvmAddr: input.channel.sellerEvmAddr,
      sellerAgentId: sellerAgentId.toString(),
      cumulativeInputTokens: ((existing ? BigInt(existing.cumulativeInputTokens) : 0n) + input.inputTokens).toString(),
      cumulativeCachedInputTokens: ((existing ? BigInt(existing.cumulativeCachedInputTokens) : 0n) + input.cachedInputTokens).toString(),
      cumulativeFreshInputTokens: ((existing ? BigInt(existing.cumulativeFreshInputTokens) : 0n) + input.freshInputTokens).toString(),
      cumulativeOutputTokens: ((existing ? BigInt(existing.cumulativeOutputTokens) : 0n) + input.outputTokens).toString(),
      cumulativeRequestCount: ((existing ? BigInt(existing.cumulativeRequestCount) : 0n) + 1n).toString(),
      cumulativeCostUsdc: ((existing ? BigInt(existing.cumulativeCostUsdc) : 0n) + input.costUsdc).toString(),
      paymentCumulativeAmount: input.paymentCumulativeAmount.toString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this._store.upsertSnapshot(snapshot);

    const claim = snapshotToClaim(snapshot);
    const claimMsg = claimPayloadToMessage(claim);
    const claimHash = computeUsageClaimHash(claimMsg);
    const sellerNonce = randomNonce();
    const sellerRevealHash = computeUsageRevealHash(claimHash, sellerNonce);
    const expectedEpoch = BigInt(epoch);
    const sellerSig = await signUsageCommit(this._signer, this._domain, {
      claimHash,
      revealHash: sellerRevealHash,
      expectedEpoch,
      party: USAGE_PARTY_SELLER,
    });

    this._store.upsertAttestation({
      claimHash,
      requestId: input.requestId,
      channelId: input.channel.sessionId,
      serviceKey,
      epoch,
      claim,
      buyerRevealHash: null,
      sellerRevealHash,
      buyerNonce: null,
      sellerNonce,
      buyerSig: null,
      sellerSig,
      commitTxHash: null,
      revealTxHash: null,
      status: 'pending_buyer',
      createdAt: now,
      updatedAt: now,
    });

    input.mux.sendCommitRequest({
      requestId: input.requestId,
      claim,
      claimHash,
      revealHash: sellerRevealHash,
      expectedEpoch: epoch,
      sellerSig,
    });
  }

  async handleCommitResponse(payload: VerificationCommitResponsePayload, mux: VerificationMux): Promise<void> {
    const attestation = this._store.getAttestation(payload.claimHash);
    if (!attestation) return;
    if (!payload.accepted || !payload.buyerSig || !payload.revealHash) {
      this._store.updateAttestationStatus(payload.claimHash, 'failed');
      debugWarn(`[UsageVerification] Buyer rejected usage commit ${payload.claimHash.slice(0, 18)}...: ${payload.reason ?? 'unknown'}`);
      return;
    }

    const updated: UsageAttestationRecord = {
      ...attestation,
      buyerRevealHash: payload.revealHash,
      buyerSig: payload.buyerSig,
      status: 'buyer_signed',
      updatedAt: Date.now(),
    };
    this._store.upsertAttestation(updated);

    let commitTxHash: string | undefined;
    try {
      commitTxHash = await this._client.commitPair(this._signer, {
        claimHash: updated.claimHash,
        channelId: updated.channelId,
        buyer: updated.claim.buyer,
        seller: updated.claim.seller,
        sellerAgentId: BigInt(updated.claim.sellerAgentId),
        serviceKey: updated.serviceKey,
        buyerRevealHash: payload.revealHash,
        sellerRevealHash: updated.sellerRevealHash!,
        expectedEpoch: BigInt(updated.epoch),
        buyerSig: payload.buyerSig,
        sellerSig: updated.sellerSig!,
      });
      this._store.updateAttestationStatus(updated.claimHash, 'committed', { commitTxHash });
      mux.sendCommitProof({ requestId: updated.requestId, claimHash: updated.claimHash, txHash: commitTxHash });
    } catch (err) {
      this._store.updateAttestationStatus(updated.claimHash, 'failed');
      debugWarn(`[UsageVerification] commitPair failed: ${err instanceof Error ? err.message : err}`);
      return;
    }

    mux.sendRevealPackage({
      requestId: updated.requestId,
      claim: updated.claim,
      claimHash: updated.claimHash,
      nonce: updated.sellerNonce!,
      party: 'seller',
    });
  }

  async retryCommittedReveals(limit = 25): Promise<void> {
    const committed = this._store.listAttestationsByStatus('committed', limit);
    for (const attestation of committed) {
      if (!attestation.buyerNonce || !attestation.sellerNonce) continue;
      try {
        const txHash = await this._client.revealPair(
          this._signer,
          claimPayloadToMessage(attestation.claim),
          attestation.buyerNonce,
          attestation.sellerNonce,
        );
        this._store.updateAttestationStatus(attestation.claimHash, 'revealed', { revealTxHash: txHash });
      } catch {
        // Payment coverage may still be pending; leave as committed for the next retry.
      }
    }
  }

  async handleRevealResponse(payload: VerificationRevealResponsePayload, mux: VerificationMux): Promise<void> {
    const attestation = this._store.getAttestation(payload.claimHash);
    if (!attestation || !payload.accepted || !payload.nonce) return;
    if (!attestation.sellerNonce) return;
    this._store.upsertAttestation({ ...attestation, buyerNonce: payload.nonce, updatedAt: Date.now() });

    try {
      const txHash = await this._client.revealPair(
        this._signer,
        claimPayloadToMessage(attestation.claim),
        payload.nonce,
        attestation.sellerNonce,
      );
      this._store.updateAttestationStatus(attestation.claimHash, 'revealed', { revealTxHash: txHash });
      mux.sendRevealAck({ requestId: attestation.requestId, claimHash: attestation.claimHash, txHash });
    } catch (err) {
      // Most commonly payment coverage has not landed yet. Keep committed state
      // so a future retry can reveal after settlement.
      this._store.updateAttestationStatus(attestation.claimHash, 'committed');
      debugWarn(`[UsageVerification] revealPair deferred: ${err instanceof Error ? err.message : err}`);
    }
  }

  close(): void { this._store.close(); }

  private async _resolveSellerAgentId(seller: string): Promise<bigint> {
    if (!this._stakingClient) return 0n;
    try { return BigInt(await this._stakingClient.getAgentId(seller)); } catch { return 0n; }
  }
}

export class BuyerUsageVerificationManager {
  private readonly _identity: Identity;
  private _signer: AbstractSigner;
  private readonly _domain: ReturnType<typeof makeUsageVerificationDomain>;
  private readonly _store: UsageVerificationStore;
  private readonly _requestService = new Map<string, string>();

  constructor(identity: Identity, config: UsageVerificationConfig) {
    this._identity = identity;
    this._signer = identity.wallet;
    this._domain = makeUsageVerificationDomain(config.chainId, config.contractAddress);
    this._store = new UsageVerificationStore(config.dataDir);
  }

  setSigner(signer: AbstractSigner): void { this._signer = signer; }

  trackRequestService(requestId: string, service: string): void {
    this._requestService.set(requestId, service);
  }

  async handleCommitRequest(payload: VerificationCommitRequestPayload, mux: VerificationMux): Promise<void> {
    const expectedService = this._requestService.get(payload.requestId);
    if (expectedService && expectedService !== payload.claim.serviceName) {
      mux.sendCommitResponse({
        requestId: payload.requestId,
        accepted: false,
        claimHash: payload.claimHash,
        reason: `service mismatch: expected ${expectedService}, got ${payload.claim.serviceName}`,
      });
      return;
    }
    if (payload.claim.buyer.toLowerCase() !== this._identity.wallet.address.toLowerCase()) {
      mux.sendCommitResponse({ requestId: payload.requestId, accepted: false, claimHash: payload.claimHash, reason: 'buyer mismatch' });
      return;
    }

    const claimHash = computeUsageClaimHash(claimPayloadToMessage(payload.claim));
    if (claimHash !== payload.claimHash) {
      mux.sendCommitResponse({ requestId: payload.requestId, accepted: false, claimHash: payload.claimHash, reason: 'claim hash mismatch' });
      return;
    }

    const buyerNonce = randomNonce();
    const buyerRevealHash = computeUsageRevealHash(claimHash, buyerNonce);
    const buyerSig = await signUsageCommit(this._signer, this._domain, {
      claimHash,
      revealHash: buyerRevealHash,
      expectedEpoch: BigInt(payload.expectedEpoch),
      party: USAGE_PARTY_BUYER,
    });

    const now = Date.now();
    this._store.upsertAttestation({
      claimHash,
      requestId: payload.requestId,
      channelId: payload.claim.channelId,
      serviceKey: payload.claim.serviceKey,
      epoch: payload.expectedEpoch,
      claim: payload.claim,
      buyerRevealHash,
      sellerRevealHash: payload.revealHash,
      buyerNonce,
      sellerNonce: null,
      buyerSig,
      sellerSig: payload.sellerSig,
      commitTxHash: null,
      revealTxHash: null,
      status: 'buyer_signed',
      createdAt: now,
      updatedAt: now,
    });

    mux.sendCommitResponse({
      requestId: payload.requestId,
      accepted: true,
      claimHash,
      revealHash: buyerRevealHash,
      buyerSig,
    });
  }

  handleRevealPackage(payload: VerificationRevealPackagePayload, mux: VerificationMux): void {
    const attestation = this._store.getAttestation(payload.claimHash);
    if (!attestation || !attestation.buyerNonce) {
      mux.sendRevealResponse({ requestId: payload.requestId, accepted: false, claimHash: payload.claimHash, reason: 'unknown claim' });
      return;
    }
    this._store.upsertAttestation({ ...attestation, sellerNonce: payload.nonce, status: 'committed', updatedAt: Date.now() });
    mux.sendRevealResponse({
      requestId: payload.requestId,
      accepted: true,
      claimHash: payload.claimHash,
      nonce: attestation.buyerNonce,
    });
  }

  handleRevealAck(payload: { claimHash: string; txHash?: string }): void {
    this._store.updateAttestationStatus(payload.claimHash, 'revealed', { revealTxHash: payload.txHash });
  }

  close(): void { this._store.close(); }
}

export function claimPayloadToMessage(claim: VerificationUsageClaimPayload): UsageClaimMessage {
  return {
    version: BigInt(claim.version),
    channelId: claim.channelId,
    buyer: claim.buyer,
    seller: claim.seller,
    sellerAgentId: BigInt(claim.sellerAgentId),
    serviceKey: claim.serviceKey,
    providerName: claim.providerName,
    serviceName: claim.serviceName,
    cumulativeInputTokens: BigInt(claim.cumulativeInputTokens),
    cumulativeCachedInputTokens: BigInt(claim.cumulativeCachedInputTokens),
    cumulativeFreshInputTokens: BigInt(claim.cumulativeFreshInputTokens),
    cumulativeOutputTokens: BigInt(claim.cumulativeOutputTokens),
    cumulativeRequestCount: BigInt(claim.cumulativeRequestCount),
    cumulativeCostUsdc: BigInt(claim.cumulativeCostUsdc),
    paymentCumulativeAmount: BigInt(claim.paymentCumulativeAmount),
  };
}

function snapshotToClaim(snapshot: UsageSnapshotRecord): VerificationUsageClaimPayload {
  return {
    version: USAGE_CLAIM_VERSION.toString(),
    channelId: snapshot.channelId,
    buyer: snapshot.buyerEvmAddr,
    seller: snapshot.sellerEvmAddr,
    sellerAgentId: snapshot.sellerAgentId,
    serviceKey: snapshot.serviceKey,
    providerName: snapshot.providerName,
    serviceName: snapshot.serviceName,
    cumulativeInputTokens: snapshot.cumulativeInputTokens,
    cumulativeCachedInputTokens: snapshot.cumulativeCachedInputTokens,
    cumulativeFreshInputTokens: snapshot.cumulativeFreshInputTokens,
    cumulativeOutputTokens: snapshot.cumulativeOutputTokens,
    cumulativeRequestCount: snapshot.cumulativeRequestCount,
    cumulativeCostUsdc: snapshot.cumulativeCostUsdc,
    paymentCumulativeAmount: snapshot.paymentCumulativeAmount,
  };
}

function randomNonce(): string {
  return '0x' + randomBytes(32).toString('hex');
}

export function computeUsageCostFromTokens(params: {
  freshInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  pricing: ServicePricing;
}): bigint {
  return computeCostUsdc(params.freshInputTokens, params.outputTokens, params.pricing, params.cachedInputTokens);
}
