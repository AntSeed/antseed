---
sidebar_position: 7
slug: /security
title: Security
hide_title: true
---

# Security

This page summarizes the buyer-seller security model in `@antseed/node`: discovery trust boundaries, P2P transport controls, metering/payment integrity, and known residual risks.

## Security Model

AntSeed assumes an untrusted network. Security is built by combining:

- Signed peer identity and metadata (Ed25519)
- Authenticated connection intro envelopes with replay protection
- Bounded framing/stream/upload limits for DoS resistance
- Signed bilateral receipts plus on-chain escrow settlement

## Buyer -> Seller Flow Controls

| Flow Stage | Main Risks | Current Controls |
|---|---|---|
| Discovery | Topic fragmentation, stale/forged metadata, DHT poisoning | Lowercased topic normalization + compact model search topics, signature verification, staleness checks, private IP filtering by default |
| Connection setup | Peer spoofing, replay, handshake flooding | Signed intro/hello auth envelope, nonce replay guard, timestamp skew checks, initial-line size/time limits, per-IP connection cap |
| P2P transport | Malformed frames, oversized payloads, stalled streams | Frame type/size validation (`64 MiB` max payload), connection fail-closed on decode errors, request/stream timeouts |
| Proxy upload/stream | Memory pressure and slow-loris uploads | Per-request upload cap, global pending upload cap, upload timeout, abort with 413/408, stream buffer/duration limits |
| Metering + payment | Unpaid work, forged settlement data, buyer ghosting | 402 gating when lock not committed, Ed25519 receipt/ack trail, ECDSA lock/top-up/settlement auth, dispute path on disconnect |

## Key Limits (Defaults)

- `requestTimeoutMs`: `30_000`
- `maxStreamBufferBytes`: `16 MiB`
- `maxStreamDurationMs`: `5 minutes`
- `ProxyMux` per-upload cap: `32 MiB`
- `ProxyMux` total pending upload cap: `256 MiB`
- `ProxyMux` upload timeout: `120_000 ms`
- metadata fetch timeout: `2_000 ms`

## Known Gaps

1. TCP fallback is authenticated but not encrypted end-to-end.
2. Metadata resolution currently uses plain HTTP transport.
3. Metadata schema validation helpers exist, but lookup path primarily enforces signature + freshness.
4. Session maps are keyed by peer ID, so parallel sessions per counterparty are constrained.
5. Metering is byte-estimate based, not provider-native token attestation.

## Operator Hardening Checklist

1. Keep `allowPrivateIPs=false` outside local testing.
2. Keep signature verification enabled and stale metadata rejected.
3. Use stricter time/size caps for internet-facing providers if workloads are predictable.
4. Prefer WebRTC transport and monitor fallback usage.
5. Use dedicated escrow wallets and monitor dispute/settlement events.
6. Add ABI compatibility tests between escrow client and deployed contract before releases.
