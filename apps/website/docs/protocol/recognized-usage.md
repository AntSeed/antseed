---
sidebar_position: 6
slug: /recognized-usage
title: Recognized Usage and ANTS Rewards
hide_title: true
---

# Recognized Usage and ANTS Rewards

**Protocol start: September 10, 2026 at 09:54:21 UTC — epoch 22.**

Recognized usage connects ANTS rewards to paid service delivery and seller-pool
stake. This page describes the protocol from that start date: seller eligibility,
locked staking positions, usage points, and reward distribution. Buyer USDC
deposits, payment channels, and settlement signatures are unchanged.

**Looking for rewards earned before migration?** See
[Legacy emissions and claims](./legacy-emissions.md).

## Seller pools and recognized usage

Recognized usage requires an eligible seller pool with sufficient epoch power.
Accounting applies the registered points policies and tracks buyer/seller
points and pool-weighted points. A missing pool or filtered record earns no
new usage points; this does not prevent the underlying USDC settlement.

`AntseedSellerPools` holds locked ANTS positions represented by lANTS NFTs.
Staking power activates in the following epoch. Initialize or seed seller pools
before an epoch boundary to have power in that epoch.
Legacy USDC staking remains an eligibility fallback until explicitly disabled;
the new seller registry does not expose the legacy USDC withdrawal flow.

## Starter positions and seller proxies

Fund `AntseedPositionInit` with ANTS separately. Before global transfers are
enabled, the funding wallet must be a whitelisted sender. Fund conservatively:
the faucet has no owner or sweep function, so unused funds cannot be recovered.

An eligible seller can call `initPosition()`. For a contract seller, an
authorized operator can call `initPosition(seller)`. When caller and seller
differ, the seller's `isOperator(caller)` must return true. Owning the proxy or
staking DIEM does not by itself satisfy that check.

The caller owns the resulting position, its staking rewards, and withdrawal
rights; the seller's agent pool receives the power. There is one starter grant
per agent. Historical wash flags do not prevent initialization.

With the recognized-usage CLI, use `antseed seller legacy claim-starter`
for starter-position initialization. It creates a staking position;
it does not withdraw locked legacy rewards. That separate release is described
in [Locked seller rewards: M002](./legacy-emissions.md#locked-seller-rewards-m002).

## Points policies and historical wash trading

The owner-managed registry applies policies in registration order. Each policy
receives `points(channelId, buyer, seller, sellerPoints, buyerPoints)` and returns
`(sellerPoints, buyerPoints)`. This preserves the existing accounting interface.
A zeroed side cannot be restored; evaluation ends when both sides are zero.

The registered wash policy zeros both sides for a seller flagged by the
historical proof registry's **25% authenticated seller-volume threshold**.
Flagging affects future records only: it does not erase already credited points.
The policy reads proofs accepted by the configured registry; submissions to a
different registry are not automatically recognized.

## Emissions and destinations

The gate uses weekly epochs and a 104-epoch halving interval. Its genesis is
April 9, 2026 at 09:54:21 UTC. The token's maximum supply remains 1.04 billion ANTS.
Allocation ceilings from epoch 22 are:

- **40% seller-pool rewards**, with the effective share determined dynamically.
- **20% usage rewards**, with dynamic buyer and seller/operator shares.
- **15% team**.
- **15% emissions reserve**.
- **10% verification**.

These are not a promise that every bucket is fully paid to users. Reward
eligibility, pool power, utilization, and the contracts' remainder rules apply.

The configured destinations are:

- USDC protocol fees and legacy reserve flushes: registry reserve
  `0xBF348D3eEDA2012c60375ebFe4Eb46511859f70F`.
- Team emissions and legacy team flushes: registry team wallet
  `0x47151b68e2f34500A4f8886885cE69b179Bf5B0B`.
- New ANTS reserve emissions: `0x3B4f9f426B9E465621037dF72b6DEBDD8EF1fD8c`.
- Initial verification controller: `0x5B3A59088bD5BD5f722571420c09a9251a03AAdb`.

The verification allocation initially belongs to a wallet, not a deployed
verification contract. Keep gate ownership so its editable controller can later
be transferred to that contract. Enabling ANTS trading is also a separate,
one-way action; M001 does not enable it.

For pre-migration claims and reserve/team flushes, see
[Legacy emissions and claims](./legacy-emissions.md#escrow-and-flushes).

## Deployed M001 contracts — Base mainnet {#mainnet-contracts}

These are the Base mainnet contracts for the protocol starting at epoch 22.
All 11 were deployed on September 6, 2026 and verified on Basescan.

| Contract | Address |
|---|---|
| AntseedWashTradingRegistry | `0xc02a111CB94332Cc31C08E079cbe781880b2121C` |
| AntseedEmissionsGate | `0xE60a31E6CD2F8455503cA0B3f6545Dd3DDF543BD` |
| AntseedSellerPools | `0x8Bf4d39AA13F3CB03F87D9500767fBc4D0940652` |
| AntseedSellerRegistry | `0x99c533BCc6Ca646E543dbA835Fdbb9C2ee02Cb60` |
| AntseedPositionInit | `0xB68AD13b681319fcEB6b0A640c2fd96C0138CBc8` |
| AntseedUsageAccounting | `0xAdd2D85316153D7bfaF7921EE9Bf1Bb6c7A1cBc9` |
| AntseedPointsPolicyRegistry | `0x212D2C1058b84507de248a147aaFeB08fb19E3b6` |
| AntseedWashTradingPointsPolicy | `0x7a605aaa3c725aa25012dfDeD6B5dddcC561D6e5` |
| AntseedSellerPoolsRewards | `0x83cc5B9AA0c8cB8683F35462c385a5BAAa755EE5` |
| AntseedUsageRewards | `0x78330bF154172F1137219Bb559d4F3A270B3201F` |
| AntseedLegacyEmissionsEscrow | `0x4d0fC3C0BBb5233Af6c4Ce33223e5330c34db9ab` |

The [payments address list](./payments.md#base-mainnet-contract-addresses)
contains the settlement contracts. Pre-migration endpoints are listed in the
[legacy guide](./legacy-emissions.md#legacy-contract-addresses).

## SDK configuration

`getChainConfig('base-mainnet').recognizedUsage` exposes all 11 addresses under
`contracts`, plus `effectiveEpoch` and a recorded `status` of `deployed` or
`active`. This metadata is generated from the deployment ledger, not a live
RPC query. A scheduled epoch passing does not automatically change its status.

`emissionsContractAddress` and `stakingContractAddress` follow the committed
active `current.json`; the gate is not an accounting endpoint. Pool and reward
contracts use their own interfaces; legacy CLI staking commands are not
starter-position initialization commands.

## Deployment and activation

The start date is scheduled; activation is a separate operator transaction,
not an automatic timestamp switch. The mainnet deployment record is
`packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json`.
For operational sequencing, proof submission, funding, and pointer checks, use
`packages/contracts/script/migrations/M001RecognizedUsage/README.md` in the repository.
