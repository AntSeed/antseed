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
 * Buyer authorizes spending via EIP-712 signed SpendingAuth.
 */
export interface SpendingAuthPayload {
  sessionId: string;
  cumulativeAmount: string;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  nonce: number;
  deadline: number;
  buyerSig: string;
  buyerEvmAddr: string;
  /** Reserve amount for initial auth (USDC base units). Only set on first auth. */
  reserveAmount?: string;
}

/**
 * Seller acknowledges the spending authorization was reserved on-chain.
 */
export interface AuthAckPayload {
  sessionId: string;
  nonce: number;
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
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

/**
 * Seller tells buyer that the current cumulative authorization is insufficient.
 */
export interface NeedAuthPayload {
  sessionId: string;
  requiredCumulativeAmount: string;
  currentAcceptedCumulative: string;
  deposit: string;
}
