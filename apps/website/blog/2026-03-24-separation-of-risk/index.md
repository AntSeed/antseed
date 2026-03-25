---
slug: separation-of-risk
title: "Separation of Risk"
authors: [antseed]
tags: [security, wallet-architecture, P2P, key-management]
description: How AntSeed separates signing identity from funding wallet to eliminate private key exposure in decentralized AI compute.
keywords: [wallet security, signing identity, funding wallet, EIP-712, session keys, P2P payments, key management]
image: /og-image.jpg
date: 2026-03-24
---

Any P2P network with on-chain payments faces the same tradeoff: either run a hot wallet with real funds so your node can transact autonomously, or introduce custodial key management and hope the operator doesn't disappear. Both options have well-understood failure modes. Hot wallets get drained. Custodians get hacked, or worse, rug.

AntSeed sidesteps this by splitting the problem into two independent concerns: the key that signs payment authorizations and the wallet that holds funds. They are cryptographically unrelated. Compromising one does not compromise the other.

<!-- truncate -->

## Two Keypairs, One Seed

Every AntSeed node starts with a single Ed25519 seed. From this seed, two independent keypairs are derived:

**P2P identity** — an Ed25519 keypair used for peer authentication, metadata signing, and metering receipt signatures. This is the node's identity on the network.

**EVM signing identity** — a secp256k1 keypair derived via `keccak256(ed25519_seed || "evm-payment-key")`. This is the address that signs EIP-712 `SpendingAuth` structs. The domain separation in the derivation ensures the two keypairs are cryptographically independent — knowing one does not reveal the other.

The signing identity is app-managed. It lives on the node, signs payment authorizations, and does nothing else. Critically, it never holds funds. There is no reason to send ETH or USDC to this address. It exists only to produce signatures.

The **funding wallet** is completely separate. It can be a hardware wallet, a multisig, a smart contract wallet — anything the user controls. It interacts with the AntseedDeposits contract exactly once per deposit cycle, calling `depositFor(signingIdentityAddress, amount)` to credit the signing identity's deposit balance. After that, the funding wallet has no further role.

## Why the Split Matters

Consider what happens when a node is compromised in a typical P2P network with on-chain payments. The attacker gets the private key. That key controls a wallet with funds — staked tokens, earned revenue, operational float. The attacker drains it. The operator's total exposure is whatever was in that wallet.

With AntSeed's separation, a compromised node yields the signing identity's private key. The attacker can sign SpendingAuth messages against the current deposit balance. That's it. They cannot access the funding wallet. They cannot deposit more funds. They cannot withdraw from AntseedDeposits (withdrawals go to the signing identity's address, which the attacker controls, but only the existing deposit balance is at risk).

The maximum loss from a node compromise is the current deposit balance — money the user explicitly allocated for spending. The funding wallet, which may hold significantly more, is untouched.

This is a meaningful difference. In practice, a buyer's deposit balance might be $20-50 of USDC for an active session. Their funding wallet might hold thousands. The separation turns a potentially catastrophic breach into a bounded, recoverable loss.

### Comparison with Existing Approaches

**Hot wallets** — The common approach in decentralized networks. A single key holds funds and signs transactions. Node compromise means full fund exposure. Operators mitigate by keeping balances low, but this requires constant manual rebalancing and still leaves a window of exposure after each deposit.

**Custodial solutions** — A third party manages keys on behalf of the operator. This solves the hot wallet problem by introducing a trust dependency. The custodian becomes a single point of failure and a high-value target. It also requires the operator to trust that the custodian won't freeze, lose, or misappropriate funds.

**ERC-4337 session keys** — The closest parallel to AntSeed's approach. Session keys allow a delegated signer to execute transactions within defined bounds. AntSeed's SpendingAuth serves a similar function but is purpose-built for metered compute: each authorization is scoped to a specific seller, capped at a maximum amount, and expires at a deadline. There is no generalized transaction execution — the signing identity can only authorize a seller to pull from the buyer's deposit, nothing else.

The key difference from session keys is that AntSeed's signing identity is not a delegate of the funding wallet. It is an independent identity with its own address. The funding wallet deposits into AntseedDeposits on the signing identity's behalf, but there is no on-chain delegation relationship between them. The signing identity cannot initiate transactions from the funding wallet under any circumstances.

## Desktop Implementation

The desktop app encrypts the Ed25519 seed at rest using Electron's `safeStorage` API, which delegates to the OS keychain — macOS Keychain, Windows Credential Manager, or Linux libsecret. The seed is decrypted into memory only when needed for signing operations.

On first launch after upgrading from an older version, the app detects a plaintext `identity.key` file, encrypts it via `safeStorage`, writes the encrypted version, and deletes the plaintext original. This migration is automatic and requires no user action.

The funding wallet never touches the application. A user can deposit into AntseedDeposits from a Ledger, a Trezor, a Safe multisig, or any other wallet. The deposit transaction is a standard ERC-20 approval + `depositFor()` call that can be executed from any interface — the AntSeed app, Etherscan, a script. The application has no knowledge of the funding wallet's private key and no mechanism to request it.

## Auto-Mode: Unattended Signing Without Fund Risk

The separation of signing identity from funding wallet is what makes auto-mode practical.

In auto-mode, when a buyer's node receives a 402 Payment Required response from a seller, it signs a SpendingAuth internally and returns it without user interaction. The seller submits the SpendingAuth on-chain via `reserve()` on AntseedSessions, which locks the authorized amount from the buyer's deposit. The request proceeds.

Without separation of risk, auto-mode would mean giving an unattended process the ability to spend from a wallet with real funds. That is a non-starter for most operators. With separation, auto-mode means giving an unattended process the ability to authorize spending from a pre-funded deposit balance that the user explicitly allocated. The bounds are clear:

- **Per-authorization cap**: each SpendingAuth specifies a `maxAmount` the seller can reserve
- **Deadline**: each SpendingAuth expires at a specific block timestamp
- **Seller-scoped**: each SpendingAuth is valid only for a specific seller address
- **Balance-bounded**: total spending cannot exceed the deposit balance, regardless of how many SpendingAuths are signed

If the node is compromised while running in auto-mode, the attacker can sign SpendingAuths against the deposit balance. They cannot exceed it. They cannot access the funding wallet. The user can stop the bleeding by not depositing more.

Manual mode is also supported for interactive use. In this flow, the 402 response propagates to the desktop UI, the user reviews the amount and seller, and explicitly approves the signature. The desktop app decrypts the seed from the OS keychain, signs, and returns the SpendingAuth. Same on-chain outcome, different trust model.

## What This Enables

The separation of signing identity from funding wallet is not a security feature in isolation. It is the architectural foundation that makes AntSeed's 402-based payment negotiation practical for unattended operation.

When an AI agent running through AntSeed needs compute from a seller, the entire flow — discovery, connection, 402, SpendingAuth, reserve, request, metering, settlement — happens without human involvement. The agent's node signs authorizations within pre-set bounds. The user's funds remain in a wallet the application cannot touch.

The 402 auto-negotiation flow and on-chain settlement mechanics are covered in the [payments documentation](/docs/payments). The identity derivation and key storage details are in the [security reference](/docs/security).
