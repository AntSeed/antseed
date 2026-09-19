# Generic network router

`@antseed/router-classifier` is the generic network-routing adapter bundled with
the CLI. A provider exposes a compatible AntSeed routing service; buyers do not
need a vendor-specific plugin. The package is publishable with the CLI dependency
set, not part of the separate plugin auto-install/update catalog.

## Select a service

```sh
antseed config buyer set selection '{"kind":"router","service":{"peerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provider":"openai","serviceId":"model-selector"}}'
antseed buyer start
```

Replace the example peer ID. Use `model: "antseed"` or omit the model in requests.
Explicit model/peer pins still bypass classification. Selecting a remote service
means sharing the request body with it and allowing normal metered payment.

The host supplies eligible offers, instructions, conversation reuse hints, and
cancellation/deadline context. The adapter sends a version-1 selection payload
using host `invokeService`, which reuses AntSeed transport and payment machinery.
It returns the same `RouteRecommendation[]` as a local router. If the previous
selection remains eligible for a continuation, no classifier call is needed.

The service must advertise `routing: true` and `openai-chat-completions`. Its
response uses the normal chat-completions envelope. `choices[0].message.content`
is a JSON string containing exactly one of:

```json
{ "serviceId": "model-x" }
```

```json
{ "serviceId": "model-x", "peerId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
```

A model-only answer delegates seller selection to AntSeed. An exact answer must
match an eligible pair and does not silently fall back to another seller. The
host validates the recommendation independently and never falls back to a saved
model when classification fails.

## Provider compatibility

Build the package, then validate a response envelope against its candidate array:

```sh
pnpm --filter @antseed/router-classifier build
node plugins/router-classifier/scripts/check-compatibility.mjs \
  plugins/router-classifier/fixtures/candidates.json \
  plugins/router-classifier/fixtures/response.json
```

Replace the files with your service's actual candidates and response. This is an
offline response-contract check; it does not send paid requests. The exported
`parseClassificationResponse(response, candidates)` is also reusable in tests.

See `docs/router-network-integration.md` for the versioned request contract,
configuration, consent, payment limits, and retry semantics, and
`docs/router-per-call-billing.md` for fixed-fee acceptance. Token billing can
charge consumed tokens even if selection is invalid; per-call billing requires
an accepted selection first. Neither path makes downstream inference free.

Classification uses ordinary SDK seller requests and normal payment handling.
Multiple chats can classify concurrently, even while that same seller is streaming
inference. The host validates a fixed-fee response before payment; request IDs keep
each response's billing and parent-conversation attribution separate.
