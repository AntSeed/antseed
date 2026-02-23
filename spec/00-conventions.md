# 00 - Conventions

This document defines the conventions and data formats used across all Antseed Network specification documents.

## PeerId

A **PeerId** is a 64-character lowercase hexadecimal string representing an Ed25519 public key.

- Length: 64 characters (32 bytes encoded as hex)
- Character set: `[0-9a-f]`
- Case: lowercase only
- Example: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`

Every node in the network is uniquely identified by its PeerId, which is derived from the node's Ed25519 public key.

## Timestamps

All timestamps in the protocol are expressed as **Unix milliseconds (UTC)**.

- Type: integer (64-bit)
- Unit: milliseconds since Unix epoch (1970-01-01T00:00:00Z)
- Timezone: always UTC
- Example: `1708272000000` represents 2024-02-18T16:00:00.000Z

Timestamps are used for message ordering, expiry checks, and metering intervals.

## Byte Encoding

All multi-byte integer values are encoded in **big-endian** (network byte order) unless explicitly stated otherwise in a specific section.

- Byte order: big-endian (most significant byte first)
- Exceptions: explicitly noted where they occur

## Token Units

Token counts are expressed as integers using the following field names:

| Field | Type | Description |
|---|---|---|
| `input_tokens` | integer | Number of tokens in the inference input/prompt |
| `output_tokens` | integer | Number of tokens in the inference output/completion |
| `total_tokens` | integer | Sum of input_tokens and output_tokens |

- All token counts are non-negative integers.
- `total_tokens` MUST equal `input_tokens + output_tokens`.

## Currency

Costs and prices use the following conventions:

| Context | Unit | Type | Description |
|---|---|---|---|
| Costs | USD cents | integer | Used for metered costs and payment amounts |
| Prices | USD | float | `inputUsdPerMillion` / `outputUsdPerMillion` = USD per 1,000,000 tokens |

- **Costs** are expressed in **USD cents** (integer). Example: `150` means $1.50 USD.
- **Prices** are expressed in **USD per 1M tokens**.
  - Example: `inputUsdPerMillion = 3` means $3.00 USD per 1,000,000 input tokens.
  - Example: `outputUsdPerMillion = 15` means $15.00 USD per 1,000,000 output tokens.

## Signature Format

All Ed25519 signatures in the protocol are represented as **128-character lowercase hexadecimal strings** (64 bytes encoded as hex).

- Length: 128 characters (64 bytes encoded as hex)
- Character set: `[0-9a-f]`
- Case: lowercase only
- Algorithm: Ed25519
- Example: `a1b2c3d4...` (128 hex characters total)

Signatures are used for message authentication, usage attestation, and payment authorization. The signed payload and signing context are defined in each relevant specification document.
