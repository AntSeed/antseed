# Fixed-price routing acceptance

Per-call pricing is a billing model over existing AntSeed payment channels, not a
new funding method. It adds no contract, storage migration, refund protocol, or
automatic paid retry.

## Advertise and select

A routing service advertises `routing: true`, `openai-chat-completions`, zero token
prices (including cached input), and a protocol-specific model generated with
`createPerCallBillingModel(amountMicroUsdc)`. The shared billable unit is
`successful_requests`. For example, `createPerCallBillingModel('5000')` describes
one 5,000-micro-USDC fee. Nonzero token prices cannot be combined with this fee.

The buyer selects the same service target used for token-priced routing:

```json
{
  "buyer": {
    "selection": {
      "kind": "router",
      "service": {
        "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "provider": "openai",
        "serviceId": "model-selector"
      }
    }
  }
}
```

Merge this into the normal config and replace the example peer ID. The host reads
billing from advertised metadata, not another buyer billing-mode setting. The
fee must fit the existing `payments.maxPerRequestUsdc` policy, and normal funding
and reserve checks still apply. No classifier-specific aggregate budget or price
ceiling is required. The token path retains ordinary exposure semantics, not an
implicit hard total-operation cap.

## Accept before authorizing

Exactly one fixed fee is authorized only after:

1. The full non-streaming classifier response is HTTP 2xx.
2. The parser produces a nonempty list of valid recommendations.
3. Each exact recommendation matches an eligible model/peer pair, and each
   model-only recommendation has an eligible seller in the host's snapshot.

The generic adapter uses the version-1 contract in `router-network-integration.md`:
`choices[0].message.content` is JSON with exactly `serviceId` and optional `peerId`.
Its exported `parseClassificationResponse` is passed to `context.invokeService`
and reused for the final returned decision. It throws on malformed content; it
does not invent a fallback. Host validation uses a separate candidate snapshot
that cannot be expanded by mutating the plugin's copy.

A later inference failure does not refund a valid classification. Rechecking
current eligibility before inference is separate from acceptance of the original
classifier response. Reuse without calling the service incurs no classifier fee.
Token-priced invalid responses may still incur token charges; fixed-fee invalid
responses never count as a successful classification.

## Recovery and concurrency

Classification uses an independent request ID linked to the inference request.
Repeated invocation within one routing operation shares its result, including
failures. Payment recovery replays the same cumulative authorization and does
not prepay a new fee. Seller replay checks and buyer counted-request accounting
prevent the supported recovery paths from counting another successful request.
Do not mistake this for universal exactly-once billing across a process restart
or a new client request.

A peer may offer both classification and inference. Both use ordinary SDK
requests and may run concurrently, including classification while an inference
stream is open. Each request retains its own billing identity, advertised prices,
observed usage, cancellation signal, and optional accounting attribution.
Completing one response cannot overwrite another response's pending payment.

Only shared channel read/sign/persist updates are serialized. Response delivery,
unit-usage observation, reserve balance RPCs, and acknowledgement waits do not
hold that update queue. Buyer post-response signing and seller authorization
requests deduplicate the same delivered request. Cancellation applies to that
request, not to other requests using the seller. Already signed payments cannot
be undone by a later cancellation.

If a response reaches the current reserve ceiling, accounting retains its unpaid
remainder. The normal payment path can top up the reserve and authorize that
remainder without reissuing the service request or counting its usage twice.

The host supplies a generic `acceptResponse` callback for fixed-fee classification.
Only an accepted answer becomes billable. `attribution: { purpose: 'routing',
parentRequestId }` labels accounting; it does not grant payment permissions.
There is no classifier-specific SDK authorization or peer request gate.

## Existing shared billing

Unit-billing helpers measure normalized request attributes and unit limits.
`computeFinalUnitBilling` uses the advertised model, billing context, and observed
response. Image format parsing remains at the adapter boundary. Existing image
prices and token cost computation are unchanged. Discovery must not drop a
nonzero per-call fee during a metadata downgrade.

## Tests

Build affected packages, initialize the contract dependencies, and run:

```sh
node e2e/scripts/local-chain-routing-flow.mjs --per-call
node e2e/scripts/local-chain-routing-flow.mjs --per-call --invalid-route
node e2e/scripts/local-chain-routing-flow.mjs --per-call --concurrent
node e2e/scripts/local-chain-routing-flow.mjs --per-call --concurrent --same-peer
```

These use isolated Anvil and throwaway local funds. SDK tests additionally cover
fee validation, zero/prepaid recovery, cancellation, authorization races, and
mixed classification/inference accounting on one seller channel.
