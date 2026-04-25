export enum MessageType {
  HandshakeInit = 0x01,
  HandshakeAck = 0x02,
  Ping = 0x10,
  Pong = 0x11,
  HttpRequest = 0x20,
  HttpResponse = 0x21,
  HttpResponseChunk = 0x22,
  HttpResponseEnd = 0x23,
  HttpResponseError = 0x24,
  // Chunked request upload (buyer→seller body streaming)
  HttpRequestChunk = 0x25,
  HttpRequestEnd   = 0x26,

  // --- Payment Protocol (0x50-0x5F) ---
  SpendingAuth = 0x50,
  AuthAck = 0x51,
  PaymentRequired = 0x56,
  NeedAuth = 0x58,

  // Report message types
  PeerReport = 0x60,
  ReportAck = 0x61,

  // Rating message types
  PeerRating = 0x70,
  RatingQuery = 0x71,
  RatingResponse = 0x72,

  Disconnect = 0xF0,
  Error = 0xFF,
}

export interface FramedMessage {
  type: MessageType;
  messageId: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_SIZE = 9;
export const MAX_PAYLOAD_SIZE = 64 * 1024 * 1024;

// ─── Bilateral Payment Messages ─────────────────────────────────

/**
 * Buyer authorizes spending via a single EIP-712 SpendingAuth signature.
 * The signature covers channelId, cumulativeAmount, and metadataHash.
 */
export interface SpendingAuthPayload {
  channelId: string;
  cumulativeAmount: string;
  metadataHash: string;         // bytes32 hex
  metadata: string;             // hex-encoded abi.encode(version, inputTokens, outputTokens, requestCount)
  spendingAuthSig: string;      // EIP-712 SpendingAuth signature (covers amount + metadata)
  // Only for initial reserve
  reserveSalt?: string;
  reserveMaxAmount?: string;
  reserveDeadline?: number;
}

/**
 * Seller acknowledges the spending authorization was reserved on-chain.
 */
export interface AuthAckPayload {
  channelId: string;
}

/**
 * Seller tells buyer what's needed to start a payment session.
 * Sent via PaymentMux alongside the HTTP 402 response.
 */
export interface PaymentRequiredPayload {
  minBudgetPerRequest: string;
  suggestedAmount: string;
  requestId: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  /**
   * For budget-exhausted 402s on an existing channel: the cumulative
   * amount the buyer must sign to catch up with the seller's recorded
   * spend and unblock further requests. Absent for pre-session 402s.
   */
  requiredCumulativeAmount?: string;
  /** Seller-side cumulative spend at the time the 402 was emitted. */
  currentSpent?: string;
  /** Seller-side last-accepted cumulative at the time the 402 was emitted. */
  currentAcceptedCumulative?: string;
  /** Channel ID for the exhausted session (so buyer can match it locally). */
  channelId?: string;
  /**
   * On-chain reserve ceiling for this channel. When present and the seller's
   * `requiredCumulativeAmount` exceeds it, the channel is permanently
   * exhausted and the buyer must retire it and open a new one — no amount
   * of additional signing on the same channel will be accepted.
   */
  reserveMaxAmount?: string;
  /**
   * Stable machine-readable code so callers can switch on it without coupling
   * to internal phrasing. Only set on irrecoverable 402s today.
   */
  code?: PaymentRequiredCode;
}

export const PAYMENT_CODE_CHANNEL_EXHAUSTED = 'channel_exhausted' as const;
export type PaymentRequiredCode = typeof PAYMENT_CODE_CHANNEL_EXHAUSTED;

/**
 * Seller tells buyer that the current cumulative authorization is insufficient.
 * After every served request the seller includes the cost of that request so
 * the buyer can validate before signing a new SpendingAuth.
 */
export interface NeedAuthPayload {
  channelId: string;
  requiredCumulativeAmount: string;
  currentAcceptedCumulative: string;
  deposit: string;
  /** requestId of the request whose cost is reported below. */
  requestId?: string;
  /** Seller-computed cost for the last request (USDC base units). */
  lastRequestCost?: string;
  /** Input tokens consumed by the last request. */
  inputTokens?: string;
  /** Output tokens consumed by the last request. */
  outputTokens?: string;
  /** Cached input tokens consumed by the last request. */
  cachedInputTokens?: string;
  /** Service/model name for service-specific pricing validation. */
  service?: string;
}
