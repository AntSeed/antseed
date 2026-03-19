# Master Plan: Desktop OnchainKit Wallet Integration

**Status:** PRDS_GENERATED
**PRDs Generated:** 2026-03-19T10:30:00Z
**Branch:** `feat/desktop-onchainkit-wallet` (derived from `feat/proof-of-prior-delivery`)
**Date:** 2026-03-19

## Overview

Integrate Coinbase OnchainKit into the AntSeed Desktop app to provide a seamless, chat-driven payment experience for buyers. Users connect or create a wallet via passkeys (Coinbase Smart Wallet), fund it with USDC, and approve payment authorizations — all inline in the chat conversation, never leaving the chat interface.

## Goals

1. **Zero-friction wallet onboarding** — passkey-based Smart Wallet via OnchainKit, no seed phrases, no browser extensions
2. **Chat-native payments** — every payment interaction (connect, fund, deposit, sign auth, top-up) appears as a chat bubble in the conversation flow
3. **Title bar wallet badge** — compact balance display (wallet + escrow USDC) next to the theme toggle, with dropdown for wallet details
4. **No middleman dependencies** — no paymaster, no hosted auth service. Users pay their own gas. OnchainKit is client-side React only.
5. **Desktop-only scope** — this is a UI layer on top of the payment protocol. CLI and headless agents continue using the identity-derived wallet. The protocol itself is unchanged.

## Architectural Decisions

### AD-1: OnchainKit over Privy
OnchainKit is open-source, Base-native, has no server dependency (Privy requires their auth servers), and includes built-in components for wallet connection, on-ramp (`<FundButton />`), transaction confirmation (`<Transaction />`), and EIP-712 signing (`<Signature />`). Aligns with AntSeed's P2P, no-middleman philosophy.

### AD-2: Replace WalletConnect, don't keep both
The existing WalletConnect integration (`src/main/walletconnect.ts`) is a stub — deposit/withdraw handlers just log messages, balances are hardcoded to `'0.00'`. OnchainKit's wagmi connectors handle both Smart Wallet creation AND external wallet connections (MetaMask, WalletConnect, etc.), so the existing code is fully replaced.

### AD-3: wagmi + viem in renderer, ethers stays in main
OnchainKit requires wagmi + viem. These are added to the renderer (React) side only. The main process and the @antseed/node SDK continue using ethers for headless/CLI operations. No cross-contamination — the renderer talks to the wallet via wagmi hooks, the main process talks to the blockchain via ethers when needed for background operations.

### AD-4: No separate wallet view
All wallet interactions happen either in the title bar (connect button, balance badge, dropdown) or inline in the chat as system bubbles. No `WalletView` in the sidebar. The wallet is ambient, not a destination.

### AD-5: Chat bubbles for payment flow
Payment prompts are rendered as special chat bubble types (system messages) that embed OnchainKit components:
- `bubble-connect` — "Connect your wallet to continue" + `<ConnectWallet />`
- `bubble-fund` — "Fund your wallet" + `<FundButton />`
- `bubble-deposit` — "Deposit USDC to escrow" + `<Transaction />`
- `bubble-sign-auth` — "Approve spending authorization" + `<Signature />`
- `bubble-topup` — "Approve additional budget" + `<Signature />`

### AD-6: No gas sponsorship (Paymaster)
Users pay their own gas on Base (~$0.001/tx). This avoids making AntSeed a middleman. The `<FundButton />` on-ramp supports both USDC and ETH purchases. Documentation will note that node operators can optionally configure their own Paymaster.

### AD-7: Balance badge shows both balances
Title bar badge format: `12.50 USDC` showing combined wallet + escrow balance. The dropdown breaks it down: wallet balance (available to deposit) and escrow balance (deposited, available for sessions).

### AD-8: Seller transactions out of scope
Register, stake, and setTokenRate are seller-side operations done via CLI on headless servers. The desktop buyer flow only needs: deposit, withdraw (request/execute/cancel), and SpendingAuth signing. Withdraw is lower priority and can be a follow-up.

### AD-9: Theme integration via CSS variable mapping
OnchainKit ships with its own CSS. Override OnchainKit's CSS variables to match the AntSeed desktop theme (mint accent `#1FD87A`, cream background `#F5F5F1`, Geist font). Both light and dark themes must work since the desktop supports theme toggling.

### AD-10: Separate branch
This work lives on `feat/desktop-onchainkit-wallet` branched from `feat/proof-of-prior-delivery`. The payment protocol (contracts, SDK, P2P) is not modified — only the desktop renderer and main process.

## PRD Dependency Graph

```
PRD-01 (Foundation)
  │
  ├──→ PRD-02 (Title Bar Wallet)
  │
  ├──→ PRD-03 (Chat Payment Bubbles)
  │         │
  │         ▼
  └──→ PRD-04 (Payment Flow Orchestration)
              ▲
              │
         PRD-02 ─┘
```

PRD-01 must complete first (providers, deps, cleanup). PRD-02 and PRD-03 can run in parallel after PRD-01. PRD-04 depends on both PRD-02 and PRD-03.

## PRD Summary Table

| PRD | Name | Dependencies | Est. Tasks | Description |
|-----|------|-------------|------------|-------------|
| 01 | Foundation | None | 5 | Add OnchainKit + wagmi + viem deps, create providers, remove WalletConnect, map CSS variables |
| 02 | Title Bar Wallet | 01 | 4 | Connect button + balance badge in TitleBar, WalletDropdown, escrow balance read |
| 03 | Chat Payment Bubbles | 01 | 6 | 5 bubble types (connect, fund, deposit, sign-auth, topup) with OnchainKit components |
| 04 | Payment Flow Orchestration | 02, 03 | 5 | State machine, chat integration, pending message queue, IPC wiring |
| | **Total** | | **20** | |

## Out of Scope

- **Seller-side transactions** (register, stake, setTokenRate) — CLI only
- **Gas sponsorship / Paymaster** — users pay own gas, operators can configure their own
- **Withdrawal UI** — lower priority, follow-up PR
- **CLI wallet changes** — CLI continues using identity-derived wallet
- **Protocol changes** — contracts, P2P, session store unchanged
- **Mobile / web** — desktop Electron only
- **SubPool subscription UI** — SubPool deferred from deployment

## Resolved Questions

- **OnchainKit vs Privy?** → OnchainKit (open-source, no server dependency, Base-native)
- **Keep WalletConnect?** → No, replace entirely with OnchainKit's wagmi connectors
- **Wallet view in sidebar?** → No, title bar + chat bubbles only
- **Gas sponsorship?** → No, users pay own gas (no middleman)
- **Fund both USDC + ETH?** → Separate on-ramp actions (Coinbase limitation), FundButton configured for each
- **Signature component for SpendingAuth?** → Yes, OnchainKit `<Signature />` wraps EIP-712 signing
- **Balance badge shows what?** → Combined wallet + escrow USDC, dropdown shows breakdown
- **Existing users?** → Fresh deployment, no migration needed
- **Buyer without UI?** → Headless agents use identity-derived wallet (unchanged)
