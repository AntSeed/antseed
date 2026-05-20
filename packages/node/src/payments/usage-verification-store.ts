import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../storage/migrate.js';
import { channelMigrations } from '../storage/migrations/channels/index.js';
import type { VerificationUsageClaimPayload } from '../types/protocol.js';

export interface UsageSnapshotRecord {
  channelId: string;
  serviceKey: string;
  providerName: string;
  serviceName: string;
  epoch: string;
  buyerEvmAddr: string;
  sellerEvmAddr: string;
  sellerAgentId: string;
  cumulativeInputTokens: string;
  cumulativeCachedInputTokens: string;
  cumulativeFreshInputTokens: string;
  cumulativeOutputTokens: string;
  cumulativeRequestCount: string;
  cumulativeCostUsdc: string;
  paymentCumulativeAmount: string;
  createdAt: number;
  updatedAt: number;
}

export type UsageAttestationStatus = 'pending_buyer' | 'buyer_signed' | 'committed' | 'revealed' | 'partial' | 'failed';

export interface UsageAttestationRecord {
  claimHash: string;
  requestId: string;
  channelId: string;
  serviceKey: string;
  epoch: string;
  claim: VerificationUsageClaimPayload;
  buyerRevealHash: string | null;
  sellerRevealHash: string | null;
  buyerNonce: string | null;
  sellerNonce: string | null;
  buyerSig: string | null;
  sellerSig: string | null;
  commitTxHash: string | null;
  revealTxHash: string | null;
  status: UsageAttestationStatus;
  createdAt: number;
  updatedAt: number;
}

export class UsageVerificationStore {
  private readonly _db: Database.Database;
  private readonly _stmts: {
    upsertSnapshot: Database.Statement;
    getSnapshot: Database.Statement;
    upsertAttestation: Database.Statement;
    getAttestation: Database.Statement;
    listAttestationsByStatus: Database.Statement;
    updateAttestationStatus: Database.Statement;
  };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this._db = new Database(join(dataDir, 'sessions.db'));
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, channelMigrations);
    this._stmts = {
      upsertSnapshot: this._db.prepare(`
        INSERT INTO usage_verification_snapshots (
          channel_id, service_key, provider_name, service_name, epoch,
          buyer_evm_addr, seller_evm_addr, seller_agent_id,
          cumulative_input_tokens, cumulative_cached_input_tokens, cumulative_fresh_input_tokens,
          cumulative_output_tokens, cumulative_request_count, cumulative_cost_usdc, payment_cumulative_amount,
          created_at, updated_at
        ) VALUES (
          @channelId, @serviceKey, @providerName, @serviceName, @epoch,
          @buyerEvmAddr, @sellerEvmAddr, @sellerAgentId,
          @cumulativeInputTokens, @cumulativeCachedInputTokens, @cumulativeFreshInputTokens,
          @cumulativeOutputTokens, @cumulativeRequestCount, @cumulativeCostUsdc, @paymentCumulativeAmount,
          @createdAt, @updatedAt
        )
        ON CONFLICT(channel_id, service_key, epoch) DO UPDATE SET
          provider_name = @providerName,
          service_name = @serviceName,
          buyer_evm_addr = @buyerEvmAddr,
          seller_evm_addr = @sellerEvmAddr,
          seller_agent_id = @sellerAgentId,
          cumulative_input_tokens = @cumulativeInputTokens,
          cumulative_cached_input_tokens = @cumulativeCachedInputTokens,
          cumulative_fresh_input_tokens = @cumulativeFreshInputTokens,
          cumulative_output_tokens = @cumulativeOutputTokens,
          cumulative_request_count = @cumulativeRequestCount,
          cumulative_cost_usdc = @cumulativeCostUsdc,
          payment_cumulative_amount = @paymentCumulativeAmount,
          updated_at = @updatedAt
      `),
      getSnapshot: this._db.prepare(`
        SELECT * FROM usage_verification_snapshots WHERE channel_id = ? AND service_key = ? AND epoch = ?
      `),
      upsertAttestation: this._db.prepare(`
        INSERT INTO usage_verification_attestations (
          claim_hash, request_id, channel_id, service_key, epoch, claim_json,
          buyer_reveal_hash, seller_reveal_hash, buyer_nonce, seller_nonce,
          buyer_sig, seller_sig, commit_tx_hash, reveal_tx_hash, status, created_at, updated_at
        ) VALUES (
          @claimHash, @requestId, @channelId, @serviceKey, @epoch, @claimJson,
          @buyerRevealHash, @sellerRevealHash, @buyerNonce, @sellerNonce,
          @buyerSig, @sellerSig, @commitTxHash, @revealTxHash, @status, @createdAt, @updatedAt
        )
        ON CONFLICT(claim_hash) DO UPDATE SET
          request_id = @requestId,
          claim_json = @claimJson,
          buyer_reveal_hash = @buyerRevealHash,
          seller_reveal_hash = @sellerRevealHash,
          buyer_nonce = @buyerNonce,
          seller_nonce = @sellerNonce,
          buyer_sig = @buyerSig,
          seller_sig = @sellerSig,
          commit_tx_hash = @commitTxHash,
          reveal_tx_hash = @revealTxHash,
          status = @status,
          updated_at = @updatedAt
      `),
      getAttestation: this._db.prepare('SELECT * FROM usage_verification_attestations WHERE claim_hash = ?'),
      listAttestationsByStatus: this._db.prepare('SELECT * FROM usage_verification_attestations WHERE status = ? ORDER BY updated_at LIMIT ?'),
      updateAttestationStatus: this._db.prepare('UPDATE usage_verification_attestations SET status = ?, commit_tx_hash = COALESCE(?, commit_tx_hash), reveal_tx_hash = COALESCE(?, reveal_tx_hash), updated_at = ? WHERE claim_hash = ?'),
    };
  }

  getSnapshot(channelId: string, serviceKey: string, epoch: string): UsageSnapshotRecord | null {
    const row = this._stmts.getSnapshot.get(channelId, serviceKey, epoch) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  upsertSnapshot(record: UsageSnapshotRecord): void {
    this._stmts.upsertSnapshot.run(record);
  }

  upsertAttestation(record: UsageAttestationRecord): void {
    this._stmts.upsertAttestation.run({
      ...record,
      claimJson: JSON.stringify(record.claim),
    });
  }

  getAttestation(claimHash: string): UsageAttestationRecord | null {
    const row = this._stmts.getAttestation.get(claimHash) as AttestationRow | undefined;
    return row ? attestationFromRow(row) : null;
  }

  listAttestationsByStatus(status: UsageAttestationStatus, limit = 100): UsageAttestationRecord[] {
    const rows = this._stmts.listAttestationsByStatus.all(status, limit) as AttestationRow[];
    return rows.map(attestationFromRow);
  }

  updateAttestationStatus(claimHash: string, status: UsageAttestationStatus, hashes?: { commitTxHash?: string; revealTxHash?: string }): void {
    this._stmts.updateAttestationStatus.run(status, hashes?.commitTxHash ?? null, hashes?.revealTxHash ?? null, Date.now(), claimHash);
  }

  close(): void {
    this._db.close();
  }
}

interface SnapshotRow {
  channel_id: string;
  service_key: string;
  provider_name: string;
  service_name: string;
  epoch: string;
  buyer_evm_addr: string;
  seller_evm_addr: string;
  seller_agent_id: string;
  cumulative_input_tokens: string;
  cumulative_cached_input_tokens: string;
  cumulative_fresh_input_tokens: string;
  cumulative_output_tokens: string;
  cumulative_request_count: string;
  cumulative_cost_usdc: string;
  payment_cumulative_amount: string;
  created_at: number;
  updated_at: number;
}

interface AttestationRow {
  claim_hash: string;
  request_id: string;
  channel_id: string;
  service_key: string;
  epoch: string;
  claim_json: string;
  buyer_reveal_hash: string | null;
  seller_reveal_hash: string | null;
  buyer_nonce: string | null;
  seller_nonce: string | null;
  buyer_sig: string | null;
  seller_sig: string | null;
  commit_tx_hash: string | null;
  reveal_tx_hash: string | null;
  status: UsageAttestationStatus;
  created_at: number;
  updated_at: number;
}

function snapshotFromRow(row: SnapshotRow): UsageSnapshotRecord {
  return {
    channelId: row.channel_id,
    serviceKey: row.service_key,
    providerName: row.provider_name,
    serviceName: row.service_name,
    epoch: row.epoch,
    buyerEvmAddr: row.buyer_evm_addr,
    sellerEvmAddr: row.seller_evm_addr,
    sellerAgentId: row.seller_agent_id,
    cumulativeInputTokens: row.cumulative_input_tokens,
    cumulativeCachedInputTokens: row.cumulative_cached_input_tokens,
    cumulativeFreshInputTokens: row.cumulative_fresh_input_tokens,
    cumulativeOutputTokens: row.cumulative_output_tokens,
    cumulativeRequestCount: row.cumulative_request_count,
    cumulativeCostUsdc: row.cumulative_cost_usdc,
    paymentCumulativeAmount: row.payment_cumulative_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attestationFromRow(row: AttestationRow): UsageAttestationRecord {
  return {
    claimHash: row.claim_hash,
    requestId: row.request_id,
    channelId: row.channel_id,
    serviceKey: row.service_key,
    epoch: row.epoch,
    claim: JSON.parse(row.claim_json) as VerificationUsageClaimPayload,
    buyerRevealHash: row.buyer_reveal_hash,
    sellerRevealHash: row.seller_reveal_hash,
    buyerNonce: row.buyer_nonce,
    sellerNonce: row.seller_nonce,
    buyerSig: row.buyer_sig,
    sellerSig: row.seller_sig,
    commitTxHash: row.commit_tx_hash,
    revealTxHash: row.reveal_tx_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
