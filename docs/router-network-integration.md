# Network model routing and classifier billing

## Scope and history

This change combines generic router integration and classifier billing in one
network-only PR. It builds on the original Levanto commits with additive cleanup
commits rather than squashing or rewriting their history. The complete previous
implementation remains on `codex/levanto-p1-local`; the narrowed branch is
`codex/router-network-integration`.

Included:

- Optional model-and-peer selection in buyer router plugins, alongside the
  existing `selectPeer` interface.
- Plugin-owned settings, explicit activation, eligible candidates, host-enforced
  deadlines, cancellation, and fail-closed fallback.
- Initial-model selection and persistence, concurrent-first-request coordination,
  explicit user pins, and same-model peer failover.
- Host-mediated classifier requests with token or fixed-per-call prices,
  separate authorization budgets and accounting, and validation before
  per-call payment.
- Discovery, payment recovery, migration, contract, and local-chain tests.

Not included: desktop/VPR changes, plugin bundling or catalog endorsement,
Levanto-specific endpoints or authentication, access/day passes, daily spending
controls, savings dashboards, reference prices, forecast history, universal
cost/quality controls, and mid-conversation reclassification.

The existing conversation store only distinguishes a real user pin from the
model last selected by the host. No new per-turn cost/latency fields are added.
Token counting and ordinary seller settlement behavior are unchanged.

## Router contract

An installed router plugin declares `autoRouteServiceId` and optionally
`routingSettingsSchema`. The buyer loads it using the existing `buyer start
--router <plugin>` or `--instance <instance>` flow. Nothing special is registered
for a particular vendor. A paid classifier is a normal advertised provider
service using `/v1/chat/completions`, not a custom routing-server endpoint.

`selectRoute(request, peers, conversation, preferences, defaultRoute, context)`
returns ordered `{ peerId, serviceId }` recommendations. Only those two fields
are necessary: the host reconstructs requests, peers, and prices from its own
discovery data. A prediction, token estimate, quality score, or cost forecast
is never required.

The context supplies namespaced settings, an eligible candidate snapshot,
`signal`, `deadlineMs`, and `invokeService(messages, parseResponse)`. Its trigger
identifies a new conversation or a request without a usable conversation ID;
it does not ask the plugin to implement turn detection.

Candidate prices include input, output, and cached-input rates. An unknown
cached-input rate is `null`, not a fabricated zero or a token forecast.
Fixed-per-call services are not eligible as token-priced inference candidates;
their fee requires the separate classifier authorization described below.

- `null`: decline; continue through ordinary fixed-model routing.
- `[]`: claimed request with no route; fail closed.
- Throw or timeout: fail closed unless the buyer explicitly configured a default
  fallback. That fallback still passes host policy checks.
- Late results after cancellation cannot cause inference dispatch.

The buyer must explicitly set `buyer.routingPreferences.routerEnabled: true`
and request the plugin's sentinel model. Unknown model names do not trigger
classification. Concrete advertised models and explicit pins bypass it.
The sentinel must not collide with an advertised inference model.

After the first valid selection the host persists the model before dispatching
inference. Later turns, rewritten context, and refresh headers reuse that model;
they do not buy another classification. Same-model peer failover remains possible
unless the user pinned a particular seller. With no stable conversation identity,
each incoming request is a separate classification opportunity. This is not a
cross-client idempotency guarantee.

Reused models still pass current host price and trust checks. If a price rises
above the buyer's ceiling, another eligible peer for the same model may serve
the request. If none remains, the host fails without buying a new classification.

## Configuration example

This is a fragment to merge into a normal buyer configuration, not a complete
configuration file. Replace the plugin key and classifier identity with the
installed plugin and an actual advertised seller. The settings vocabulary
belongs to that plugin, not to AntSeed.

```json
{
  "buyer": {
    "routerTimeoutMs": 10000,
    "routerFailureFallback": "none",
    "routingPreferences": {
      "routerEnabled": true,
      "routerSettings": {
        "plugin:example-router": { "policy": "balanced" }
      }
    },
    "routingService": {
      "routerKey": "plugin:example-router",
      "peerId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "provider": "openai",
      "serviceId": "classifier",
      "allowPromptSharing": true,
      "billing": { "kind": "per_call", "maxAmountMicroUsdc": "5000" },
      "maxAdditionalAuthorizationUsdc": "5000",
      "maxRequestsPerMinute": 10,
      "maxInputBytes": 8192,
      "maxOutputTokens": 128
    }
  }
}
```

Use `instance:<name>` for named plugin instances. Direct `--router` keys use the
exact configured router argument. The host only passes that key's settings to
the plugin, validates them against its schema, and keeps buyer policy separate.

For token billing, set `billing.kind` to `token` and provide all three rate caps:
`maxInputUsdPerMillion`, `maxOutputUsdPerMillion`, and
`maxCachedInputUsdPerMillion`. `maxAdditionalAuthorizationUsdc` bounds additional
signed spending for one classifier operation, not the channel's reserved
collateral and not a daily spending allowance.

## Payment and operational boundaries

### CLI configuration

Optional routing fields can be initialized through either `config set buyer.<key>`
or `config buyer set <key>`. For example:

```sh
antseed config buyer set routingPreferences.routerSettings '{"plugin:example-router":{"policy":"balanced"}}'
antseed config buyer set routerTimeoutMs 10000
antseed config buyer set routerFailureFallback none
antseed config buyer set routingPreferences.routerEnabled true
```

Set `routingService` as one complete JSON object using the configuration example
above. Partial service configurations fail validation and are not saved. Once
configured, individual fields can be updated, for example:

```sh
antseed config buyer set routingService.billing.maxAmountMicroUsdc 6000
antseed config buyer set routingService.maxAdditionalAuthorizationUsdc 6000
antseed config buyer set routingPreferences.routerEnabled false
```

The first two commands apply to the per-call example. Payment amounts remain
integer strings in the configuration; booleans remain booleans. Router-owned
settings remain strings and should be supplied as a complete namespaced JSON
object, including when package names contain dots. Invalid edits leave the
previous configuration intact. These commands do not install a plugin or start
a buyer; they configure the existing `buyer start --router` flow.

### Billing semantics

The buyer opts into sharing classifier input with the configured seller. Input,
output-token, request-rate, and authorization limits are checked by the host.
The classifier peer is kept separate from inference peers to prevent ordinary
inference requests from using its scoped payment authority.

Fixed-per-call payment requires a complete HTTP 2xx response, a successful
plugin parser, and only eligible exact model/peer recommendations. Invalid
output, HTTP errors, timeout, cancellation, and route reuse authorize no new
fixed fee. Token-priced services charge verified usage; they do not promise a
free classification when a plugin rejects the content. See
`router-per-call-billing.md` for the parser contract and failure cases.

Bounded local `routing-operations.jsonl` diagnostics record IDs, selection
outcomes, latency, and authorization events, without prompt bodies or settings.
They are not a savings database or the payment ledger. Cumulative authorizations
remain in the payment channel store. Migration 006 persists reserve-recovery
fields; migrations 001–005 are unchanged. No access-purchase or routing-history
schema is shipped. Metadata preserves existing image-unit encoding and rejects
downgrades that would omit unit fees.

Duplicate `invokeService` calls reuse one in-process operation for a parent
request. Restarting during an unfinished classification is not durable
exactly-once processing; a later client retry can be a new billable request.
Completed conversation model selections survive restart. Invalid-response debt
is not paid merely to unblock a seller; that seller can consequently refuse
future service. No refund or automatic paid retry workflow is added.

Only one routing authorization can be active for a seller at a time. Overlapping
classifications for different conversations can fail closed; there is no paid
retry queue. Installed plugins are trusted in-process code, not a security
sandbox: host validation constrains this routing/payment API, not arbitrary
filesystem access by installed code.

## Verification

Run builds before tests so dependent packages use current declarations:

```sh
pnpm run build:tier0
pnpm --filter @antseed/ant-agent build
pnpm --filter @antseed/cli test
pnpm --filter @antseed/node test
pnpm --filter @antseed/buyer-core test
pnpm --filter @antseed/e2e run flow:local-chain-routing
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call
pnpm --filter @antseed/e2e run flow:local-chain-routing --per-call --invalid-route
```

The chain fixtures use isolated local Anvil development wallets, not production
funds. They cover inference reuse, valid/invalid classifications, cancellation
and catch-up refusal, and actual settlement. Unit tests additionally cover
policy enforcement, schema validation, deadlines, discovery compatibility,
response isolation, authorization races, and migration from the v5 schema.

Use the repository's pinned Node 24 runtime. When changing Node versions in an
existing worktree, rebuild native SQLite bindings for the new runtime before
running the tests.

Before release: review the diff against current `origin/main`, run the suite on
that integrated tree, and perform the normal package-version/release process.
This PR does not activate a production router or validate a private vendor's
seller. A later desktop or access-billing PR must be reviewed separately.

### Local validation — September 16, 2026

Validated after merging `origin/main` at `f2ee484a9`, using Node 24.21.0:

| Check | Result |
| --- | --- |
| Dependency-tier builds and CLI build | Passed |
| SDK tests | 1,156 passed |
| CLI tests | 599 passed |
| Buyer-core tests | 11 passed |
| Browser SDK tests | 26 passed |
| Workspace typechecks | Passed |
| Unchanged desktop main and renderer typechecks | Passed |
| Local-chain token classifier | Passed; 140 micro-USDC settled |
| Local-chain fixed-fee classifier, malformed-response rejection | Passed; 10,000 micro-USDC settled for two accepted classifications |
| Local-chain fixed-fee classifier, unadvertised-route rejection | Passed; 10,000 micro-USDC settled for two accepted classifications |

The branch retains all commits from `codex/levanto-p1-local`. The final diff
against the integrated main contains no desktop, Payments UI, or vendor-plugin
files. No package publication, push, PR creation, or production deployment is
part of this local validation.
