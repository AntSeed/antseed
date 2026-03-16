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

  // --- Bilateral Payment Protocol (0x50-0x5F) ---
  SpendingAuth = 0x50,
  AuthAck = 0x51,
  SellerReceipt = 0x53,
  BuyerAck = 0x54,
  TopUpRequest = 0x55,

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
  /** 32-byte session ID as hex string */
  sessionId: string;
  /** Maximum amount in USDC base units (6 decimals) */
  maxAmountUsdc: string;
  /** Replay-protection nonce */
  nonce: number;
  /** Unix timestamp deadline */
  deadline: number;
  /** Buyer's EIP-712 signature as hex */
  buyerSig: string;
  /** Buyer's EVM address */
  buyerEvmAddr: string;
  /** Token consumption from the previous session (USDC base units) */
  previousConsumption: string;
  /** Previous session ID (bytes32 hex, 0x00..00 for first sign) */
  previousSessionId: string;
}

/**
 * Seller acknowledges the spending authorization was reserved on-chain.
 */
export interface AuthAckPayload {
  sessionId: string;
  nonce: number;
}

/**
 * Running-total receipt signed by seller after processing a request.
 * Each receipt supersedes the previous one.
 */
export interface SellerReceiptPayload {
  sessionId: string;
  /** Cumulative cost of all requests in this session (USDC base units) */
  runningTotal: string;
  /** Number of requests processed so far */
  requestCount: number;
  /** SHA-256 hash of the response body (hex) for proof of work */
  responseHash: string;
  /** Seller's Ed25519 signature over (sessionId || runningTotal || requestCount || responseHash) */
  sellerSig: string;
}

/**
 * Buyer acknowledges the seller's receipt by counter-signing.
 */
export interface BuyerAckPayload {
  sessionId: string;
  /** Must match seller's runningTotal */
  runningTotal: string;
  /** Must match seller's requestCount */
  requestCount: number;
  /** Buyer's Ed25519 signature over (sessionId || runningTotal || requestCount) */
  buyerSig: string;
}

/**
 * Seller requests additional funds when budget is running low.
 */
export interface TopUpRequestPayload {
  sessionId: string;
  /** Current total used so far (USDC base units) */
  currentUsed: string;
  /** Current max authorized (USDC base units) */
  currentMax: string;
  /** Additional USDC amount requested (base units) */
  requestedAdditional: string;
}
