# PRD-06: CLI, E2E Testing, Documentation

**Created:** 2026-03-16T10:55Z
**Depends On:** PRD-03, PRD-04, PRD-05
**Estimated Tasks:** 11

---

## Overview

Updated CLI commands for the new payment system, end-to-end integration tests on Base Sepolia, and protocol documentation updates.

---

## Task 1: CLI — guided onboarding flow (`antseed setup`)

##### CREATE: `apps/cli/src/cli/commands/setup.ts`

Interactive guided setup command that walks through the full provider or buyer onboarding:

```
$ antseed setup

Welcome to AntSeed!

Your EVM wallet: 0x1234...abcd (derived from your identity)
Network: Base Sepolia

Choose your role:
  1. Provider (serve AI requests and earn USDC + ANTS)
  2. Buyer (use AI services from the network)

> 1

Provider Setup
==============

Step 1/4: Gas balance
  ❌ No ETH for gas fees.
  → Send at least 0.001 ETH to 0x1234...abcd on Base Sepolia
  → Waiting... (press Enter to check again)

  ✅ ETH balance: 0.005

Step 2/4: Register identity
  → This mints a soulbound NFT that identifies you on the network.
  → Registering... tx: 0xabc123
  ✅ Registered! Token ID: 42

Step 3/4: Stake USDC
  → Staking locks USDC as collateral. Minimum: 10 USDC.
  → How much USDC to stake? [10]: 50
  → Approving USDC... Staking... tx: 0xdef456
  ✅ Staked 50 USDC

Step 4/4: Set token rate
  → Your rate for converting tokens to credits (USDC per 1M tokens).
  → Rate? [1000000] (= $1 per 1M tokens):
  ✅ Rate set: 1000000 credits per 1M tokens

🎉 Setup complete! Run 'antseed seed' to start serving.

IMPORTANT: Your identity file at ~/.antseed/identity.json controls
your wallet, stake, and earnings. Back it up securely.
```

For buyer mode:
```
Step 1/3: Gas balance (same as above)
Step 2/3: Deposit USDC into escrow
Step 3/3: Done — connect to peers automatically
```

Uses `checkSellerReadiness()` / `checkBuyerReadiness()` from `packages/node/src/payments/readiness.ts` to determine what's needed.

#### Acceptance Criteria
- [ ] Interactive guided flow for providers and buyers
- [ ] Checks prerequisites before each step
- [ ] Waits for gas if needed
- [ ] Shows clear progress and next steps
- [ ] Warns about identity file backup
- [ ] Idempotent — re-running skips completed steps

---

## Task 2: CLI — register command

##### CREATE: `apps/cli/src/cli/commands/register.ts`

New command: `antseed register`
- Derives EVM address from identity
- Calls `identityClient.register(peerId, metadataURI)`
- MetadataURI = peer's announced capabilities (JSON, can be empty initially)
- Displays: tokenId, EVM address, registration tx hash

Follow patterns from existing CLI commands (balance.ts, deposit.ts).

#### Acceptance Criteria
- [ ] `antseed register` mints AntseedIdentity NFT
- [ ] Displays registration confirmation

---

## Task 2: CLI — stake and unstake commands

##### CREATE: `apps/cli/src/cli/commands/stake.ts`

`antseed stake <amount>`:
- Validates peer is registered (identityClient.isRegistered)
- Approves USDC + calls escrowClient.stake(amount)
- Displays: stake amount, tx hash

`antseed unstake`:
- Calls escrowClient.unstake()
- Displays: returned amount, slashed amount (if any), tx hash

#### Acceptance Criteria
- [ ] Stake requires registration
- [ ] Unstake shows slash amount

---

## Task 3: CLI — update balance, deposit, withdraw commands

##### MODIFY: `apps/cli/src/cli/commands/balance.ts`

Update to use new EscrowClient interface:
- Show: available balance, reserved, pending withdrawal, last activity
- Show: stake amount, earnings, token rate (if seller)
- Show: reputation summary (firstSigns, provenSigns, ghosts)

##### MODIFY: `apps/cli/src/cli/commands/deposit.ts`

Update to use new `escrowClient.deposit()` (was `deposit` with different args).

##### MODIFY: `apps/cli/src/cli/commands/withdraw.ts`

Update to use `requestWithdrawal` / `executeWithdrawal` / `cancelWithdrawal`.
- `antseed withdraw request <amount>` — starts withdrawal
- `antseed withdraw execute` — executes after inactivity period
- `antseed withdraw cancel` — cancels pending

#### Acceptance Criteria
- [ ] Balance shows all new fields
- [ ] Deposit works with new contract
- [ ] Withdraw 3-step flow works

---

## Task 4: CLI — emissions and reputation commands

##### CREATE: `apps/cli/src/cli/commands/emissions.ts`

`antseed emissions`:
- Shows current epoch, emission rate, time remaining
- Shows pending seller/buyer emissions for this wallet
- `antseed emissions claim` — claims accrued ANTS

##### CREATE: `apps/cli/src/cli/commands/reputation.ts`

`antseed reputation [address]`:
- Queries AntseedIdentity for reputation data
- Shows: firstSignCount, qualifiedProvenSignCount, ghostCount, lastProvenAt
- Shows: ERC-8004 feedback summary for "quality" tag
- If no address given, uses own address

#### Acceptance Criteria
- [ ] Emissions display and claim work
- [ ] Reputation shows both proof chain and feedback data

---

## Task 5: CLI — sessions command

##### CREATE: `apps/cli/src/cli/commands/sessions.ts`

`antseed sessions`:
- Reads from local SessionStore (SQLite)
- Lists active and recent sessions
- Shows: sessionId, peer, status, tokens delivered, settled amount
- `antseed sessions --history` — full history with proof chain links

#### Acceptance Criteria
- [ ] Sessions listed from local database
- [ ] Proof chain visible in history view

---

## Task 6: CLI — subscribe command

##### CREATE: `apps/cli/src/cli/commands/subscribe.ts`

`antseed subscribe <tierId>`:
- Shows tier info (fee, daily budget)
- Confirms and pays monthly fee
- Displays subscription expiry

`antseed subscribe status`:
- Shows active subscription, remaining daily budget

`antseed subscribe cancel`:
- Cancels subscription

#### Acceptance Criteria
- [ ] Subscribe flow works
- [ ] Status shows remaining budget

---

## Task 7: Update CLI payment-utils and connect command

##### MODIFY: `apps/cli/src/cli/payment-utils.ts`

Update `createEscrowClient()` to use new config (add identityAddress).
Add `createIdentityClient()`, `createEmissionsClient()`, `createSubPoolClient()` factory functions.

##### MODIFY: `apps/cli/src/cli/commands/connect.ts`

Update to use new payment flow:
- Check if peer is registered (identityClient)
- SpendingAuth-based connection (not SessionLockAuth)
- Show proof chain status

#### Acceptance Criteria
- [ ] All client factories work
- [ ] Connect command uses new protocol

---

## Task 8: Update CLI plugin registry

##### MODIFY: `apps/cli/src/plugins/registry.ts` (or equivalent command registration file)

Register all new commands: register, stake, unstake, emissions, reputation, sessions, subscribe.

#### Acceptance Criteria
- [ ] All new commands available via `antseed --help`

---

## Task 9: E2E integration tests

##### CREATE: `e2e/payments-e2e.test.ts`

End-to-end tests against local Anvil fork:

1. **Deploy all contracts:** MockUSDC, ANTSToken, AntseedIdentity, AntseedEscrow, AntseedSubPool, AntseedEmissions. Wire them together.

2. **Full lifecycle test:**
   - Register peer identity
   - Stake USDC
   - Buyer deposits USDC
   - Buyer connects → first sign (capped at $1)
   - Serve requests, exchange receipts
   - Buyer disconnects and reconnects → proven sign → settle session 1
   - Repeat for 3 sessions (proof chain)
   - Verify reputation counters on-chain
   - Seller claims earnings
   - Buyer submits ERC-8004 feedback
   - Advance epoch, claim ANTS emissions
   - Seller unstakes (clean exit, no slash)
   - Buyer withdraws (after inactivity period)

3. **Anti-gaming test:**
   - First sign cap enforcement
   - Cooldown enforcement (warp time)
   - Buyer diversity (need 3 sellers for qualified)
   - Ghost timeout path

4. **Slashing test:**
   - Seller with zero proven signs → 100% slash
   - Seller with low ratio → 50% slash

5. **Subscription test:**
   - Create tier, subscribe, use daily budget, distribute revenue

#### Acceptance Criteria
- [ ] All E2E tests pass against local Anvil
- [ ] Full proof chain verified across sessions
- [ ] Anti-gaming defences verified
- [ ] Slashing verified

---

## Task 10: Documentation updates

##### MODIFY: `docs/protocol/spec/04-payments.md`

Complete rewrite covering:
- Proof of Prior Delivery overview
- Session lifecycle (Reserve → Serve → Settle)
- SpendingAuth EIP-712 structure
- Anti-gaming defences (all 6 layers)
- Slashing conditions
- Emission distribution (points system, Synthetix pattern)
- Contract addresses (placeholder for deployment)
- Supported chains

##### MODIFY: `packages/node/contracts/README.md`

Update with:
- Contract architecture (5 contracts)
- Build instructions (forge build, forge test)
- Deployment guide (Base Sepolia, Base Mainnet)
- Contract interaction examples

#### Acceptance Criteria
- [ ] Docs accurately reflect the implemented protocol
- [ ] No references to old SessionLock protocol remain
