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
 * Buyer authorizes spending via two EIP-712 signatures:
 * 1. Tempo voucher sig — authorizes USDC transfer via Tempo StreamChannel
 * 2. AntSeed MetadataAuth sig — attests to token counts for reputation
 */
export interface SpendingAuthPayload {
  channelId: string;            // Tempo channel ID (was sessionId)
  cumulativeAmount: string;
  metadataHash: string;         // bytes32 hex
  metadata: string;             // hex-encoded abi.encode(inputTokens, outputTokens, latencyMs, requestCount)
  tempoVoucherSig: string;      // Tempo EIP-712 voucher signature
  metadataAuthSig: string;      // AntSeed EIP-712 metadata auth signature
  buyerEvmAddr: string;
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
  sellerEvmAddr: string;
  minBudgetPerRequest: string;
  suggestedAmount: string;
  requestId: string;
  streamChannelAddress: string;  // Tempo StreamChannel contract address (buyer needs for voucher domain)
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

/**
 * Seller tells buyer that the current cumulative authorization is insufficient.
 */
export interface NeedAuthPayload {
  channelId: string;
  requiredCumulativeAmount: string;
  currentAcceptedCumulative: string;
  deposit: string;
}
