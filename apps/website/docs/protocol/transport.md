---
sidebar_position: 3
slug: /transport
title: Transport
hide_title: true
---

# Transport

The transport layer handles peer-to-peer communication using WebRTC DataChannels (via `node-datachannel`) with a TCP fallback. All messages are transmitted as binary frames. Compatible with existing AI API formats, so existing tools work without modification.

## Transport Modes

| Mode | Library | Description |
|---|---|---|
| webrtc | node-datachannel | WebRTC DataChannel via TCP signaling |
| tcp | Node.js net | Direct TCP socket fallback |

## Frame Protocol

```text title="frame header (9 bytes)"
Offset  Size  Type          Field
0       1     uint8         type (MessageType)
1       4     uint32 BE     messageId
5       4     uint32 BE     payloadLength
```

Max payload size: 64 MB. Frames exceeding this are rejected.

## Message Types

| Hex | Name | Purpose |
|---|---|---|
| 0x01 | HandshakeInit | Initiator -> Responder |
| 0x02 | HandshakeAck | Responder -> Initiator |
| 0x10 | Ping | Keepalive probe |
| 0x11 | Pong | Keepalive response |
| 0x20 | HttpRequest | Buyer -> Seller: proxy request |
| 0x21 | HttpResponse | Seller -> Buyer: complete response |
| 0x22 | HttpResponseChunk | Seller -> Buyer: streaming chunk |
| 0x23 | HttpResponseEnd | Seller -> Buyer: final chunk |
| 0x24 | HttpResponseError | Seller -> Buyer: error |
| 0xF0 | Disconnect | Graceful disconnect |
| 0xFF | Error | Protocol-level error |

## Handshake (Ed25519 Challenge-Response)

```text title="handshake flow"
Initiator                       Responder
  │                               │
  ├── HandshakeInit ─────────────>│
  │   (pubKey + nonce + sig)      │  128 bytes
  │                               │
  │<──── HandshakeAck ────────────┤
  │   (pubKey + nonce echo + sig) │  128 bytes
  │                               │
  │   Both sides: Authenticated   │
  └───────────────────────────────┘
```

Each side sends a 32-byte random nonce signed with its Ed25519 private key. The responder echoes the initiator's nonce to prove it received the challenge. Handshake timeout: 10 seconds.

## Keepalive

| Parameter | Value |
|---|---|
| Ping interval | 15 seconds |
| Pong timeout | 5 seconds |
| Max missed pongs | 3 (connection declared dead) |

## Reconnection

Exponential backoff with jitter: base delay 1s, max delay 30s, max 5 attempts. Formula: `min(baseDelay * 2^attempt + jitter, maxDelay)`. Because AI APIs are stateless, provider switches are invisible to the application.

## Payment Messages

Payment messages use the type range 0x50-0x5F. All payment payloads are JSON-encoded within the standard 9-byte binary frame.

| Hex | Name | Direction | Purpose |
|---|---|---|---|
| 0x50 | SpendingAuth | Buyer → Seller | EIP-712 signed spending authorization |
| 0x51 | AuthAck | Seller → Buyer | Seller confirms on-chain reserve() succeeded |
| 0x52 | SellerReceipt | Seller → Buyer | Seller reports usage/charge during or after serve |
| 0x53 | BuyerAck | Buyer → Seller | Buyer acknowledges receipt |
| 0x54 | TopUpRequest | Seller → Buyer | Seller requests additional spending authorization |
| 0x55 | PaymentRequired | Seller → Buyer | 402 trigger with payment terms |

## PaymentMux

Payment messages are multiplexed over the same WebRTC DataChannel as proxy traffic. The 9-byte frame header (`type`, `messageId`, `payloadLength`) is shared across all message types — proxy (0x20-0x24), keepalive (0x10-0x11), and payment (0x50-0x5F). No separate connection or out-of-band channel is required.

The `messageId` field links payment messages to their originating proxy request. For example, a SpendingAuth (0x50) triggered by a specific HttpResponse carrying a 402 status uses the same `messageId` as that proxy exchange, allowing the seller to correlate the authorization with the pending request.

## 402 Payment Negotiation

When a buyer sends a request to a seller with no active spending authorization, the seller responds with HTTP 402 and a PaymentRequired (0x55) message. Two negotiation modes handle what happens next.

### Auto Mode

The buyer node intercepts the 402 internally — it never reaches the application. The node checks the buyer's on-chain balance, signs a SpendingAuth (EIP-712), and sends it to the seller via PaymentMux. The seller verifies the signature, calls `reserve()` on-chain, and responds with AuthAck. The buyer then retries the original request.

```text title="auto mode flow"
Buyer                           Seller                          Chain
  │                               │                               │
  ├── HttpRequest (0x20) ────────>│                               │
  │                               │                               │
  │<── PaymentRequired (0x55) ────┤                               │
  │   (sellerEvmAddr, tokenRate,  │                               │
  │    firstSignCap, suggested)   │                               │
  │                               │                               │
  │   [check balance, sign]       │                               │
  │                               │                               │
  ├── SpendingAuth (0x50) ───────>│                               │
  │   (EIP-712 signature)        │                               │
  │                               ├── reserve() ─────────────────>│
  │                               │<── tx confirmed ──────────────┤
  │                               │                               │
  │<── AuthAck (0x51) ────────────┤                               │
  │                               │                               │
  ├── HttpRequest (0x20) ────────>│   [retry, serves normally]    │
  │<── HttpResponse (0x21) ───────┤                               │
  └───────────────────────────────┘                               │
```

During serving, SellerReceipt (0x52) and BuyerAck (0x53) messages flow alongside proxy traffic for bilateral accounting. When usage exceeds 80% of the authorized `maxAmount`, the seller sends a TopUpRequest (0x54) to request additional authorization before the current one is exhausted.

### Manual Mode

The 402 and PaymentRequired payload propagate to the application (e.g., the desktop app). The user sees an approval card with the seller's terms. On approval, the application signs the SpendingAuth and encodes it as base64 in the `x-antseed-spending-auth` HTTP header on the retry request. The buyer node extracts the header before proxying and sends the SpendingAuth via PaymentMux (0x50). From there, the on-chain flow is identical to auto mode.
