---
sidebar_position: 4
slug: /metering
title: Metering
hide_title: true
---

# Metering

Both sides independently verify what was delivered. Token usage is estimated from HTTP content lengths and stream byte totals. Sellers generate EIP-191 signed receipts (using their secp256k1 identity key) after each request. Buyers independently verify receipts via `ecrecover` and flag disputes when estimates diverge.

## Token Estimation

Provider-specific bytes-per-token ratios:

| Provider | Bytes/Token |
|---|---|
| anthropic | 4.2 |
| openai | 4.0 |
| google | 4.1 |
| default | 4.0 |

For SSE streams, a factor of `0.82` is applied to account for framing overhead. Minimum thresholds: 100 tokens for requests, 10 tokens for responses.

## Usage Receipts

```json title="receipt structure"
{
  "receiptId": "uuid-v4",
  "sessionId": "session-uuid",
  "eventId": "event-uuid",
  "timestamp": 1708272000000,
  "provider": "anthropic",
  "sellerPeerId": "a1b2...40 hex (EVM address)",
  "buyerPeerId": "c3d4...40 hex (EVM address)",
  "tokens": {
    "inputTokens": 1024,
    "outputTokens": 512,
    "totalTokens": 1536,
    "method": "content-length",
    "confidence": "high"
  },
  "unitPriceCentsPerThousandTokens": 300,
  "costCents": 5,
  "signature": "eip191...130 hex"
}
```

## Cost Calculation

`costCents = max(1, round(totalTokens / 1000 * unitPriceCentsPerThousandTokens))` — non-zero usage always costs at least 1 cent. Zero tokens = zero cost.

## Receipt Verification

Buyers verify the EIP-191 signature (recovering the seller's address via `ecrecover`) and compare token estimates. A dispute is flagged when the difference exceeds **15%** or the signature is invalid. If their measurements diverge significantly, the transaction is disputed and the buyer is protected.
