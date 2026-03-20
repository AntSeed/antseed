# Master Plan: Desktop Payments Feature

**Status:** COMPLETED
**PRDs Generated:** 2026-03-20T12:00Z
**Execution Completed:** 2026-03-20
**Created:** 2026-03-20
**Author:** Shahaf + Claude

## Overview

Build the buyer-side payments experience for AntSeed Desktop. Users see their credit balance in the app, top up via a localhost payments portal (crypto or credit card), and approve per-session pre-deposits that trigger EIP-712 SpendingAuth signatures using their local identity key. The desktop app has **no wallet integration** — all on-chain interactions happen either through the payments portal (deposits) or through the peer (session reservations).

## Goals

1. **Credits visibility** — Buyer always knows their escrow balance (header, chat, empty states)
2. **Frictionless top-up** — One-click path from desktop to payments portal; support both crypto and credit card (Crossmint)
3. **Transparent session approval** — Before spending, buyer sees peer stats and explicitly approves a pre-deposit amount
4. **Low balance awareness** — Proactive warnings when balance is running low during a session
5. **Clean removal** — All WalletConnect code removed from desktop app

## Non-Goals / Out of Scope

- Wallet integration inside the desktop app (wallets live in the payments portal only)
- Seller-side payment UX (dashboard already covers this)
- Fiat off-ramp (withdrawing to bank account)
- Automatic top-up / recurring deposits
- Mobile app payments
- Token staking or emissions UI in desktop

## Architectural Decisions

### AD-1: Standalone payments portal (`apps/payments`)
The dashboard is provider/seller-focused. The payments portal is buyer-focused. Keeping them separate avoids scope creep and lets each app evolve independently. Same tech stack (Fastify + React + Vite) for consistency.

### AD-2: Balance reading via direct RPC in desktop main process
The desktop app reads the buyer's escrow balance directly from the Base RPC endpoint using the EVM address derived from `identity.enc`. No dependency on the payments portal being running for balance display. The derivation uses `identityToEvmWallet()` which applies `keccak256(ed25519_seed || "evm-payment-key")` to produce a secp256k1 key.

### AD-3: Payments portal handles all on-chain write operations for deposits
Deposits require either a connected wallet (crypto) or Crossmint (credit card). The portal is the only place where wallet connection happens. The desktop app never connects a wallet — it only reads balance and signs EIP-712 messages with the local identity key.

### AD-4: Crossmint `depositFor` for credit card deposits
Crossmint's Pay API enables credit card → USDC → `depositFor(buyerAddress, amount)` on the escrow contract. The buyer's EVM address is derived from their identity key. Integration designed as a pluggable provider so it works with a placeholder until API keys are available.

### AD-5: Pre-deposit amount from contract constants
First interaction with a peer: capped at `FIRST_SIGN_CAP` (1 USDC). Proven sessions: based on peer's pricing and session history. The contract enforces these limits — the UI reflects them.

### AD-6: EIP-712 signing in desktop main process
The desktop main process holds the decrypted identity key (via safeStorage). EIP-712 SpendingAuth signing happens in the main process, exposed to the renderer via IPC. The renderer never sees the raw private key.

### AD-7: Low balance detection — local tracking + periodic RPC
During a session, the desktop tracks consumption locally from SellerReceipt messages (real-time). Periodically (every 60s) it also reads the on-chain balance as ground truth. Warning threshold: when available balance drops below the current session's reserved amount (i.e., can't start another session).

### AD-8: Portal auto-launches on desktop start
Similar to how the dashboard server starts, the payments portal starts on a localhost port when the desktop app launches. "Add Credits" buttons open the portal URL in the system default browser.

## Contract Constants Reference

| Constant | Value | Meaning |
|---|---|---|
| `FIRST_SIGN_CAP` | 1 USDC | Max pre-deposit for first interaction with a peer |
| `MIN_BUYER_DEPOSIT` | 10 USDC | Minimum first deposit into escrow |
| `SETTLE_TIMEOUT` | 24 hours | Time before unsettled session can be timed out |
| `WITHDRAWAL_DELAY` | 48 hours | Delay between withdrawal request and execution |

## PRD Dependency Graph

```
        ┌──────────┐         ┌──────────┐
        │  PRD-01  │         │  PRD-02  │
        │ Credits  │         │ Payments │
        │   UI     │         │  Portal  │
        └────┬─────┘         └────┬─────┘
             │                     │
             ├─────────┐          │
             │         │          │
             ▼         │          │
        ┌──────────┐   │          │
        │  PRD-03  │   │          │
        │ Session  │   │          │
        │ Approval │   │          │
        └────┬─────┘   │          │
             │         │          │
             ▼         ▼          ▼
        ┌─────────────────────────────┐
        │          PRD-04             │
        │  Desktop ↔ Portal Integration│
        └─────────────────────────────┘
```

## PRD Summary Table

| PRD | Name | Description | Deps | Est. Tasks |
|-----|------|-------------|------|------------|
| 01 | Credits UI & WalletConnect Removal | Remove all WalletConnect code from desktop. Add Credits button to TitleBar (next to theme toggle, same button style) showing `$X.XX`. Dropdown with "Add Credits" option. Balance reading from escrow contract via RPC in main process, IPC to renderer. "Add Credits" prompt in empty chat state and when messaging a paid peer with zero balance. | None | ~8 |
| 02 | Payments Portal | New standalone `apps/payments` app (Fastify + React). Crypto deposit flow (connect external wallet in portal, approve USDC, call `deposit()`). Crossmint integration for credit card → `depositFor()`. Balance display, withdrawal management (request/cancel/execute with 48h delay), transaction history. CLI command `antseed payments` to launch. | None | ~12 |
| 03 | Session Approval Flow | When user messages a paid peer: show peer info card (reputation score, active sessions, network age, pricing). Display pre-deposit approval prompt: "Approve $X.XX pre-deposit to [peer name]". On approve: sign EIP-712 SpendingAuth in main process with identity key, send to peer via payment protocol, wait for AuthAck, then begin streaming. Low balance warnings during active sessions. Handle TopUpRequest from seller. | PRD-01 | ~10 |
| 04 | Desktop ↔ Portal Integration | Auto-launch payments portal server on desktop app start (configurable port). "Add Credits" buttons deep-link to portal in default browser. Balance refresh in desktop after returning from portal (poll or focus-based). CLI `antseed payments` command for headless use. | PRD-01, PRD-02 | ~5 |

## Key Flows

### Flow 1: First-time buyer tops up
1. User opens desktop → sees "Credits $0.00" in header
2. Clicks Credits → dropdown shows "Add Credits"
3. Clicks "Add Credits" → system browser opens `http://localhost:<port>/deposit`
4. Portal shows buyer's EVM address (derived from identity), deposit options
5. User deposits via credit card (Crossmint) or crypto (connect wallet)
6. Crossmint calls `depositFor(buyerEvmAddress, amount)` / user calls `deposit(amount)`
7. User returns to desktop → balance updates to "$10.00"

### Flow 2: Starting a paid session
1. User selects a paid service, types a message, hits send
2. Desktop checks balance > 0, then shows peer info card:
   - "ember-forge — 87 reputation, 27 active sessions, 59 days in network"
   - "To start your session, approve a pre-deposit of $0.50"
   - [Approve] [Cancel]
3. User clicks Approve
4. Main process signs EIP-712 SpendingAuth (seller, sessionId, maxAmount=FIRST_SIGN_CAP, nonce, deadline, previousConsumption, previousSessionId)
5. SpendingAuth sent to peer via P2P payment mux
6. Peer calls `reserve(buyer, sessionId, ...)` on escrow contract
7. Peer sends AuthAck back
8. Desktop shows "Session started" → message is sent → streaming begins

### Flow 3: Low balance warning
1. During session, SellerReceipt arrives with `runningTotal` approaching `maxAmount`
2. Desktop shows in-chat warning: "Your balance is running low. Add credits to continue using paid services."
3. If seller sends TopUpRequest, desktop prompts user to approve additional pre-deposit
4. If balance is truly empty on-chain, show "Add Credits" with link to portal

## Technical Notes

- **Identity key path**: `~/.antseed/identity.enc` (Electron safeStorage) or `~/.antseed/identity.key` (CLI plaintext)
- **EVM derivation**: `keccak256(ed25519_seed || "evm-payment-key")` → secp256k1 private key (in `packages/node/src/payments/evm/keypair.ts`)
- **Escrow balance read**: `BaseEscrowClient.getBuyerAccount(address)` returns `{ balance, reserved, withdrawalAmount, ... }`
- **Available balance**: `balance - reserved - withdrawalAmount`
- **Credit limit**: Dynamic, grows with usage — `getBuyerCreditLimit(address)` on contract
- **Payment protocol messages**: SpendingAuth (0x50), AuthAck (0x51), SellerReceipt (0x53), BuyerAck (0x54), TopUpRequest (0x55)
- **Existing code to reuse**: `BuyerPaymentManager`, `BaseEscrowClient`, `identityToEvmWallet()`, `signSpendingAuth()`, payment protocol message types
