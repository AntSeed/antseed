# Antseed Network Protocol Specification

**Version:** 1.0 (current discovery metadata format uses `METADATA_VERSION = 4`)

## Overview

AntSeed is a fully decentralized protocol for peer-to-peer AI services directly between peers, without any central server, marketplace, or intermediary. Nodes discover each other, negotiate terms, stream inference results, meter token usage, settle payments, and build reputation — all through direct peer-to-peer communication. The network exists entirely as the set of participating nodes; there is no infrastructure beyond the nodes themselves.

## Architecture

Antseed is **fully decentralized**. There is no central server, coordinator, or registry. Every participating node IS the network. Nodes communicate directly with one another over peer-to-peer connections. When a node joins, it becomes part of the network fabric. When it leaves, the remaining nodes continue operating without disruption.

Key architectural principles:

- **No central server**: Discovery, negotiation, metering, payments, and reputation are all handled peer-to-peer.
- **Nodes ARE the network**: The network is defined entirely by the set of active nodes. There is no separate infrastructure to deploy or maintain.
- **Direct communication**: All interactions (discovery, inference requests, payment settlement) happen directly between the two parties involved.

## Node Roles

Every node in the Antseed Network operates in one or both of the following roles:

### Seller

A **Seller** node provides LLM inference capacity to the network. Sellers:

- Advertise available models, pricing, and capacity
- Accept inference requests from Buyers
- Stream inference results back to Buyers
- Report token usage for metering and billing

### Buyer

A **Buyer** node consumes LLM inference from the network. Buyers:

- Discover available Sellers and their offerings
- Select Sellers based on price, model, reputation, and availability
- Send inference requests and receive streamed results
- Verify metered token usage and settle payments

A single node may act as both a Seller and a Buyer simultaneously.

## Protocol Layers

The Antseed protocol is organized into five functional layers plus one cross-cutting security layer:

### 1. Discovery

How nodes find each other and advertise their capabilities. Covers peer announcement, model metadata broadcasting, and network bootstrapping.

See: [01-discovery.md](./01-discovery.md)

### 2. Transport

How nodes communicate for inference requests and responses. Covers connection establishment, request framing, streaming token delivery, and error handling.

See: [02-transport.md](./02-transport.md)

### 3. Metering

How token usage is measured, reported, and verified. Covers input/output token counting, usage attestation, and dispute handling.

See: [03-metering.md](./03-metering.md)

### 4. Payments

How Buyers pay Sellers for inference. Covers pricing terms, payment settlement, escrow mechanics, and refund conditions.

See: [04-payments.md](./04-payments.md)

### 5. Reputation

How nodes build and query trust. Covers reputation scoring, peer ratings, historical performance tracking, and Sybil resistance.

See: [05-reputation.md](./05-reputation.md)

### 6. Security (Cross-Cutting)

How trust boundaries, cryptographic controls, abuse resistance, and residual risks are handled across discovery, transport, metering, and payments.

See: [06-security-overview.md](./06-security-overview.md)

## Specification Documents

| Document | Layer | Description |
|---|---|---|
| [00-conventions.md](./00-conventions.md) | — | Conventions and definitions used across all specs |
| [01-discovery.md](./01-discovery.md) | Discovery | Peer discovery and capability advertisement |
| [02-transport.md](./02-transport.md) | Transport | Inference request/response transport |
| [03-metering.md](./03-metering.md) | Metering | Token usage metering and verification |
| [04-payments.md](./04-payments.md) | Payments | Payment settlement and pricing |
| [05-reputation.md](./05-reputation.md) | Reputation | Trust and reputation system |
| [06-security-overview.md](./06-security-overview.md) | Security | Cross-layer security model, controls, and hardening priorities |

## Version History

| Version | Date | Notes |
|---|---|---|
| 1.1 | 2026-03-01 | Added cross-layer security overview for buyer-seller flow |
| 1.0 | 2026-02-18 | Initial protocol specification |
