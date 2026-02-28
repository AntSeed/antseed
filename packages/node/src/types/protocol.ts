export enum MessageType {
  HandshakeInit = 0x01,
  HandshakeAck  = 0x02,
  Ping          = 0x10,
  Pong          = 0x11,
  HttpRequest      = 0x20,
  HttpResponse     = 0x21,
  HttpResponseChunk = 0x22,
  HttpResponseEnd  = 0x23,
  HttpResponseError = 0x24,
  // Chunked request upload (buyer→seller body streaming)
  HttpRequestChunk = 0x25,
  HttpRequestEnd   = 0x26,
  // Task/Agent message types
  TaskRequest  = 0x30,
  TaskEvent    = 0x31,
  TaskComplete = 0x32,
  TaskError    = 0x33,
  // Skill message types
  SkillRequest  = 0x40,
  SkillResponse = 0x41,

  // ─── Pull-Payment Protocol (0x50-0x5F) ───────────────────────────
  //
  // 0x50  SpendingAuth    — buyer sends EIP-712 spending authorization
  // 0x51  AuthAck         — seller confirms auth received and valid
  // 0x53  SellerReceipt   — per-request Ed25519 receipt (off-chain tracking)
  // 0x54  BuyerAck        — buyer Ed25519 ack of receipt
  // 0x55  TopUpRequest    — seller near cap, requests new SpendingAuth

  SpendingAuth  = 0x50,
  AuthAck       = 0x51,
  SellerReceipt = 0x53,
  BuyerAck      = 0x54,
  TopUpRequest  = 0x55,

  // Report message types
  PeerReport = 0x60,
  ReportAck  = 0x61,

  // Rating message types
  PeerRating     = 0x70,
  RatingQuery    = 0x71,
  RatingResponse = 0x72,

  Disconnect = 0xF0,
  Error      = 0xFF,
}

export interface FramedMessage {
  type:      MessageType;
  messageId: number;
  payload:   Uint8Array;
}

export const FRAME_HEADER_SIZE = 9;
export const MAX_PAYLOAD_SIZE  = 64 * 1024 * 1024;

// ─── Pull-Payment Messages ───────────────────────────────────────────────────

/**
 * Buyer sends an EIP-712 SpendingAuth to the seller at session start or in
 * response to a TopUpRequest. The seller verifies the signature off-chain before
 * calling charge() on-chain.
 */
export interface SpendingAuthPayload {
  /** 32-byte session ID as 0x-prefixed hex (buyer-generated, random) */
  sessionId: string;
  /** USDC cap in base units (6 dec) as decimal string */
  maxAmountUsdc: string;
  /** Auth nonce (uint32). Starts at 1; increments per top-up. */
  nonce: number;
  /** Unix seconds — authorization expiry */
  deadline: number;
  /** EIP-712 signature (0x-prefixed 65-byte hex) */
  buyerSig: string;
  /** Buyer's EVM address (0x-prefixed 20 bytes). Used by seller for EIP-712 sig recovery. */
  buyerEvmAddr: string;
}

/**
 * Seller confirms it received and validated the SpendingAuth.
 */
export interface AuthAckPayload {
  sessionId: string;
  nonce:     number;
}

/**
 * Running-total receipt signed by seller after processing a request.
 * Each receipt supersedes the previous one.
 */
export interface SellerReceiptPayload {
  sessionId:    string;
  /** Cumulative cost of all requests in this session (USDC base units) */
  runningTotal:  string;
  /** Number of requests processed so far */
  requestCount:  number;
  /** SHA-256 hash of the response body (hex) for proof of work */
  responseHash:  string;
  /** Seller's Ed25519 signature over (sessionId || runningTotal || requestCount || responseHash) */
  sellerSig:     string;
}

/**
 * Buyer acknowledges the seller's receipt by counter-signing.
 */
export interface BuyerAckPayload {
  sessionId:    string;
  runningTotal:  string;
  requestCount:  number;
  /** Buyer's Ed25519 signature over (sessionId || runningTotal || requestCount) */
  buyerSig:     string;
}

/**
 * Seller is approaching the SpendingAuth cap and requests a new authorization.
 */
export interface TopUpRequestPayload {
  sessionId:           string;
  currentUsed:         string;   // how much charged against current auth
  currentMax:          string;   // current cap
  requestedAdditional: string;   // suggested new cap
}

