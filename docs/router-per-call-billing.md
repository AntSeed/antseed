# Structured routing billing

Routing services advertise `antseed-routing`, `routing: true`, and a signed routing
descriptor. Free and token-priced services use existing token pricing. Per-call services
advertise a per-call unit billing model under `antseed-routing` and zero token rates;
mixed per-call/token charges are rejected.

`POST /v1/route` uses normal authenticated service dispatch and payments, with attribution
`purpose: routing` and the parent inference request. Existing channel, reserve and
per-request policies apply. There is no separate routing wallet, grant, seller lock or
subscription mechanism.

Before dispatch the buyer validates metadata, preferences, schema hash, eligible candidates
and prices. The seller checks the schema contract before payment negotiation and invoking
provider logic. A per-call response is accepted only if it is successful and contains
exactly one eligible recommendation. Malformed or ineligible decisions are not accepted as
successful per-call results. The shared `acceptResponse` hook prevents authorizing that
result; it does not revoke earlier authorizations.

No automatic additional paid call follows a transport failure, rejected response or schema
mismatch. Identical attempts for one parent request share an operation. An eligible reused
conversation decision makes no routing call. Routing and inference can share a peer,
including concurrent traffic; payment updates remain serialized independently of requests.
A completed routing charge is distinct from subsequent inference, even if inference fails.

Build the affected packages and verify on an isolated local chain:

```bash
node e2e/scripts/local-chain-routing-flow.mjs --same-peer
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --per-call
node e2e/scripts/local-chain-routing-flow.mjs --per-call --invalid-route
node e2e/scripts/local-chain-routing-flow.mjs --same-peer --per-call --concurrent
```

These scenarios require Foundry (`anvil`, `forge`, `cast`) and do not use real funds.
