# Chutes

Start the seller with `--verifiers antseed-verifier`. The Chutes adapter runs in-process. There
is no separate shim. Select it with `ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes`.

## Provider config

```bash
export ANTSEED_VERIFIER_PROVIDER_ADAPTER=chutes
export CHUTES_API_KEY=<chutes api key>
export CHUTES_CHUTE=<chute id>
# export CHUTES_API_BASE=https://api.chutes.ai   # override if needed
```

The adapter adds the Bearer auth. It picks an instance from the Chutes evidence array. It binds
the quote with `nonce-pubkey-sha256-v1`. If GPU CC evidence is present, the adapter verifies it
against the scheme's derived NRAS nonce automatically.

## Chutes provider

Identity + provider config, no node quote:

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
# + provider config above
```

Buyers must require the provider capability:

```bash
export ANTSEED_VERIFIER_REQUIRED_CAPS='seller-provider-tee-genuine,seller-bound'
```

## Seller node on Chutes CPU + Chutes provider

Add the node TEE source (match the CVM):

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
export ANTSEED_VERIFIER_NODE_TEE=configfs   # or dstack (see PHALA.md)
# + provider config above
```

Buyers attest with `--require-verifier` (default required capabilities).
