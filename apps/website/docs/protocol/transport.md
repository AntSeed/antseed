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
