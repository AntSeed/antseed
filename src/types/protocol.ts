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
  // Task/Agent message types
  TaskRequest = 0x30,
  TaskEvent = 0x31,
  TaskComplete = 0x32,
  TaskError = 0x33,
  // Skill message types
  SkillRequest = 0x40,
  SkillResponse = 0x41,

  // --- Bilateral Payment Protocol (0x50-0x5F) ---
  SessionLockAuth = 0x50,
  SessionLockConfirm = 0x51,
  SessionLockReject = 0x52,
  SellerReceipt = 0x53,
  BuyerAck = 0x54,
  SessionEnd = 0x55,
  TopUpRequest = 0x56,
  TopUpAuth = 0x57,
  DisputeNotify = 0x58,

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
 * Buyer authorizes locking funds for a session.
 * Contains the buyer's ECDSA signature over keccak256(sessionId, seller, amount).
 */
export interface SessionLockAuthPayload {
  /** 32-byte session ID as hex string */
  sessionId: string;
  /** Amount to lock in USDC base units (6 decimals) */
  lockedAmount: string;
  /** Buyer's ECDSA signature over keccak256(sessionId || seller || amount) as hex */
  buyerSig: string;
}

/**
 * Seller confirms the lock was committed on-chain.
 */
export interface SessionLockConfirmPayload {
  sessionId: string;
  /** Base transaction hash for the commit_lock instruction */
  txSignature: string;
}

/**
 * Seller rejects the lock (insufficient funds, invalid sig, etc).
 */
export interface SessionLockRejectPayload {
  sessionId: string;
  reason: string;
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
 * Buyer ends the session with a final score.
 */
export interface SessionEndPayload {
  sessionId: string;
  /** Final running total (must match last ack'd receipt) */
  runningTotal: string;
  /** Final request count */
  requestCount: number;
  /** Quality score 0-100 */
  score: number;
  /** Buyer's ECDSA signature over keccak256(sessionId || runningTotal || score) as hex */
  buyerSig: string;
}

/**
 * Seller requests additional funds when budget is running low.
 */
export interface TopUpRequestPayload {
  sessionId: string;
  /** Additional USDC amount requested (base units) */
  additionalAmount: string;
  /** Current running total for context */
  currentRunningTotal: string;
  /** Current locked amount for context */
  currentLockedAmount: string;
}

/**
 * Buyer authorizes a top-up.
 */
export interface TopUpAuthPayload {
  sessionId: string;
  /** Additional amount authorized (USDC base units) */
  additionalAmount: string;
  /** Buyer's ECDSA signature over keccak256(sessionId || seller || additionalAmount) as hex */
  buyerSig: string;
}

/**
 * Notify counterparty that a dispute has been opened on-chain.
 */
export interface DisputeNotifyPayload {
  sessionId: string;
  /** Reason for the dispute */
  reason: string;
  /** Base tx hash of the open_dispute instruction */
  txSignature: string;
}
