# PRD-03: Protocol & SDK Integration

**Created:** 2026-03-16T10:30Z
**Depends On:** PRD-02
**Estimated Tasks:** 15

---

## Overview

Wire the new AntseedEscrow contract into the node SDK. Replace the old SessionLock protocol with SpendingAuth/AuthAck. Implement persistent session storage (SQLite), bilateral receipt exchange, TopUp protocol, and the settle-then-reserve atomic flow. Make everything automatic for peers and buyers.

---

## Task 1: Session persistence — SQLite schema and SessionStore class

### Description
Create a SQLite-backed session store that persists proof chain state across node restarts.

##### CREATE: `packages/node/src/payments/session-store.ts`

```typescript
import Database from 'better-sqlite3';
import { join } from 'node:path';

export interface StoredSession {
  sessionId: string;
  peerId: string;
  role: 'buyer' | 'seller';
  sellerEvmAddr: string;
  buyerEvmAddr: string;
  nonce: number;
  authMax: bigint;
  deadline: number;
  previousSessionId: string;
  previousConsumption: bigint;
  tokensDelivered: bigint;
  requestCount: number;
  reservedAt: number;
  settledAt: number | null;
  settledAmount: bigint | null;
  status: 'active' | 'settled' | 'timeout' | 'ghost';
  createdAt: number;
  updatedAt: number;
}

export interface StoredReceipt {
  id: number;
  sessionId: string;
  runningTotal: bigint;
  requestCount: number;
  responseHash: string;
  sellerSig: string;
  buyerAckSig: string | null;
  createdAt: number;
}

export class SessionStore {
  private _db: Database.Database;

  constructor(dataDir: string) {
    this._db = new Database(join(dataDir, 'sessions.db'));
    this._db.pragma('journal_mode = WAL');
    this._createTables();
  }

  private _createTables(): void { /* CREATE TABLE IF NOT EXISTS for sessions and receipts */ }

  // Session CRUD
  upsertSession(session: StoredSession): void
  getSession(sessionId: string): StoredSession | null
  getActiveSessionByPeer(peerId: string, role: string): StoredSession | null
  getLatestSession(peerId: string, role: string): StoredSession | null
  updateSessionStatus(sessionId: string, status: string, settledAmount?: bigint): void
  updateTokensDelivered(sessionId: string, tokens: bigint, requestCount: number): void

  // Receipt CRUD
  insertReceipt(receipt: Omit<StoredReceipt, 'id'>): void
  getReceipts(sessionId: string): StoredReceipt[]

  // Timeout queries
  getTimedOutSessions(timeoutSeconds: number): StoredSession[]

  close(): void
}
```

Follow the pattern from `packages/node/src/metering/storage.ts` (existing SQLite usage with better-sqlite3, WAL mode).

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] Database created at `{dataDir}/sessions.db`
- [ ] WAL mode enabled
- [ ] Tables created on first use
- [ ] All CRUD operations work correctly
- [ ] bigint stored as TEXT (SQLite doesn't support bigint natively)

---

## Task 2: Rewrite BuyerPaymentManager

##### MODIFY: `packages/node/src/payments/buyer-payment-manager.ts`

**Full rewrite.** Replace SessionLock flow with SpendingAuth/EIP-712.

**New config interface:**
```typescript
export interface BuyerPaymentConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
  identityAddress: string;
  chainId: number;
  defaultMaxAmountUsdc: bigint;   // default auth cap per session
  defaultAuthDurationSecs: number; // default deadline offset (3600s)
  autoAck: boolean;                // auto-send BuyerAck on receipt
  dataDir: string;                 // for SessionStore
}
```

**Key changes:**
- Uses `SessionStore` for persistent sessions (not in-memory Map)
- `authorizeSpending(sellerPeerId, sellerEvmAddr, paymentMux)`:
  - Loads latest session for this seller from SessionStore
  - Sets `previousConsumption = latestSession.tokensDelivered`, `previousSessionId = latestSession.sessionId`
  - For first session: previousConsumption = 0, previousSessionId = bytes32(0)
  - Signs EIP-712 SpendingAuth using `signSpendingAuth()` from signatures.ts
  - Sends SpendingAuth via PaymentMux
  - Stores new session in SessionStore with status='active'
- `handleAuthAck(sellerPeerId, payload)` — marks session as confirmed
- `handleSellerReceipt(sellerPeerId, payload, paymentMux)`:
  - Verifies seller's Ed25519 signature
  - Updates tokensDelivered in SessionStore
  - If autoAck: builds Ed25519 ack, sends BuyerAck
- `handleTopUpRequest(sellerPeerId, payload, paymentMux)`:
  - Signs new SpendingAuth with increased cap (embedding current session's consumption as previousConsumption)
  - Sends new SpendingAuth
- `getSessionHistory(sellerPeerId)` — returns full chain from SessionStore
- `isAuthorized(sellerPeerId)` — checks if active confirmed session exists

**Remove:** `initiateLock`, `handleLockConfirm`, `handleLockReject`, `endSession`, all ECDSA lock signing.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] Sessions persist across class reinstantiation (SQLite)
- [ ] Proof chain correctly references previous session
- [ ] EIP-712 signing matches contract's SpendingAuth typehash

---

## Task 3: Rewrite SellerPaymentManager

##### MODIFY: `packages/node/src/payments/seller-payment-manager.ts`

**Full rewrite.** Implement settle-then-reserve atomic flow.

**Key changes:**
- Uses `SessionStore` for persistent sessions
- `handleSpendingAuth(buyerPeerId, buyerEvmAddr, payload, paymentMux)`:
  1. Verify EIP-712 signature matches buyerEvmAddr
  2. If prior session exists (same buyer): call `escrowClient.settle(priorSessionId, payload.previousConsumption)`
  3. Call `escrowClient.reserve(buyer, sessionId, maxAmount, nonce, deadline, previousConsumption, previousSessionId, buyerSig)`
  4. Store new session in SessionStore
  5. Send AuthAck
- `sendReceipt(buyerPeerId, paymentMux, responseBody)`:
  - Calculates tokens from response
  - Updates session.tokensDelivered in SessionStore
  - Builds SellerReceipt with Ed25519 signature
  - Sends via PaymentMux
  - If tokensDelivered > 80% of authMax: sends TopUpRequest
- `handleBuyerAck(buyerPeerId, payload)`:
  - Verifies Ed25519 signature
  - Stores ack in SessionStore receipts
- `onBuyerDisconnect(buyerPeerId)`:
  - Stores pending session for timeout (persisted via SessionStore)
  - Does NOT settle immediately — waits for buyer to return with next auth
- `checkTimeouts()`:
  - Queries SessionStore for sessions past SETTLE_TIMEOUT
  - Calls `escrowClient.settleTimeout(sessionId)` for each
- `hasSession(buyerPeerId)` — active confirmed session check

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] Settle-then-reserve atomic flow works
- [ ] Prior session settled before new reserve
- [ ] Timeout detection via SessionStore query
- [ ] Receipts sent after each request

---

## Task 4: Wire payment handlers in node.ts

##### MODIFY: `packages/node/src/node.ts`

**Replace all payment handler code.** Key changes:

1. **Initialization:**
   - Construct `SessionStore` with dataDir
   - Construct `BuyerPaymentManager` and `SellerPaymentManager` with new configs
   - Start timeout checker interval (every 60s, calls `sellerPaymentManager.checkTimeouts()`)

2. **Incoming connection (seller side):**
   ```typescript
   const paymentMux = new PaymentMux(conn);
   paymentMux.onSpendingAuth((payload) => {
     void this._sellerPaymentManager.handleSpendingAuth(buyerPeerId, buyerEvmAddr, payload, paymentMux);
   });
   paymentMux.onBuyerAck((payload) => {
     void this._sellerPaymentManager.handleBuyerAck(buyerPeerId, payload);
   });
   ```

3. **Outgoing connection (buyer side):**
   ```typescript
   const paymentMux = new PaymentMux(conn);
   paymentMux.onAuthAck((payload) => {
     this._buyerPaymentManager.handleAuthAck(sellerPeerId, payload);
   });
   paymentMux.onSellerReceipt((payload) => {
     void this._buyerPaymentManager.handleSellerReceipt(sellerPeerId, payload, paymentMux);
   });
   paymentMux.onTopUpRequest((payload) => {
     void this._buyerPaymentManager.handleTopUpRequest(sellerPeerId, payload, paymentMux);
   });
   ```

4. **`_sendBilateralReceipt()` — actual implementation:**
   ```typescript
   void this._sellerPaymentManager.sendReceipt(buyerPeerId, paymentMux, responseBody);
   ```

5. **Authorization guard:**
   ```typescript
   const isAuthorized = this._sellerPaymentManager?.hasSession(buyerPeerId) ?? false;
   if (!isAuthorized) { /* 402 Payment Required */ }
   ```

6. **Buyer initiation (`_initiateBuyerAuth`):**
   ```typescript
   await this._buyerPaymentManager.authorizeSpending(sellerPeerId, sellerEvmAddr, paymentMux);
   ```

7. **Disconnect handling:**
   - Seller side: `this._sellerPaymentManager.onBuyerDisconnect(buyerPeerId)`
   - Buyer side: no immediate action (session persisted for next reconnect)

8. **Shutdown:** Close SessionStore, stop timeout checker interval.

**Remove:** `_handleSessionLockAuth`, `_handleSessionEnd`, `_handleTopUpAuth`, `_initiateBuyerLock`, `_waitForLockConfirmation`, `_endAllBuyerSessions`, all ECDSA lock message building.

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] `pnpm run typecheck` passes
- [ ] Buyer auth flow: authorizeSpending → AuthAck → serve → receipts → BuyerAck
- [ ] Seller flow: SpendingAuth received → settle prior → reserve new → AuthAck
- [ ] Disconnect: session persisted, timeout checker handles 24h expiry
- [ ] Bilateral receipts actually sent after each request

---

## Task 5: Timeout recovery on startup

### Description
On node startup, check SessionStore for any sessions that may have timed out while the node was offline.

##### MODIFY: `packages/node/src/node.ts`

In `_initialize()` or equivalent startup method:
```typescript
// Recover timed-out sessions
if (this._sellerPaymentManager) {
  await this._sellerPaymentManager.checkTimeouts();
}
```

Also in SellerPaymentManager:
- On construction, query `SessionStore.getTimedOutSessions(SETTLE_TIMEOUT)` and process each.

#### Acceptance Criteria
- [ ] Sessions that timed out during downtime are settled on restart
- [ ] No duplicate settle attempts (check session status before acting)

---

## Task 6: Feedback submission in BuyerPaymentManager

### Description
After a session is settled (buyer signs next auth), optionally submit ERC-8004 feedback for the seller.

##### MODIFY: `packages/node/src/payments/buyer-payment-manager.ts`

**Add method:**
```typescript
async submitFeedback(
  sellerPeerId: string,
  qualityScore: number,    // -100 to 100
  identityClient: IdentityClient,
): Promise<string | null> {
  const session = this._sessionStore.getLatestSession(sellerPeerId, 'buyer');
  if (!session || session.status !== 'settled') return null;

  const tokenId = await identityClient.getTokenId(session.sellerEvmAddr);
  const tag = ethers.encodeBytes32String('quality');
  return identityClient.submitFeedback(this._signer, tokenId, qualityScore, tag);
}
```

This is optional — called by the node when quality metrics warrant feedback (e.g., high latency, errors).

#### Acceptance Criteria
- [ ] Feedback only submitted for settled sessions
- [ ] Returns null if no settled session exists
- [ ] Tag is bytes32-encoded "quality"

---

## Task 7: BuyerPaymentManager tests

##### CREATE: `packages/node/tests/buyer-payment-manager.test.ts` (full rewrite)

**Setup:** Mock SessionStore, mock PaymentMux, mock EscrowClient, create test identity.

**Test cases:**
- **test_authorizeSpending_firstSession:** previousConsumption=0, previousSessionId=0x0
- **test_authorizeSpending_withPriorSession:** Loads prior session, sets previousConsumption=tokensDelivered
- **test_authorizeSpending_signsEIP712:** Verify signature matches expected EIP-712 digest
- **test_handleAuthAck:** Session marked as confirmed
- **test_handleSellerReceipt_updatesTokens:** tokensDelivered updated in store
- **test_handleSellerReceipt_sendsAck:** BuyerAck sent via mux when autoAck=true
- **test_handleTopUpRequest:** New SpendingAuth sent with increased cap
- **test_sessionPersistence:** Session survives store reconstruction

#### Acceptance Criteria
- [ ] All tests pass with `pnpm --filter @antseed/node run test`

---

## Task 8: SellerPaymentManager tests

##### CREATE: `packages/node/tests/seller-payment-manager.test.ts` (full rewrite)

**Test cases:**
- **test_handleSpendingAuth_firstSign:** Calls reserve on escrow, sends AuthAck
- **test_handleSpendingAuth_settleThenReserve:** Prior session settled before new reserve
- **test_handleSpendingAuth_revert_invalidSig:** Invalid EIP-712 signature rejected
- **test_sendReceipt:** SellerReceipt sent with correct running total and Ed25519 sig
- **test_sendReceipt_topUpRequest:** TopUp sent when >80% of authMax consumed
- **test_handleBuyerAck:** Receipt stored in SessionStore
- **test_onBuyerDisconnect:** Session persisted, not settled immediately
- **test_checkTimeouts:** Timed-out sessions settled via escrowClient.settleTimeout

#### Acceptance Criteria
- [ ] All tests pass

---

## Task 9: SessionStore tests

##### CREATE: `packages/node/tests/session-store.test.ts`

**Test cases:**
- **test_createAndRead:** Insert session, read back all fields
- **test_updateStatus:** Update status, verify
- **test_updateTokensDelivered:** Increment tokens, verify
- **test_getActiveByPeer:** Returns correct active session
- **test_getLatestByPeer:** Returns most recent session (any status)
- **test_getTimedOut:** Returns sessions past timeout threshold
- **test_receiptCRUD:** Insert and read receipts
- **test_persistence:** Close and reopen database, data survives

#### Acceptance Criteria
- [ ] All tests pass
- [ ] SQLite database created and cleaned up

---

## Task 10: PaymentCodec tests update

##### MODIFY: `packages/node/tests/payment-codec.test.ts`

Replace SessionLockAuth/Confirm/Reject/End tests with:
- **test_spendingAuth_roundTrip:** Encode/decode SpendingAuthPayload including previousConsumption, previousSessionId
- **test_authAck_roundTrip:** Encode/decode AuthAckPayload
- **test_sellerReceipt_roundTrip:** (keep existing)
- **test_buyerAck_roundTrip:** (keep existing)
- **test_topUpRequest_roundTrip:** (keep existing)

#### Acceptance Criteria
- [ ] All codec tests pass

---

## Task 11: PaymentMux tests update

##### MODIFY: `packages/node/tests/payment-mux.test.ts`

Update to test new message type dispatch:
- SpendingAuth → onSpendingAuth handler
- AuthAck → onAuthAck handler
- SellerReceipt, BuyerAck, TopUpRequest → existing handlers

Remove tests for SessionLockConfirm, SessionLockReject, SessionEnd, TopUpAuth, DisputeNotify.

#### Acceptance Criteria
- [ ] All mux tests pass

---

## Task 12: Update payment exports and types

##### MODIFY: `packages/node/src/payments/index.ts`

Update exports:
```typescript
export { SessionStore } from './session-store.js';
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export { SellerPaymentManager } from './seller-payment-manager.js';
export { BaseEscrowClient } from './evm/escrow-client.js';
export { IdentityClient } from './evm/identity-client.js';
export { ANTSTokenClient } from './evm/ants-token-client.js';
export { identityToEvmWallet, identityToEvmAddress } from './evm/keypair.js';
export {
  SPENDING_AUTH_TYPES,
  makeEscrowDomain,
  signSpendingAuth,
  buildReceiptMessage,
  buildAckMessage,
  signMessageEd25519,
  verifyMessageEd25519,
} from './evm/signatures.js';
```

Remove exports for deprecated functions/types.

##### MODIFY: `packages/node/src/payments/types.ts`

Add new types if needed (ProvenReputation re-export, session status enum).

#### Acceptance Criteria
- [ ] TypeScript compiles
- [ ] All new modules exported

---

## Task 13: Integration test — full proof chain flow

##### CREATE: `packages/node/tests/proof-chain-integration.test.ts`

End-to-end test (in-memory, no on-chain) verifying the full flow:

1. Buyer creates first SpendingAuth (previousConsumption=0)
2. Seller receives, validates, sends AuthAck
3. Seller sends 3 SellerReceipts, buyer sends BuyerAcks
4. Buyer disconnects
5. Buyer reconnects, creates new SpendingAuth with previousConsumption = tokensDelivered from session 1
6. Seller receives, settles session 1, reserves session 2
7. Repeat for session 3 (chained)
8. Verify SessionStore has full chain with correct linking

Uses mocked EscrowClient (no actual on-chain calls).

#### Acceptance Criteria
- [ ] Full 3-session chain verified
- [ ] previousConsumption and previousSessionId correct at each step
- [ ] All sessions persisted in SessionStore
- [ ] `pnpm --filter @antseed/node run test` — all tests pass, no regressions

---

## Task 14: Identity file security — encryption at rest and permission checks

### Description
The Ed25519 identity file (`identity.json`) is the master key for both P2P identity and derived EVM wallet (controls stake, earnings, reputation). It must be protected.

##### MODIFY: `packages/node/src/p2p/identity.ts`

**Add on load:**
```typescript
// Check file permissions (Unix only)
import { stat, chmod } from 'node:fs/promises';

async function checkIdentityPermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') return; // skip on Windows
  const stats = await stat(filePath);
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    await chmod(filePath, 0o600);
    console.warn(`[security] Fixed identity file permissions to 0600: ${filePath}`);
  }
}
```

**Add on create:**
- Set file permissions to 0600 immediately after writing
- Log a warning: `"IMPORTANT: Back up your identity file — it controls your EVM wallet, stake, and earnings"`

**Add optional encryption:**
```typescript
export interface IdentityOptions {
  passphrase?: string;  // if set, encrypt/decrypt identity at rest
}

async function loadOrCreateIdentity(dataDir: string, options?: IdentityOptions): Promise<Identity>
```

When `passphrase` is provided:
- On save: encrypt with `crypto.createCipheriv('aes-256-gcm', key, iv)` where key = `scrypt(passphrase, salt)`
- On load: decrypt with same scheme
- Store as `identity.enc` instead of `identity.json` when encrypted

##### CREATE: `packages/node/tests/identity-security.test.ts`

- **test_filePermissions:** Created identity file has 0600 permissions (Unix only)
- **test_encryptDecrypt:** Identity encrypted with passphrase, decrypted correctly
- **test_wrongPassphrase:** Wrong passphrase throws error
- **test_backwardCompatibility:** Unencrypted identity.json still loads

#### Acceptance Criteria
- [ ] Identity file created with 0600 permissions
- [ ] Warning logged about backup on first creation
- [ ] Optional passphrase encryption works
- [ ] Backward compatible with existing unencrypted files

---

## Task 15: Readiness checks — pre-flight validation for providers and buyers

### Description
Before a node starts serving or buying, validate that all prerequisites are met and provide clear guidance.

##### CREATE: `packages/node/src/payments/readiness.ts`

```typescript
export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;       // what's wrong or what to do
  command?: string;       // CLI command to fix it
}

export async function checkSellerReadiness(
  identity: Identity,
  escrowClient: BaseEscrowClient,
  identityClient: IdentityClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identityToEvmAddress(identity);

  // 1. EVM wallet has ETH for gas
  const ethBalance = await escrowClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas fees. Send ETH to ${evmAddr}`,
  });

  // 2. Peer is registered (has identity NFT)
  const isReg = await identityClient.isRegistered(evmAddr);
  checks.push({
    name: 'Peer registration',
    passed: isReg,
    message: isReg
      ? 'Registered on AntseedIdentity'
      : 'Not registered. Run: antseed register',
    command: isReg ? undefined : 'antseed register',
  });

  // 3. Peer has staked
  const account = await escrowClient.getSellerAccount(evmAddr);
  const hasStake = account.stake > 0n;
  checks.push({
    name: 'Stake',
    passed: hasStake,
    message: hasStake
      ? `Staked: ${formatUsdc(account.stake)} USDC`
      : 'No stake. Run: antseed stake <amount>',
    command: hasStake ? undefined : 'antseed stake 10',
  });

  // 4. Token rate set
  checks.push({
    name: 'Token rate',
    passed: account.tokenRate > 0n,
    message: account.tokenRate > 0n
      ? `Rate: ${account.tokenRate} credits/token`
      : 'Token rate not set. Will be set on first seed.',
  });

  return checks;
}

export async function checkBuyerReadiness(
  identity: Identity,
  escrowClient: BaseEscrowClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identityToEvmAddress(identity);

  // 1. ETH for gas
  const ethBalance = await escrowClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas. Send ETH to ${evmAddr}`,
  });

  // 2. USDC deposited in escrow
  const balance = await escrowClient.getBuyerBalance(evmAddr);
  checks.push({
    name: 'Escrow balance',
    passed: balance.available > 0n,
    message: balance.available > 0n
      ? `Available: ${formatUsdc(balance.available)} USDC`
      : 'No USDC in escrow. Run: antseed deposit <amount>',
    command: balance.available > 0n ? undefined : 'antseed deposit 10',
  });

  return checks;
}
```

##### MODIFY: `packages/node/src/node.ts`

On startup (both seller and buyer modes), run readiness checks. If any fail, log clearly and either warn or refuse to start (configurable: `strictReadiness: boolean` in config).

```typescript
const checks = await checkSellerReadiness(identity, escrowClient, identityClient);
const failed = checks.filter(c => !c.passed);
if (failed.length > 0) {
  for (const check of failed) {
    this._log.warn(`[readiness] ${check.name}: ${check.message}`);
  }
  if (this._config.strictReadiness) {
    throw new Error('Readiness checks failed. Fix the issues above and restart.');
  }
}
```

#### Acceptance Criteria
- [ ] Seller readiness checks: gas, registration, stake, token rate
- [ ] Buyer readiness checks: gas, escrow balance
- [ ] Clear messages with exact CLI commands to fix each issue
- [ ] Node warns or refuses to start based on config
