# Structured routing provider

`src/index.ts` exports a free, deterministic provider plugin. Its advertised `position`
preference selects the first or last eligible candidate. The buyer does not hardcode that
field. Copy into a provider package with `@antseed/node`, compile as ESM TypeScript and
load its default export through the normal provider-plugin workflow.

The response contains a ranked `recommendations` array. This minimal provider returns one
entry; the compatibility fixtures demonstrate an exact seller followed by a different,
model-only choice. Every entry must refer to an eligible candidate. Rank is preserved by
the pure response parser; executing ranked fallback belongs to the buyer integration.

A recommendation can include `inference: { reasoningEffort: "high" }`. An explicit
`reasoningEfforts` list restricts accepted values; missing capability metadata allows a
best-effort choice without guaranteeing backend support. Inference
service capability advertisements carrying this list use the same signed metadata v14
extension as routing descriptors.
For model-only recommendations, at least one eligible seller must permit the effort.
The fixtures demonstrate an explicit effort followed by a choice without an override.
Applying these settings and retaining them across continuations belongs to the later
buyer integration, not this protocol example.

Requests may also include `context.usageObservations`: a bounded snapshot of reported
inference input/cache counts for eligible offers in the current conversation. Missing
cache counts mean unknown, not zero. The reference provider validates this context but
does not need it for first/last selection. A cache-aware provider can use the observations
without adding service-specific buyer code. IDs are router-scoped; deduplicate them if
maintaining server-side history, and honor `historyTruncated` and new conversation
references. No additional reporting endpoint or buyer preference is required.

Build protocol, node and router-core, then check the fixtures without contacting a service:

```bash
node docs/protocol/templates/routing-provider/check-compatibility.mjs
```

For captured data, pass descriptor, request and response JSON file paths in that order.
The checker never sends a paid request. See `docs/protocol/routing.md` for the wire
contract, schema subset, version compatibility, and implementation scope.
