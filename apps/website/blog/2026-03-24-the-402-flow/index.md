---
slug: the-402-flow
title: "The 402 Flow"
authors: [antseed]
tags: [protocol, payments, WebRTC, P2P, transport]
description: How AntSeed uses HTTP 402 to trigger fully decentralized payment negotiation — multiplexed over the same WebRTC DataChannel as proxy traffic.
keywords: [HTTP 402, payment negotiation, WebRTC, PaymentMux, P2P payments, decentralized payments, binary protocol]
image: /og-image.jpg
date: 2026-03-24
---

HTTP 402 Payment Required has been in the HTTP spec since 1997 — "reserved for future use." Nearly three decades later, it remains the only HTTP status code that was defined but never given a standard mechanism. No one agreed on what the payment payload should look like, how the negotiation should work, or who should facilitate it.

AntSeed uses 402 as the trigger for fully decentralized payment negotiation between peers. No payment gateway, no relay, no facilitator. The entire flow — from the initial 402 response to the on-chain reserve transaction to the retried request — happens over a single WebRTC DataChannel that's already open for proxy traffic.

<!-- truncate -->

## The Trigger

A buyer connects to a seller peer and sends an HTTP request (proxied over WebRTC as a binary-framed `HttpRequest` message, type 0x20). If no spending authorization exists for this buyer-seller pair, the seller responds with HTTP 402 and a `PaymentRequired` message (type 0x56) containing the terms:

```json
{
  "sellerEvmAddr": "0x...",
  "tokenContract": "0x...USDC",
  "tokenRate": "0.001",
  "firstSignCap": "5.00",
  "suggestedAmount": "10.00"
}
```

`tokenRate` is the per-unit price (denominated in the token contract's decimals). `firstSignCap` is the maximum the seller will accept on a first authorization — a ceiling that limits the buyer's exposure to an unknown peer. `suggestedAmount` is what the seller recommends for uninterrupted service based on typical request patterns.

This payload rides the same binary frame as every other message in the protocol: a 9-byte header (`type` uint8, `messageId` uint32 BE, `payloadLength` uint32 BE) followed by a JSON-encoded body. The `messageId` ties the PaymentRequired back to the original HttpRequest, so the buyer knows which request triggered the negotiation.

## Auto Mode: PaymentMux

This is the core of the design. Payment negotiation does not open a new connection, use a sidecar WebSocket, or call out to a third-party API. It rides the existing WebRTC DataChannel — the same one carrying proxy traffic.

### The mux

AntSeed's frame protocol reserves type ranges for different concerns:

| Range | Purpose |
|---|---|
| 0x01-0x02 | Handshake |
| 0x10-0x11 | Keepalive |
| 0x20-0x26 | Proxy (HTTP request/response, chunked upload) |
| 0x50-0x5F | Payment |
| 0xF0-0xFF | Control (disconnect, error) |

All of these share a single DataChannel. The frame header's `type` byte is the discriminator. The receiving side dispatches to the appropriate handler: proxy messages go to `ProxyMux`, payment messages go to `PaymentMux`, keepalive messages go to the heartbeat manager. There is no channel-per-concern — multiplexing happens at the message type level, not the transport level.

This matters because WebRTC DataChannel setup has real cost. ICE negotiation, DTLS handshake, SCTP association — even with an established peer connection, opening a new DataChannel involves round-trips. By keeping payment messages on the existing channel, the 402 flow adds zero transport overhead. The only added latency is the on-chain transaction itself.

### The flow

When the buyer node receives a 402 + PaymentRequired, auto mode handles everything internally — the application never sees the 402.

1. **Balance check.** The buyer node queries the escrow contract to verify it has sufficient deposited balance for the suggested amount.

2. **Sign SpendingAuth.** The buyer constructs an EIP-712 typed data structure (`SpendingAuth`) containing the seller's address, the token contract, the authorized `maxAmount`, and a nonce. The buyer's embedded wallet signs it. This signature authorizes the seller to charge up to `maxAmount` from the buyer's escrow deposit — but the buyer never sends funds directly. The seller must call `reserve()` to claim them.

3. **Send 0x50.** The signed SpendingAuth is JSON-encoded and sent as a payment frame (type 0x50) on the same DataChannel. The `messageId` matches the original request that triggered the 402, maintaining correlation.

4. **On-chain reserve.** The seller receives the SpendingAuth, verifies the EIP-712 signature, and calls `reserve(buyerAddr, maxAmount, signature)` on the `AntseedEscrow` contract. This locks `maxAmount` of the buyer's deposit for this seller. The transaction confirms on-chain (Base L2 — typical confirmation time 2-3 seconds).

5. **AuthAck 0x51.** Once the reserve transaction confirms, the seller sends an `AuthAck` (type 0x51) back to the buyer with the transaction hash. The buyer now knows the authorization is active.

6. **Retry.** The buyer retries the original HttpRequest (0x20). The seller now has a valid reservation and serves the request normally, responding with HttpResponse (0x21) or streaming chunks (0x22/0x23).

```
Buyer                           Seller                     Chain
  │                               │                          │
  ├── 0x20 HttpRequest ──────────>│                          │
  │<── 0x56 PaymentRequired ──────┤                          │
  │                               │                          │
  │  [check balance]              │                          │
  │  [sign EIP-712]               │                          │
  │                               │                          │
  ├── 0x50 SpendingAuth ─────────>│                          │
  │                               ├── reserve() ────────────>│
  │                               │<── confirmed ────────────┤
  │<── 0x51 AuthAck ──────────────┤                          │
  │                               │                          │
  ├── 0x20 HttpRequest ──────────>│  [serves normally]       │
  │<── 0x21 HttpResponse ─────────┤                          │
```

Total added latency for the payment negotiation: roughly 2-5 seconds, dominated by the on-chain `reserve()` confirmation. The binary framing, JSON encoding, and DataChannel transit are sub-millisecond. This cost is paid once per buyer-seller pair — subsequent requests reuse the existing authorization until it's exhausted.

### During serving

Once the authorization is active, payment messages continue to flow alongside proxy traffic on the same channel:

- **SellerReceipt (0x53):** The seller periodically reports cumulative usage against the authorized `maxAmount`. This gives the buyer real-time visibility into spend without requiring on-chain reads.

- **BuyerAck (0x54):** The buyer acknowledges each receipt. This creates a bilateral accounting trail — both sides agree on usage at each checkpoint.

- **TopUpRequest (0x55):** When cumulative usage exceeds 80% of `maxAmount`, the seller sends a TopUpRequest. The buyer can sign a new SpendingAuth with additional funds, extending the session without interruption. If the buyer doesn't top up, the seller can finish the current request but will 402 the next one.

These messages are interleaved with proxy traffic. A streaming AI response might produce dozens of `HttpResponseChunk` (0x22) frames between two `SellerReceipt` (0x52) frames. The mux handles this naturally — the `type` byte routes each frame to the correct handler regardless of ordering.

## Manual Mode: HTTP Header

Auto mode requires the buyer node to hold signing keys. In the desktop app, the user may want explicit approval before authorizing spend. Manual mode supports this.

When manual mode is configured, the 402 and PaymentRequired payload propagate through the proxy to the application. The desktop app renders an approval card showing the seller's address, token rate, and suggested amount. The user reviews and approves (or rejects).

On approval, the desktop app signs the SpendingAuth using the user's wallet (keychain-stored keys) and attaches it as a base64-encoded `x-antseed-spending-auth` header on the retry request. The buyer node intercepts this header before proxying — it strips the header from the outgoing HTTP request and sends the SpendingAuth via PaymentMux (0x50) on the DataChannel. From the seller's perspective, the flow is identical: it receives a 0x50 frame, verifies the signature, calls `reserve()`, and sends AuthAck.

The header is an internal transport mechanism. It never reaches the seller's HTTP handler — the node extracts it at the proxy layer. This keeps the seller's API surface clean: it only ever sees standard HTTP requests and PaymentMux binary frames.

## Convergence

Both modes produce the same EIP-712 `SpendingAuth` structure. Both send it through the same PaymentMux. Both result in the same `reserve()` call on the same escrow contract. The only difference is where the signature originates — the node's embedded wallet (auto) or the user's keychain wallet (manual).

This means the seller implementation is mode-agnostic. It receives a SpendingAuth, verifies it, and reserves. It doesn't know or care whether a human approved it or a node signed it autonomously.

## Comparison to x402

Coinbase's x402 protocol also uses HTTP 402 as a payment trigger. The key architectural difference is settlement.

In x402, a facilitator sits between buyer and seller. The buyer pays the facilitator, the facilitator verifies payment, and the facilitator tells the seller to proceed. Settlement flows through the facilitator's infrastructure. This is a practical design for consumer payments, but it reintroduces the intermediary that decentralized systems are designed to eliminate.

In AntSeed, the seller calls `reserve()` and later `settle()` directly on the escrow contract. No entity holds or routes funds on anyone's behalf. The buyer's deposit sits in the escrow contract; the seller's authorization lets them draw against it. The only intermediary is the smart contract itself — immutable, auditable, and controlled by neither party.

This is a deliberate tradeoff. x402's facilitator model enables features like refunds and dispute resolution that AntSeed's contract doesn't natively support. But for machine-to-machine payment where both sides are programmatic and the service is delivered immediately (an AI API response), the facilitator adds latency and trust assumptions without proportional benefit.

## Why This Matters

The mux design means payment negotiation adds zero infrastructure overhead. There is no payment service to deploy, no WebSocket server to maintain, no message broker to scale. Payment is just another message type on an existing peer connection — six bytes of type-range allocation in a frame protocol that was already being parsed.

When a buyer connects to a new seller for the first time, the 402 flow adds a one-time 2-5 second delay for the on-chain transaction. Every subsequent request on that connection is served at full speed, with bilateral accounting flowing alongside proxy traffic as background noise on the mux.

The 402 status code waited 29 years for a mechanism. This is ours: a binary frame on an open DataChannel, an EIP-712 signature, and a single smart contract call. No gateway, no relay, no facilitator.
