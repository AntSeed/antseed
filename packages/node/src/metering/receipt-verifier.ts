import type { UsageReceipt, TokenCount, ReceiptVerification } from '../types/metering.js';
import { buildSignaturePayload } from './receipt-generator.js';

/**
 * Interface for verifying secp256k1 signatures.
 * The actual implementation lives in the identity module.
 */
export interface SignatureVerifier {
  /**
   * Verify a secp256k1 signature via ecrecover.
   * @param message - The original signed message (UTF-8 string)
   * @param signature - Hex-encoded signature
   * @param address - Signer's EVM address (hex, no 0x prefix)
   * @returns true if signature is valid
   */
  verify(message: string, signature: string, address: string): boolean;
}

export interface VerifierOptions {
  /**
   * Maximum acceptable percentage difference between buyer and seller
   * token estimates before flagging as disputed.
   * Default: 15 (percent)
   */
  disputeThresholdPercent: number;
}

const DEFAULT_OPTIONS: VerifierOptions = {
  disputeThresholdPercent: 15,
};

/**
 * Verifies seller-issued usage receipts on the buyer side.
 */
export class ReceiptVerifier {
  private readonly signatureVerifier: SignatureVerifier;
  private readonly options: VerifierOptions;

  constructor(signatureVerifier: SignatureVerifier, options?: Partial<VerifierOptions>) {
    this.signatureVerifier = signatureVerifier;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Verify a receipt against the buyer's independent token estimate.
   *
   * Verification steps:
   * 1. Verify the secp256k1 signature using the seller's address
   * 2. Compare seller's token estimate with buyer's estimate
   * 3. Calculate percentage difference
   * 4. Flag as disputed if difference exceeds threshold
   *
   * @param receipt - The seller's signed receipt
   * @param buyerEstimate - The buyer's independent token estimate
   * @returns ReceiptVerification result
   */
  verify(receipt: UsageReceipt, buyerEstimate: TokenCount): ReceiptVerification {
    // Step 1: Verify signature
    const payload = buildSignaturePayload(receipt);
    const signatureValid = this.signatureVerifier.verify(
      payload,
      receipt.signature,
      receipt.sellerPeerId
    );

    // Step 2: Compare token estimates
    const sellerTotal = receipt.tokens.totalTokens;
    const buyerTotal = buyerEstimate.totalTokens;
    const tokenDifference = Math.abs(sellerTotal - buyerTotal);

    // Step 3: Calculate percentage difference
    const percentageDifference = ReceiptVerifier.calculatePercentageDifference(
      sellerTotal,
      buyerTotal
    );

    // Step 4: Flag as disputed if signature invalid or difference exceeds threshold
    const disputed = !signatureValid || percentageDifference > this.options.disputeThresholdPercent;

    return {
      receiptId: receipt.receiptId,
      signatureValid,
      buyerTokenEstimate: buyerEstimate,
      sellerTokenEstimate: receipt.tokens,
      tokenDifference,
      percentageDifference,
      disputed,
      verifiedAt: Date.now(),
    };
  }

  /**
   * Calculate the percentage difference between two token counts.
   * Formula: abs(a - b) / max(a, b) * 100
   * Returns 0 if both are 0.
   */
  static calculatePercentageDifference(a: number, b: number): number {
    const max = Math.max(a, b);
    if (max === 0) return 0;
    return (Math.abs(a - b) / max) * 100;
  }
}
