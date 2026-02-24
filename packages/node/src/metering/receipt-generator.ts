import { randomUUID } from 'node:crypto';
import type { ProviderType, TokenCount, UsageReceipt } from '../types/metering.js';

/**
 * Interface for signing data with the seller's Ed25519 private key.
 * The actual implementation lives in the identity module (PRD-01).
 */
export interface Signer {
  /**
   * Sign a message with the seller's Ed25519 private key.
   * @param message - UTF-8 string to sign
   * @returns Hex-encoded signature
   */
  sign(message: string): string;

  /** The seller's peer ID (Ed25519 public key hex) */
  peerId: string;
}

/**
 * Build the canonical string representation of receipt data for signing.
 * The order and format must be deterministic so both sides produce the
 * same string from the same receipt data.
 */
export function buildSignaturePayload(receipt: Omit<UsageReceipt, 'signature'>): string {
  return [
    receipt.receiptId,
    receipt.sessionId,
    receipt.eventId,
    receipt.timestamp.toString(),
    receipt.provider,
    receipt.sellerPeerId,
    receipt.buyerPeerId,
    receipt.tokens.totalTokens.toString(),
    receipt.costCents.toString(),
  ].join('|');
}

/**
 * Calculate the cost in USD cents from token count and price.
 *
 * @param totalTokens - Total estimated tokens
 * @param unitPriceCentsPerThousandTokens - Unit price in USD cents per 1,000 tokens
 * @returns Cost in USD cents (rounded to nearest cent)
 */
export function calculateCost(totalTokens: number, unitPriceCentsPerThousandTokens: number): number {
  const raw = (totalTokens / 1000) * unitPriceCentsPerThousandTokens;
  return raw > 0 ? Math.max(1, Math.round(raw)) : 0;
}

/**
 * Generates signed usage receipts for the seller side.
 */
export class ReceiptGenerator {
  private readonly signer: Signer;

  constructor(signer: Signer) {
    this.signer = signer;
  }

  /**
   * Generate a signed receipt for a completed request.
   *
   * @param sessionId - The buyer session ID
   * @param eventId - The metering event ID
   * @param provider - Provider used
   * @param buyerPeerId - Buyer's peer ID
   * @param tokens - Token estimate
   * @param unitPriceCentsPerThousandTokens - Effective unit price in USD cents per 1,000 tokens
   * @returns Signed UsageReceipt
   */
  generate(
    sessionId: string,
    eventId: string,
    provider: ProviderType,
    buyerPeerId: string,
    tokens: TokenCount,
    unitPriceCentsPerThousandTokens: number
  ): UsageReceipt {
    const receiptId = randomUUID();
    const timestamp = Date.now();
    const costCents = calculateCost(tokens.totalTokens, unitPriceCentsPerThousandTokens);

    const receiptData: Omit<UsageReceipt, 'signature'> = {
      receiptId,
      sessionId,
      eventId,
      timestamp,
      provider,
      sellerPeerId: this.signer.peerId,
      buyerPeerId,
      tokens,
      unitPriceCentsPerThousandTokens,
      costCents,
    };

    const payload = buildSignaturePayload(receiptData);
    const signature = this.signer.sign(payload);

    return {
      ...receiptData,
      signature,
    };
  }
}
