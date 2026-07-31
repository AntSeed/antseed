---
sidebar_position: 3
slug: /guides/verify-tee
title: Verify a Seller's TEE
hide_title: true
---

# Verify a Seller's TEE

Before routing a paid request to a seller, your buyer node can cryptographically verify that the seller runs inside a genuine Intel TDX enclave — checked locally on your machine, against Intel's own certificate chain, with no third party in between. This guide covers turning verification on, making it mandatory, and reading a verdict.

:::info Availability
Verifier SDK support landed in the CLI with [PR #713](https://github.com/AntSeed/antseed/pull/713) (July 2026). Check that your `antseed buyer start --help` lists `--verifiers`; older releases don't have it. No special hardware is needed on the buyer side.
:::

## The three flags

```bash
# Default (no flags): verification is ON, best-effort.
# Sellers that advertise a trusted verifier are checked; the verdict is
# logged, but requests route either way.
antseed buyer start

# Strict: refuse to route unless the seller passes verification.
antseed buyer start --verifiers antseed-verifier --require-verifier

# Off: skip verification entirely.
antseed buyer start --no-verifier
```

- `--verifiers <a,b,c>` — an ordered preference list of verifier ids. Without it, the buyer uses the seller's advertised default — if that id is in the curated trust set.
- `--require-verifier` — a failed **or missing** verification becomes a hard block: the request is answered with a `502` naming the failed claims instead of being routed. The peer is not silently swapped for another.
- `--no-verifier` — disables verification. Combining it with either other flag is rejected as contradictory.

The startup banner confirms the active policy, e.g. `Verifier: antseed-verifier (required)`.

## Finding TEE sellers

```bash
antseed network browse            # shows a "Verifier" column when peers advertise one
antseed network peer <peer-id>    # → Verifiers:       antseed-verifier (default)
```

Sellers advertise verifier support as capabilities (`verifier.<id>`) in ordinary discovery metadata — what you see there is *advertised support*, not a verdict. The verdict is produced by your own node at request time.

## What a passing verdict proves

With the [`antseed-verifier`](https://github.com/AntSeed/antseed-verifier) SDK, the verdict gates on two required capabilities:

| Capability | Proves |
|---|---|
| `seller-node-tee-genuine` | The seller node runs in a **genuine Intel TDX enclave**: quote verified against Intel's DCAP certificate chain, acceptable TCB, debug off — and minted fresh for *your* nonce, bound to the seller's peer id. Replayed quotes and non-TDX machines fail. |
| `seller-bound` | The seller's identity key signed the whole evidence bundle for this round — the enclave is tied to the exact peer you're paying, not borrowed from elsewhere. |

Four more capabilities are reported as evidence for your own policy but don't gate the verdict:

| Capability | Reports |
|---|---|
| `seller-provider-tee-genuine` | The downstream inference **provider's** TEE quote is genuine TDX, and round-bound when the provider declares a binding scheme |
| `seller-provider-gpu-cc` | The provider's GPUs run **NVIDIA Confidential Computing**, verified against NVIDIA's attestation service (NRAS), nonce-bound |
| `seller-provider-measured-image` | The provider quote's measurements (MRTD/RTMR) match an allow-list **you** control |
| `seller-provider-claims` | Named provider claims, each marked self-vouched or TEE-attested |

## Policy knobs

```bash
# Accept only TCB status "UpToDate" (default also accepts SWHardeningNeeded)
export ANTSEED_VERIFIER_STRICT_TCB=true

# Approved-measurement allow-list for seller-provider-measured-image
# (inline JSON or @/path/to/policy.json)
export ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY=@~/measured-images.json

# Override NVIDIA NRAS endpoints for gpu-cc
# export ANTSEED_VERIFIER_NRAS_URL=... ANTSEED_VERIFIER_NRAS_JWKS_URL=...
```

## What happens at request time

1. After a peer is selected and matched — and **before** any payment negotiation — the buyer challenges it on the reserved route `/_antseed/attest/<verifier-id>` over the existing encrypted connection. Attestation is free: it never passes through pricing or metering.
2. The verifier runs with a 30-second timeout, composed with your request's abort signal.
3. Verdicts are cached per `(peer, advertised-verifier-set)` for the peer-cache TTL (minutes), so attestation doesn't rerun on every request. Transient failures — network hiccups, timeouts — are never cached as negative verdicts.
4. On failure: in default mode the request routes anyway and the log shows `Verification (antseed-verifier) did not pass ... (optional — routing anyway)`; with `--require-verifier` the request fails with `502` and the failed claims, e.g. `seller-node-tee-genuine: report_data does not match scheme "antseed-rd-v1"`.

## The trust boundary

Your node only ever runs verifier code from a **curated, version-pinned trust set** — a built-in map from verifier id to an exact npm package and version (`antseed-verifier` → `@antseed/antseed-verifier`, pinned). The pinned version is enforced on every load; a version mismatch is an error, and there is no auto-upgrade to a floating "latest". A seller can advertise any id it likes — an id outside your trust set is simply never loaded or run. The trust decision is yours alone: which SDK to run, and whether its verdict gates routing.

## Limits worth knowing

- A passing verdict proves the enclave was genuine and fresh **at attestation time**, and the cached verdict covers the following minutes. Binding every response byte to an enclave-held signing key is the [next milestone](https://github.com/AntSeed/antseed-verifier/blob/main/docs/milestone-a2-channel-binding.md) in the verifier SDK.
- Attestation proves the *environment*, not the *model*. For whether the model is what the seller claims, see [model verification](/blog/model-verification-fingerprint-swarm).

:::note Three different "verifications"
AntSeed has three unrelated features that all involve the word "verify" — don't conflate them:
1. **Verifier SDKs** (this guide) — cryptographic TEE attestation of a seller, run by your node.
2. The **`Verified` column** in `network browse` — domain/GitHub ownership proofs a seller publishes about its identity.
3. **Model verification** — black-box fingerprint probing of the model behind a service.
:::

## See also

- [Run a TEE-attested seller](/docs/guides/tee-provider) — the seller side
- [AIP-3: Pluggable Verifier SDKs](https://github.com/AntSeed/AIPs/blob/main/AIPS/aip-3.md) — the protocol specification
- [Security](/docs/security) — the wider security model
